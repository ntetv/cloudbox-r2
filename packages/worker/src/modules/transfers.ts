import { decodeObjectKey } from "../foundation/key-codec";
import { isPublicObjectKey } from "../foundation/public-access";
import {
	findAccessLock,
	publicAccessBucket,
} from "../foundation/public-access-lock";
import { serveR2Object } from "../foundation/range";
import {
	TRANSFER_TTL_SECONDS,
	hasSameOrigin,
	verifyAdminSession,
	verifyAdminTransferSession,
} from "../foundation/session";
import {
	activateTransfer,
	cleanupTransfers,
	findTransfer,
	listTransfers,
	removeTransfer,
	reserveTransfer,
} from "../foundation/transfer-registry";
import {
	TransferStoreError,
	cancelTransfer,
	checkpointTransferPart,
	claimCompleteTransfer,
	completeTransfer,
	rebindTransfer,
	stageTransfer,
	transferState,
} from "../foundation/transfer-store";
import type { TransferState } from "../foundation/transfer-store";
import {
	createTransfer,
	createTransferToken,
	isTransferToken,
	rotateTransferToken,
	transferStoreName,
	transferStub,
} from "../foundation/transfer-token";
import type { AppContext } from "../types";

const TRANSFER_PREFIX = "/_cloudbox-r2-transfer";
export const DIRECT_UPLOAD_MAX_BYTES = 95 * 1024 * 1024;
const MIN_PART_SIZE = 16 * 1024 * 1024;
const MAX_PARTS = 9_500;
const MAX_R2_PART_SIZE = 5 * 1024 * 1024 * 1024;
const MARKER = "cloudbox-r2-operation";
const GENERATION_MARKER = "cloudbox-r2-generation";

function noStoreHeaders() {
	return {
		"Cache-Control": "no-store, max-age=0",
		"Referrer-Policy": "no-referrer",
	};
}

function transferUrl(c: AppContext, token: string, suffix: string) {
	return `${new URL(c.req.url).origin}${TRANSFER_PREFIX}/${token}/${suffix}`;
}

function responseError(error: unknown, fallback = "Transfer unavailable") {
	if (error instanceof TransferStoreError)
		return Response.json({ message: error.message }, { status: error.status });
	return Response.json(
		{ message: fallback },
		{ status: 503, headers: noStoreHeaders() },
	);
}

async function requestJson(c: AppContext) {
	try {
		const body = await c.req.json();
		if (!body || typeof body !== "object" || Array.isArray(body)) return null;
		return body as Record<string, unknown>;
	} catch {
		return null;
	}
}

function decodeKey(value: unknown) {
	if (typeof value !== "string") return null;
	try {
		return decodeObjectKey(value);
	} catch {
		return null;
	}
}

function markerFor(state: TransferState) {
	return state.operationId || state.registryStoreName || "unknown";
}

function markerMetadata(state: TransferState) {
	return {
		[MARKER]: markerFor(state),
		[GENERATION_MARKER]: String(state.generation),
	};
}

function partCount(state: TransferState) {
	if (!state.size || !state.partSize) return 0;
	return Math.ceil(state.size / state.partSize);
}

function validateParts(state: TransferState) {
	if (!state.size || !state.partSize || !state.parts)
		throw new TransferStoreError("Missing upload parts", 409);
	const total = partCount(state);
	const parts = Object.values(state.parts).sort(
		(left, right) => left.partNumber - right.partNumber,
	);
	if (!total || total > MAX_PARTS || parts.length !== total)
		throw new TransferStoreError("Missing upload parts", 409);
	let confirmedBytes = 0;
	for (const [index, part] of parts.entries()) {
		if (part.partNumber !== index + 1)
			throw new TransferStoreError("Missing upload parts", 409);
		const expectedSize =
			part.partNumber === total
				? state.size - state.partSize * (total - 1)
				: state.partSize;
		if (part.size !== expectedSize || part.size <= 0)
			throw new TransferStoreError("Invalid upload part size", 409);
		confirmedBytes += part.size;
	}
	if (confirmedBytes !== state.size)
		throw new TransferStoreError("Invalid upload size", 409);
	return parts;
}

async function adminAuthorized(c: AppContext, state: TransferState) {
	if (
		state.owner !== "admin" ||
		!state.ownerSessionId ||
		!state.ownerRetentionUntil
	)
		return false;
	return verifyAdminTransferSession(
		c.env,
		state.ownerSessionId,
		state.ownerRetentionUntil,
	);
}

async function requireCurrentAdmin(
	c: AppContext,
	state: TransferState,
	mutation = true,
) {
	if (mutation && !hasSameOrigin(c.req.raw))
		throw new TransferStoreError("Invalid request origin", 403);
	const session = await verifyAdminSession(c.req.raw, c.env);
	if (!session || session.sessionId !== state.ownerSessionId)
		throw new TransferStoreError("Transfer unauthorized", 401);
	return session;
}

async function publicAuthorized(c: AppContext, state: TransferState) {
	const context = publicAccessBucket(c.env, c.get("config"));
	if (!context || !isPublicObjectKey(state.key, context.config.prefix || ""))
		return false;
	const lock = await findAccessLock(context.bucket, state.key);
	if (!state.publicTarget) return !lock;
	return Boolean(
		lock &&
			lock.metadata.target === state.publicTarget &&
			lock.metadata.authVersion === state.publicAuthVersion,
	);
}

async function authorizedState(
	c: AppContext,
	token: string,
	allowTerminal = false,
) {
	if (!isTransferToken(token))
		throw new TransferStoreError("Transfer not found", 404);
	const stub = await transferStub(c.env, token);
	const state = await transferState(stub);
	if (
		state.kind === "upload" &&
		state.tokenHash &&
		state.tokenHash !== (await transferStoreName(c.env, token))
	)
		throw new TransferStoreError("Transfer not found", 404);
	const authorized =
		state.owner === "admin"
			? await adminAuthorized(c, state)
			: await publicAuthorized(c, state);
	if (!authorized) throw new TransferStoreError("Transfer unauthorized", 401);
	if (
		!allowTerminal &&
		["expired", "cancelled", "conflict", "failed"].includes(state.status)
	)
		throw new TransferStoreError("Transfer unavailable", 410);
	return { stub, state };
}

function registryStatus(state: TransferState) {
	if (
		state.status === "completed" ||
		state.status === "cancelled" ||
		state.status === "expired" ||
		state.status === "conflict" ||
		state.status === "failed"
	)
		return state.status;
	return "failed" as const;
}

async function markRegistryTerminal(c: AppContext, state: TransferState) {
	if (!state.registryStoreName) return;
	await removeTransfer(c.env, state.registryStoreName, registryStatus(state));
}

async function cleanupUploadResources(c: AppContext, state: TransferState) {
	const bucket = c.env[state.bucket] as R2Bucket | undefined;
	if (!bucket) return;
	if (state.uploadId) {
		const multipartKey = state.key;
		if (multipartKey)
			try {
				await bucket
					.resumeMultipartUpload(multipartKey, state.uploadId)
					.abort();
			} catch {
				// R2 cleanup is best effort; alarm/lifecycle remains the fallback.
			}
	}
	if (state.stagingKey) {
		try {
			await bucket.delete(state.stagingKey);
		} catch {
			// Cache cleanup can retry staging deletion.
		}
	}
}

export async function createDownloadTransfer(c: AppContext) {
	const body = await requestJson(c);
	const bucketName = typeof body?.bucket === "string" ? body.bucket : null;
	const key = decodeKey(body?.key);
	const sessionId = c.get("authentication_session_id");
	const sessionExpiresAt = c.get("authentication_session_expires_at");
	if (!bucketName || !key || !sessionId || !sessionExpiresAt)
		return Response.json(
			{ message: "Invalid transfer request" },
			{ status: 400 },
		);

	const bucket = c.env[bucketName] as R2Bucket | undefined;
	if (!bucket)
		return Response.json(
			{ message: "Bucket binding not found" },
			{ status: 500 },
		);
	const object = await bucket.head(key);
	if (!object)
		return Response.json({ message: "Object not found" }, { status: 404 });

	try {
		const transfer = await createTransfer(c.env, {
			kind: "download",
			owner: "admin",
			ownerSessionId: sessionId,
			ownerRetentionUntil: sessionExpiresAt + TRANSFER_TTL_SECONDS * 1000,
			bucket: bucketName,
			key,
			expectedEtag: object.httpEtag,
			size: object.size,
			generation: 0,
		});
		return Response.json(
			{
				url: transferUrl(c, transfer.token, "download"),
				expiresAt: transfer.expiresAt,
				size: object.size,
				etag: object.httpEtag,
			},
			{ headers: noStoreHeaders() },
		);
	} catch {
		return Response.json(
			{ message: "Transfer unavailable" },
			{ status: 503, headers: noStoreHeaders() },
		);
	}
}

function calculatePartSize(size: number) {
	const minimum = Math.ceil(size / MAX_PARTS / (1024 * 1024)) * 1024 * 1024;
	return Math.min(MAX_R2_PART_SIZE, Math.max(MIN_PART_SIZE, minimum));
}

export async function createUploadTransfer(c: AppContext) {
	const body = await requestJson(c);
	const bucketName = typeof body?.bucket === "string" ? body.bucket : null;
	const key = decodeKey(body?.key);
	const size = typeof body?.size === "number" ? body.size : Number.NaN;
	const contentType =
		typeof body?.contentType === "string" ? body.contentType : undefined;
	const fileName =
		typeof body?.fileName === "string" ? body.fileName : undefined;
	const lastModified =
		typeof body?.lastModified === "number" ? body.lastModified : undefined;
	const sha256 = typeof body?.sha256 === "string" ? body.sha256 : undefined;
	const sessionId = c.get("authentication_session_id");
	const sessionExpiresAt = c.get("authentication_session_expires_at");
	if (
		!bucketName ||
		!key ||
		!Number.isSafeInteger(size) ||
		size < 0 ||
		!sessionId ||
		!sessionExpiresAt
	)
		return Response.json(
			{ message: "Invalid transfer request" },
			{ status: 400 },
		);

	const bucket = c.env[bucketName] as R2Bucket | undefined;
	if (!bucket)
		return Response.json(
			{ message: "Bucket binding not found" },
			{ status: 500 },
		);
	if (key.startsWith(".cloudbox-r2/"))
		return Response.json(
			{ message: "Invalid upload destination" },
			{ status: 400 },
		);

	const token = createTransferToken();
	const storeName = await transferStoreName(c.env, token);
	const createdAt = Date.now();
	const expiresAt = createdAt + TRANSFER_TTL_SECONDS * 1000;
	const uploadMode =
		size <= DIRECT_UPLOAD_MAX_BYTES
			? ("single" as const)
			: ("multipart" as const);
	const operationId = crypto.randomUUID();
	const partSize =
		uploadMode === "multipart" ? calculatePartSize(size) : undefined;
	const stagingKey =
		uploadMode === "single"
			? `.cloudbox-r2/staging/${crypto.randomUUID()}`
			: undefined;
	const record = {
		storeName,
		tokenHash: storeName,
		bucket: bucketName,
		key,
		size,
		fileName,
		lastModified,
		sha256,
		partSize,
		createdAt,
		expiresAt,
		status: "reserved" as const,
	};
	let upload: R2MultipartUpload | undefined;
	try {
		await reserveTransfer(c.env, record);
		if (await bucket.head(key)) {
			await removeTransfer(c.env, storeName, "conflict");
			return Response.json(
				{ message: "Object already exists" },
				{ status: 409 },
			);
		}
		if (uploadMode === "multipart") {
			upload = await bucket.createMultipartUpload(key, {
				customMetadata: {
					...markerMetadata({ operationId, generation: 0 } as TransferState),
				},
				httpMetadata: contentType ? { contentType } : undefined,
			});
		}
		const transfer = await createTransfer(
			c.env,
			{
				kind: "upload",
				owner: "admin",
				ownerSessionId: sessionId,
				ownerRetentionUntil: sessionExpiresAt + TRANSFER_TTL_SECONDS * 1000,
				bucket: bucketName,
				key,
				size,
				operationId,
				generation: 0,
				registryStoreName: storeName,
				uploadMode,
				stagingKey,
				uploadId: upload?.uploadId,
				partSize,
				contentType,
				fileName,
				lastModified,
				sha256,
				parts: {},
			},
			token,
		);
		await activateTransfer(c.env, storeName, {
			...record,
			createdAt: transfer.state.createdAt,
			expiresAt: transfer.expiresAt,
			status: "active",
		});
		return Response.json(
			{
				token: transfer.token,
				statusUrl: transferUrl(c, transfer.token, "upload"),
				bodyUrl: transferUrl(c, transfer.token, "upload/body"),
				mode: uploadMode,
				partSize,
				expiresAt: transfer.expiresAt,
				generation: transfer.state.generation,
			},
			{ headers: noStoreHeaders() },
		);
	} catch {
		try {
			await upload?.abort();
		} catch {
			// Best-effort cleanup.
		}
		if (stagingKey) {
			try {
				await bucket.delete(stagingKey);
			} catch {
				// Best-effort cleanup.
			}
		}
		try {
			await removeTransfer(c.env, storeName, "failed");
		} catch {
			// Best-effort cleanup.
		}
		return Response.json(
			{ message: "Transfer unavailable" },
			{ status: 503, headers: noStoreHeaders() },
		);
	}
}

export async function resumeUploadTransfer(c: AppContext) {
	const body = await requestJson(c);
	const bucket = typeof body?.bucket === "string" ? body.bucket : null;
	const key = decodeKey(body?.key);
	const size = typeof body?.size === "number" ? body.size : Number.NaN;
	const fileName = typeof body?.fileName === "string" ? body.fileName : null;
	const lastModified =
		typeof body?.lastModified === "number" ? body.lastModified : null;
	const sha256 = typeof body?.sha256 === "string" ? body.sha256 : null;
	const sessionId = c.get("authentication_session_id");
	const sessionExpiresAt = c.get("authentication_session_expires_at");
	if (
		!bucket ||
		!key ||
		!Number.isSafeInteger(size) ||
		!fileName ||
		lastModified === null ||
		!sha256 ||
		!sessionId ||
		!sessionExpiresAt
	)
		return Response.json(
			{ message: "Invalid resume request" },
			{ status: 400 },
		);
	try {
		const result = (await findTransfer(c.env, bucket, key, size, sha256)) as {
			record: {
				storeName: string;
				fileName?: string;
				lastModified?: number;
			} | null;
		};
		if (
			!result.record ||
			result.record.fileName !== fileName ||
			result.record.lastModified !== lastModified
		)
			return Response.json({ message: "Transfer not found" }, { status: 404 });
		const namespace = c.env.TRANSFER_STORE;
		if (!namespace) throw new Error("Transfer store unavailable");
		const stub = namespace.getByName(result.record.storeName);
		const state = await transferState(stub);
		if (
			state.kind !== "upload" ||
			!["active", "staged"].includes(state.status) ||
			state.bucket !== bucket ||
			state.key !== key ||
			state.size !== size ||
			state.fileName !== fileName ||
			state.lastModified !== lastModified ||
			state.sha256 !== sha256
		)
			return Response.json({ message: "Transfer not found" }, { status: 404 });
		await rebindTransfer(
			stub,
			sessionId,
			sessionExpiresAt + TRANSFER_TTL_SECONDS * 1000,
		);
		const token = await rotateTransferToken(c.env, result.record.storeName);
		return Response.json(
			{
				token,
				statusUrl: transferUrl(c, token, "upload"),
				bodyUrl: transferUrl(c, token, "upload/body"),
				mode: state.uploadMode,
				status: state.status,
				partSize: state.partSize,
				expiresAt: state.expiresAt,
				generation: state.generation + 1,
				parts: Object.fromEntries(
					Object.entries(state.parts || {}).map(([part, value]) => [
						part,
						{
							partNumber: value.partNumber,
							size: value.size,
							sha256: value.sha256,
						},
					]),
				),
			},
			{ headers: noStoreHeaders() },
		);
	} catch (error) {
		return responseError(error, "Unable to resume transfer");
	}
}

function publicTransferState(state: TransferState) {
	return {
		kind: state.kind,
		owner: state.owner,
		bucket: state.bucket,
		key: state.key,
		size: state.size,
		expiresAt: state.expiresAt,
		status: state.status,
		generation: state.generation,
		uploadMode: state.uploadMode,
		partSize: state.partSize,
		parts: state.parts
			? Object.fromEntries(
					Object.entries(state.parts).map(([part, value]) => [
						part,
						{
							partNumber: value.partNumber,
							size: value.size,
							sha256: value.sha256,
						},
					]),
				)
			: undefined,
		completedEtag: state.completedEtag,
	};
}

export async function getTransferStatus(c: AppContext) {
	try {
		const { state } = await authorizedState(c, c.req.param("token"));
		if (state.kind === "upload") await requireCurrentAdmin(c, state, false);
		return Response.json(publicTransferState(state), {
			headers: noStoreHeaders(),
		});
	} catch (error) {
		return responseError(error);
	}
}

export async function downloadTransfer(c: AppContext) {
	try {
		const { state } = await authorizedState(c, c.req.param("token"));
		if (state.kind !== "download")
			throw new TransferStoreError("Transfer not found", 404);
		const bucket = c.env[state.bucket] as R2Bucket | undefined;
		if (!bucket) throw new TransferStoreError("Bucket binding not found", 503);
		return serveR2Object(bucket, state.key, c.req.raw, {
			expectedEtag: state.expectedEtag,
			fileName: state.key.split("/").pop() || "download",
			public: state.owner === "public",
		});
	} catch (error) {
		return responseError(error);
	}
}

export async function createPublicDownloadTransfer(
	c: AppContext,
	key: string,
	lock: Awaited<ReturnType<typeof findAccessLock>>,
) {
	const context = publicAccessBucket(c.env, c.get("config"));
	if (!context || !isPublicObjectKey(key, context.config.prefix || ""))
		return null;
	const object = await context.bucket.head(key);
	if (!object) return null;
	try {
		const transfer = await createTransfer(c.env, {
			kind: "download",
			owner: "public",
			bucket: context.config.binding,
			key,
			expectedEtag: object.httpEtag,
			size: object.size,
			generation: 0,
			publicTarget: lock?.metadata.target,
			publicAuthVersion: lock?.metadata.authVersion,
		});
		return new Response(null, {
			status: 302,
			headers: {
				Location: transferUrl(c, transfer.token, "download"),
				...noStoreHeaders(),
			},
		});
	} catch {
		return new Response("Not found", {
			status: 404,
			headers: noStoreHeaders(),
		});
	}
}

export async function uploadTransferBody(c: AppContext) {
	let stub: DurableObjectStub | undefined;
	let initialState: TransferState | undefined;
	try {
		const authorized = await authorizedState(c, c.req.param("token"));
		stub = authorized.stub;
		initialState = authorized.state;
		const { stub: transferStub, state } = authorized;
		await requireCurrentAdmin(c, state);
		if (
			state.kind !== "upload" ||
			state.uploadMode !== "single" ||
			!state.stagingKey
		)
			throw new TransferStoreError("Transfer not found", 404);
		const generation = state.generation;
		const bucket = c.env[state.bucket] as R2Bucket | undefined;
		if (!bucket) throw new TransferStoreError("Bucket binding not found", 503);
		const uploaded = await bucket.put(
			state.stagingKey,
			c.req.raw.body || new Uint8Array(),
			{
				customMetadata: markerMetadata(state),
				httpMetadata: state.contentType
					? { contentType: state.contentType }
					: undefined,
				onlyIf: { etagDoesNotMatch: "*" },
			},
		);
		if (!uploaded)
			throw new TransferStoreError("Staged upload already exists", 409);
		const staged = await bucket.head(state.stagingKey);
		if (!staged || staged.size !== state.size) {
			await bucket.delete(state.stagingKey);
			await cancelTransfer(transferStub);
			await markRegistryTerminal(c, { ...state, status: "cancelled" });
			throw new TransferStoreError("Invalid upload size", 400);
		}
		await stageTransfer(transferStub, staged.httpEtag, staged.size, generation);
		return Response.json(
			{ success: true, size: staged.size, etag: staged.httpEtag },
			{ headers: noStoreHeaders() },
		);
	} catch (error) {
		if (stub && initialState) {
			try {
				const latest = await transferState(stub);
				if (
					["cancelled", "expired", "conflict", "failed"].includes(latest.status)
				)
					await cleanupUploadResources(c, latest);
			} catch {
				// The original error remains the client-visible result.
			}
		}
		return responseError(error);
	}
}

export async function uploadTransferPart(c: AppContext) {
	try {
		const { stub, state } = await authorizedState(c, c.req.param("token"));
		await requireCurrentAdmin(c, state);
		if (
			state.kind !== "upload" ||
			state.uploadMode !== "multipart" ||
			!state.uploadId
		)
			throw new TransferStoreError("Transfer not found", 404);
		const partNumber = Number(c.req.param("partNumber"));
		const total = partCount(state);
		if (
			!Number.isSafeInteger(partNumber) ||
			partNumber < 1 ||
			partNumber > total
		)
			throw new TransferStoreError("Invalid part number", 400);
		const totalSize = state.size;
		const partSize = state.partSize;
		if (!Number.isSafeInteger(totalSize) || !Number.isSafeInteger(partSize))
			throw new TransferStoreError("Invalid transfer size", 400);
		const expectedSize =
			partNumber === total ? totalSize - partSize * (total - 1) : partSize;
		const declaredSize = Number(
			c.req.header("Content-Length") ||
				c.req.header("X-Cloudbox-R2-Part-Size") ||
				0,
		);
		if (!Number.isSafeInteger(declaredSize) || declaredSize !== expectedSize)
			throw new TransferStoreError("Invalid part size", 400);
		const generation = state.generation;
		const bucket = c.env[state.bucket] as R2Bucket | undefined;
		if (!bucket) throw new TransferStoreError("Bucket binding not found", 503);
		const multipartKey = state.key;
		if (!multipartKey)
			throw new TransferStoreError("Multipart upload not found", 409);
		const upload = bucket.resumeMultipartUpload(multipartKey, state.uploadId);
		const uploaded = await upload.uploadPart(partNumber, c.req.raw.body);
		await checkpointTransferPart(
			stub,
			{
				partNumber,
				etag: uploaded.etag,
				size: declaredSize,
				sha256: c.req.header("X-Cloudbox-R2-Part-SHA256") || undefined,
			},
			generation,
		);
		return Response.json(uploaded, { headers: noStoreHeaders() });
	} catch (error) {
		return responseError(error);
	}
}

async function completeSingleUpload(
	c: AppContext,
	state: TransferState,
	stub: DurableObjectStub,
	generation: number,
) {
	const bucket = c.env[state.bucket] as R2Bucket | undefined;
	if (
		!bucket ||
		!state.stagingKey ||
		!state.stagedEtag ||
		state.stagedSize === undefined
	)
		throw new TransferStoreError("Staged upload not found", 409);
	const staged = await bucket.get(state.stagingKey);
	if (!staged || staged.size !== state.size)
		throw new TransferStoreError("Staged upload not found", 409);
	if (staged.customMetadata?.[MARKER] !== markerFor(state))
		throw new TransferStoreError("Staged upload marker mismatch", 409);
	const promoted = await bucket.put(state.key, staged.body, {
		onlyIf: { etagDoesNotMatch: "*" },
		customMetadata: staged.customMetadata,
		httpMetadata: staged.httpMetadata,
	});
	if (!promoted) {
		await markTransferFailure(stub, generation, "conflict");
		await bucket.delete(state.stagingKey);
		throw new TransferStoreError("Object already exists", 409);
	}
	const completed = await completeTransfer(stub, generation, promoted.httpEtag);
	try {
		await bucket.delete(state.stagingKey);
	} catch {
		// Terminal state is authoritative; retention cleanup retries staging deletion.
	}
	return completed;
}

async function completeMultipartUpload(
	c: AppContext,
	state: TransferState,
	stub: DurableObjectStub,
	generation: number,
) {
	const bucket = c.env[state.bucket] as R2Bucket | undefined;
	if (!bucket || !state.uploadId)
		throw new TransferStoreError("Multipart upload not found", 409);
	const parts = validateParts(state);
	await bucket
		.resumeMultipartUpload(state.key, state.uploadId)
		.complete(parts.map(({ etag, partNumber }) => ({ etag, partNumber })));
	const finalObject = await bucket.head(state.key);
	if (!finalObject || finalObject.customMetadata?.[MARKER] !== markerFor(state))
		throw new TransferStoreError(
			"Completed upload reconciliation pending",
			503,
		);
	return completeTransfer(stub, generation, finalObject.httpEtag);
}

async function markTransferFailure(
	stub: DurableObjectStub,
	generation: number,
	status: "conflict" | "failed",
) {
	const response = await stub.fetch("https://transfer/failure", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operation: "failure", generation, status }),
	});
	await response.arrayBuffer();
}

export async function completeUploadTransfer(c: AppContext) {
	try {
		const { stub, state: authorized } = await authorizedState(
			c,
			c.req.param("token"),
		);
		await requireCurrentAdmin(c, authorized);
		if (authorized.kind !== "upload")
			throw new TransferStoreError("Transfer not found", 404);
		const bucket = c.env[authorized.bucket] as R2Bucket | undefined;
		if (!bucket) throw new TransferStoreError("Bucket binding not found", 503);

		let state = authorized;
		if (["completing", "completed"].includes(state.status)) {
			const finalObject = await bucket.head(state.key);
			if (finalObject?.customMetadata?.[MARKER] === markerFor(state)) {
				if (state.status !== "completed")
					await completeTransfer(stub, state.generation, finalObject.httpEtag);
				state = await transferState(stub);
				await cleanupUploadResources(c, state);
				await markRegistryTerminal(c, state);
				return Response.json(
					{ success: true, etag: finalObject.httpEtag },
					{ headers: noStoreHeaders() },
				);
			}
			if (state.status === "completed") {
				await cleanupUploadResources(c, state);
				return Response.json(
					{ success: true, etag: state.completedEtag },
					{ headers: noStoreHeaders() },
				);
			}
		} else {
			const claim = await claimCompleteTransfer(stub);
			if (claim.outcome === "completed")
				return Response.json(
					{ success: true, etag: claim.state?.completedEtag },
					{ headers: noStoreHeaders() },
				);
			if (
				["cancelled", "expired", "conflict", "failed"].includes(
					claim.outcome || "",
				)
			)
				throw new TransferStoreError("Transfer unavailable", 409);
			state = claim.state as TransferState;
		}
		if (state.status !== "completing")
			throw new TransferStoreError("Transfer is not ready to complete", 409);
		const generation = state.generation;
		if (state.uploadMode === "single")
			await completeSingleUpload(c, state, stub, generation);
		else await completeMultipartUpload(c, state, stub, generation);
		state = await transferState(stub);
		await markRegistryTerminal(c, state);
		return Response.json(
			{ success: true, etag: state.completedEtag },
			{ headers: noStoreHeaders() },
		);
	} catch (error) {
		return responseError(error);
	}
}

export async function cancelUploadTransfer(c: AppContext) {
	try {
		const { stub, state } = await authorizedState(
			c,
			c.req.param("token"),
			true,
		);
		await requireCurrentAdmin(c, state);
		if (state.kind !== "upload")
			throw new TransferStoreError("Transfer not found", 404);
		const outcome = await cancelTransfer(stub);
		if (outcome.outcome === "too_late")
			return Response.json(
				{ success: false, outcome: "too_late" },
				{ status: 409, headers: noStoreHeaders() },
			);
		if (["completed", "expired"].includes(outcome.outcome || ""))
			return Response.json(
				{ success: false, outcome: outcome.outcome },
				{ status: 409, headers: noStoreHeaders() },
			);
		const terminal = await transferState(stub);
		await cleanupUploadResources(c, terminal);
		await markRegistryTerminal(c, terminal);
		return Response.json(
			{ success: true, outcome: "cancelled" },
			{ headers: noStoreHeaders() },
		);
	} catch (error) {
		return responseError(error);
	}
}

export async function getTransferCache(c: AppContext) {
	try {
		const result = (await listTransfers(c.env)) as {
			records: Array<Record<string, unknown>>;
		};
		const records = result.records || [];
		return Response.json(
			{
				count: records.length,
				expired: records.filter(
					(record) =>
						typeof record.expiresAt === "number" &&
						record.expiresAt <= Date.now(),
				),
				records,
			},
			{ headers: noStoreHeaders() },
		);
	} catch (error) {
		return responseError(error);
	}
}

export async function cleanupTransferCache(c: AppContext) {
	try {
		const result = await cleanupTransfers(c.env, 100);
		return Response.json(result, { headers: noStoreHeaders() });
	} catch (error) {
		return responseError(error);
	}
}

export function transferPath(suffix: string) {
	return `${TRANSFER_PREFIX}/:token/${suffix}`;
}
