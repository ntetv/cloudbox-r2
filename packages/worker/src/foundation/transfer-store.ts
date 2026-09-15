import type { AppEnv } from "../types";

const STATE_KEY = "state";
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;

export type TransferKind = "download" | "upload";
export type TransferOwner = "admin" | "public";
export type TransferUploadMode = "single" | "multipart";
export type TransferStatus =
	| "active"
	| "staged"
	| "completing"
	| "completed"
	| "cancelled"
	| "expired"
	| "conflict"
	| "failed";

export type TransferPart = {
	partNumber: number;
	etag: string;
	size: number;
	sha256?: string;
};

export type TransferState = {
	kind: TransferKind;
	owner: TransferOwner;
	ownerSessionId?: string;
	ownerRetentionUntil?: number;
	bucket: string;
	key: string;
	expectedEtag?: string;
	size?: number;
	publicTarget?: string;
	publicAuthVersion?: string;
	createdAt: number;
	expiresAt: number;
	retentionUntil?: number;
	status: TransferStatus;
	generation: number;
	operationId?: string;
	registryStoreName?: string;
	tokenHash?: string;
	uploadMode?: TransferUploadMode;
	stagingKey?: string;
	uploadId?: string;
	partSize?: number;
	contentType?: string;
	fileName?: string;
	lastModified?: number;
	sha256?: string;
	parts?: Record<string, TransferPart>;
	stagedEtag?: string;
	stagedSize?: number;
	completedEtag?: string;
	failureCode?: "conflict" | "failed";
};

type TransferOperation =
	| { operation: "create"; state: TransferState }
	| { operation: "checkpoint"; part: TransferPart; generation: number }
	| { operation: "stage"; etag: string; size: number; generation: number }
	| { operation: "claim-complete" }
	| { operation: "complete"; generation: number; etag?: string }
	| { operation: "failure"; generation: number; status: "conflict" | "failed" }
	| { operation: "cancel" }
	| { operation: "reap" }
	| { operation: "rebind"; ownerSessionId: string; ownerRetentionUntil: number }
	| { operation: "rotate-token"; tokenHash: string }
	| { operation: "get" };

function json(data: unknown, status = 200) {
	return Response.json(data, { status });
}

function isTerminal(state: TransferState) {
	return ["completed", "cancelled", "expired", "conflict", "failed"].includes(
		state.status,
	);
}

function terminalRetention(state: TransferState) {
	return state.retentionUntil || state.expiresAt + TERMINAL_RETENTION_MS;
}

function normalizeState(state: TransferState) {
	let changed = false;
	if (!Number.isSafeInteger(state.generation)) {
		state.generation = 0;
		changed = true;
	}
	if (state.kind === "upload" && !state.uploadMode) {
		state.uploadMode = state.uploadId ? "multipart" : "single";
		changed = true;
	}
	if (state.kind === "upload" && !state.operationId) {
		state.operationId = crypto.randomUUID();
		changed = true;
	}
	if (!state.retentionUntil) {
		state.retentionUntil = state.expiresAt + TERMINAL_RETENTION_MS;
		changed = true;
	}
	return changed;
}

export class TransferStore implements DurableObject {
	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: AppEnv,
	) {}

	async fetch(request: Request) {
		let input: TransferOperation;
		try {
			input = (await request.json()) as TransferOperation;
		} catch {
			return json({ message: "Invalid transfer request" }, 400);
		}

		try {
			if (input.operation === "create") return this.create(input.state);
			if (input.operation === "get") return this.get();
			if (input.operation === "checkpoint")
				return this.checkpoint(input.part, input.generation);
			if (input.operation === "stage")
				return this.stage(input.etag, input.size, input.generation);
			if (input.operation === "claim-complete") return this.claimComplete();
			if (input.operation === "complete")
				return this.complete(input.generation, input.etag);
			if (input.operation === "failure")
				return this.failure(input.generation, input.status);
			if (input.operation === "cancel") return this.cancel();
			if (input.operation === "reap") return this.reap();
			if (input.operation === "rebind")
				return this.rebind(input.ownerSessionId, input.ownerRetentionUntil);
			if (input.operation === "rotate-token")
				return this.rotateToken(input.tokenHash);
			return json({ message: "Invalid transfer request" }, 400);
		} catch (error) {
			if (error instanceof TransferStoreError)
				return json({ message: error.message }, error.status);
			throw error;
		}
	}

	async alarm() {
		const state = await this.ctx.storage.get<TransferState>(STATE_KEY);
		if (!state) return;

		if (!isTerminal(state) && state.expiresAt <= Date.now()) {
			state.status = "expired";
			state.generation += 1;
			state.retentionUntil = terminalRetention(state);
			await this.ctx.storage.put(STATE_KEY, state);
			await this.cleanupResources(state);
			await this.ctx.storage.setAlarm(state.retentionUntil);
			return;
		}

		if (isTerminal(state) && terminalRetention(state) <= Date.now()) {
			await this.cleanupResources(state);
			await this.ctx.storage.deleteAll();
			return;
		}

		await this.ctx.storage.setAlarm(
			isTerminal(state) ? terminalRetention(state) : state.expiresAt,
		);
	}

	private async create(input: TransferState) {
		if (!input || input.expiresAt <= Date.now())
			return json({ message: "Invalid transfer state" }, 400);
		const state: TransferState = {
			...input,
			generation: input.generation || 0,
			status: input.status || "active",
			retentionUntil:
				input.retentionUntil || input.expiresAt + TERMINAL_RETENTION_MS,
		};
		await this.ctx.storage.put(STATE_KEY, state);
		await this.ctx.storage.setAlarm(state.expiresAt);
		return json({ state });
	}

	private async get() {
		const state = await this.ctx.storage.get<TransferState>(STATE_KEY);
		if (!state) return json({ message: "Transfer not found" }, 404);
		const normalized = normalizeState(state);
		if (normalized) await this.ctx.storage.put(STATE_KEY, state);
		if (!isTerminal(state) && state.expiresAt <= Date.now()) {
			state.status = "expired";
			state.generation += 1;
			state.retentionUntil = terminalRetention(state);
			await this.ctx.storage.put(STATE_KEY, state);
			await this.cleanupResources(state);
			await this.ctx.storage.setAlarm(state.retentionUntil);
		}
		return json({ state });
	}

	private async checkpoint(part: TransferPart, generation: number) {
		const state = await this.activeUpload();
		if (state.generation !== generation)
			throw new TransferStoreError("Stale transfer operation", 409);
		if (
			!Number.isInteger(part?.partNumber) ||
			part.partNumber < 1 ||
			!part.etag ||
			!Number.isSafeInteger(part.size) ||
			part.size < 0
		)
			return json({ message: "Invalid transfer part" }, 400);

		state.parts ||= {};
		const existing = state.parts[String(part.partNumber)];
		if (existing && existing.etag !== part.etag)
			throw new TransferStoreError("Part already checkpointed", 409);
		state.parts[String(part.partNumber)] = part;
		await this.ctx.storage.put(STATE_KEY, state);
		return json({ state });
	}

	private async stage(etag: string, size: number, generation: number) {
		const state = await this.activeUpload();
		if (state.generation !== generation)
			throw new TransferStoreError("Stale transfer operation", 409);
		if (
			state.uploadMode !== "single" ||
			state.size === undefined ||
			size !== state.size
		)
			throw new TransferStoreError("Invalid staged upload size", 409);
		state.status = "staged";
		state.stagedEtag = etag;
		state.stagedSize = size;
		await this.ctx.storage.put(STATE_KEY, state);
		return json({ state });
	}

	private async claimComplete() {
		const state = await this.ctx.storage.get<TransferState>(STATE_KEY);
		if (!state) return json({ message: "Transfer not found" }, 404);
		if (state.status === "completed")
			return json({ outcome: "completed", state });
		if (state.status === "cancelled")
			return json({ outcome: "cancelled", state }, 410);
		if (state.status === "expired")
			return json({ outcome: "expired", state }, 410);
		if (["conflict", "failed"].includes(state.status))
			return json({ outcome: state.status, state }, 409);
		if (state.status === "completing")
			return json({ outcome: "completing", state });
		if (
			(state.uploadMode === "single" && state.status !== "staged") ||
			(["multipart"].includes(state.uploadMode || "") &&
				state.status !== "active")
		)
			throw new TransferStoreError("Transfer is not ready to complete", 409);
		if (state.expiresAt <= Date.now()) {
			state.status = "expired";
			state.generation += 1;
			state.retentionUntil = terminalRetention(state);
			await this.ctx.storage.put(STATE_KEY, state);
			await this.cleanupResources(state);
			await this.ctx.storage.setAlarm(state.retentionUntil);
			return json({ outcome: "expired", state }, 410);
		}

		state.status = "completing";
		state.generation += 1;
		state.operationId ||= crypto.randomUUID();
		await this.ctx.storage.put(STATE_KEY, state);
		return json({ outcome: "claimed", state });
	}

	private async complete(generation: number, etag?: string) {
		const state = await this.ctx.storage.get<TransferState>(STATE_KEY);
		if (!state) return json({ message: "Transfer not found" }, 404);
		if (state.status === "completed")
			return json({ outcome: "completed", state });
		if (state.status !== "completing" || state.generation !== generation)
			throw new TransferStoreError("Transfer completion is stale", 409);
		state.status = "completed";
		state.completedEtag = etag;
		state.retentionUntil = terminalRetention(state);
		await this.ctx.storage.put(STATE_KEY, state);
		await this.ctx.storage.setAlarm(state.retentionUntil);
		return json({ outcome: "completed", state });
	}

	private async failure(generation: number, status: "conflict" | "failed") {
		const state = await this.ctx.storage.get<TransferState>(STATE_KEY);
		if (!state) return json({ message: "Transfer not found" }, 404);
		if (state.status === status) return json({ outcome: status, state });
		if (state.status !== "completing" || state.generation !== generation)
			throw new TransferStoreError("Transfer failure is stale", 409);
		state.status = status;
		state.failureCode = status;
		state.retentionUntil = terminalRetention(state);
		await this.ctx.storage.put(STATE_KEY, state);
		await this.ctx.storage.setAlarm(state.retentionUntil);
		return json({ outcome: status, state });
	}

	private async cancel() {
		const state = await this.ctx.storage.get<TransferState>(STATE_KEY);
		if (!state) return json({ message: "Transfer not found" }, 404);
		if (state.status === "completed")
			return json({ outcome: "completed", state });
		if (state.status === "completing")
			return json({ outcome: "too_late", state }, 409);
		if (state.status === "cancelled")
			return json({ outcome: "cancelled", state });
		if (state.status === "expired")
			return json({ outcome: "expired", state }, 410);
		if (["conflict", "failed"].includes(state.status))
			return json({ outcome: state.status, state }, 409);
		state.status = "cancelled";
		state.generation += 1;
		state.retentionUntil = terminalRetention(state);
		await this.ctx.storage.put(STATE_KEY, state);
		await this.ctx.storage.setAlarm(state.retentionUntil);
		return json({ outcome: "cancelled", state });
	}

	private async reap() {
		const state = await this.ctx.storage.get<TransferState>(STATE_KEY);
		if (!state) return json({ message: "Transfer not found" }, 404);
		if (state.expiresAt > Date.now())
			return json({ message: "Transfer is not expired" }, 409);
		if (!isTerminal(state)) {
			state.status = "expired";
			state.generation += 1;
			state.retentionUntil = terminalRetention(state);
			await this.ctx.storage.put(STATE_KEY, state);
			await this.cleanupResources(state);
			await this.ctx.storage.setAlarm(state.retentionUntil);
		}
		return json({ reaped: true, state });
	}

	private async rebind(ownerSessionId: string, ownerRetentionUntil: number) {
		const state = await this.ctx.storage.get<TransferState>(STATE_KEY);
		if (!state || state.kind !== "upload")
			return json({ message: "Transfer not found" }, 404);
		if (
			!["active", "staged"].includes(state.status) ||
			state.expiresAt <= Date.now()
		)
			return json({ message: "Transfer unavailable" }, 410);
		state.ownerSessionId = ownerSessionId;
		state.ownerRetentionUntil = ownerRetentionUntil;
		state.generation += 1;
		await this.ctx.storage.put(STATE_KEY, state);
		return json({ rebound: true, state });
	}

	private async rotateToken(tokenHash: string) {
		const state = await this.ctx.storage.get<TransferState>(STATE_KEY);
		if (!state || state.kind !== "upload")
			return json({ message: "Transfer not found" }, 404);
		if (isTerminal(state))
			return json({ message: "Transfer unavailable" }, 410);
		state.tokenHash = tokenHash;
		await this.ctx.storage.put(STATE_KEY, state);
		return json({ rotated: true });
	}

	private async activeUpload() {
		const state = await this.ctx.storage.get<TransferState>(STATE_KEY);
		if (!state || state.kind !== "upload")
			throw new TransferStoreError("Transfer not found", 404);
		if (!["active", "staged"].includes(state.status))
			throw new TransferStoreError("Transfer is not active", 409);
		if (state.expiresAt <= Date.now()) {
			state.status = "expired";
			state.generation += 1;
			state.retentionUntil = terminalRetention(state);
			await this.ctx.storage.put(STATE_KEY, state);
			await this.cleanupResources(state);
			await this.ctx.storage.setAlarm(state.retentionUntil);
			throw new TransferStoreError("Transfer expired", 410);
		}
		return state;
	}

	private async cleanupResources(state: TransferState) {
		const bucket = this.env[state.bucket] as R2Bucket | undefined;
		if (!bucket) return;
		if (state.uploadId) {
			const multipartKey = state.key;
			try {
				await bucket
					.resumeMultipartUpload(multipartKey, state.uploadId)
					.abort();
			} catch {
				// R2 cleanup is best effort; lifecycle rules remain the final safeguard.
			}
		}
		if (state.stagingKey) {
			try {
				await bucket.delete(state.stagingKey);
			} catch {
				// Staging cleanup is retried by alarm/cache cleanup.
			}
		}
	}
}

export class TransferStoreError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

async function storeRequest(
	stub: DurableObjectStub,
	operation: TransferOperation,
) {
	const response = await stub.fetch("https://transfer/state", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(operation),
	});
	const body = (await response.json().catch(() => ({}))) as {
		message?: string;
		state?: TransferState;
		outcome?: string;
	};
	if (!response.ok && !body.outcome)
		throw new TransferStoreError(
			body.message || "Transfer store unavailable",
			response.status,
		);
	return body;
}

export async function transferState(stub: DurableObjectStub) {
	const body = await storeRequest(stub, { operation: "get" });
	if (!body.state) throw new TransferStoreError("Transfer not found", 404);
	return body.state;
}

export async function createTransferState(
	stub: DurableObjectStub,
	state: TransferState,
) {
	const response = await stub.fetch("https://transfer/create", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operation: "create", state }),
	});
	if (!response.ok)
		throw new TransferStoreError("Unable to create transfer", 503);
	await response.arrayBuffer();
}

export async function checkpointTransferPart(
	stub: DurableObjectStub,
	part: TransferPart,
	generation: number,
) {
	await storeRequest(stub, { operation: "checkpoint", part, generation });
}

export async function stageTransfer(
	stub: DurableObjectStub,
	etag: string,
	size: number,
	generation: number,
) {
	await storeRequest(stub, { operation: "stage", etag, size, generation });
}

export async function claimCompleteTransfer(stub: DurableObjectStub) {
	return storeRequest(stub, { operation: "claim-complete" });
}

export async function rebindTransfer(
	stub: DurableObjectStub,
	ownerSessionId: string,
	ownerRetentionUntil: number,
) {
	await storeRequest(stub, {
		operation: "rebind",
		ownerSessionId,
		ownerRetentionUntil,
	});
}

export async function rotateTransferTokenHash(
	stub: DurableObjectStub,
	tokenHash: string,
) {
	await storeRequest(stub, { operation: "rotate-token", tokenHash });
}

export async function completeTransfer(
	stub: DurableObjectStub,
	generation: number,
	etag?: string,
) {
	const body = await storeRequest(stub, {
		operation: "complete",
		generation,
		etag,
	});
	return body.state;
}

export async function cancelTransfer(stub: DurableObjectStub) {
	return storeRequest(stub, { operation: "cancel" });
}

export async function reapTransfer(stub: DurableObjectStub) {
	return storeRequest(stub, { operation: "reap" });
}
