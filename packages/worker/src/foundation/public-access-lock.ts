import type {
	AppEnv,
	PublicAccessLockMetadata,
	PublicBucketConfig,
} from "../types";
import { encodeObjectKey } from "./key-codec";
import { isPublicObjectKey } from "./public-access";

const encoder = new TextEncoder();
const PASSWORD_ITERATIONS = 100_000;
const LOCK_PREFIX = ".cloudbox-r2/access-locks/";

type FoundAccessLock = {
	metadata: PublicAccessLockMetadata;
	metadataEtag: string;
};

function encodeBytes(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

function decodeBytes(value: string) {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	const padded =
		value.replaceAll("-", "+").replaceAll("_", "/") +
		"=".repeat((4 - (value.length % 4)) % 4);
	try {
		return Uint8Array.from(atob(padded), (character) =>
			character.charCodeAt(0),
		);
	} catch {
		return null;
	}
}

function requireSecret(env: AppEnv, name: "PUBLIC_ACCESS_PASSWORD_PEPPER") {
	const value = env[name];
	if (typeof value !== "string" || !value) {
		throw new Error(`Missing Worker secret: ${name}`);
	}
	return value;
}

async function pepper(password: string, secret: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(
		await crypto.subtle.sign("HMAC", key, encoder.encode(password)),
	);
}

async function derivePasswordHash(
	password: string,
	salt: Uint8Array,
	pepperSecret: string,
) {
	const pepperedPassword = await pepper(password, pepperSecret);
	const material = await crypto.subtle.importKey(
		"raw",
		pepperedPassword,
		"PBKDF2",
		false,
		["deriveBits"],
	);
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{
				name: "PBKDF2",
				hash: "SHA-256",
				salt,
				iterations: PASSWORD_ITERATIONS,
			},
			material,
			256,
		),
	);
}

export function accessLockMetadataKey(target: string) {
	return `${LOCK_PREFIX}${encodeObjectKey(target)}.json`;
}

export function isFolderTarget(target: string) {
	return target.endsWith("/");
}

export function isValidAccessTarget(
	target: string,
	config: PublicBucketConfig,
) {
	return (
		target.length > 0 &&
		!target.startsWith("/") &&
		!target.includes("\\") &&
		isPublicObjectKey(target, config.prefix || "") &&
		(!isFolderTarget(target) || target.endsWith("/"))
	);
}

export function accessLockTargetCandidates(key: string) {
	const normalized = key.endsWith("/") ? key.slice(0, -1) : key;
	const parts = normalized.split("/");
	const candidates = [key];
	for (let index = parts.length - 1; index > 0; index--) {
		candidates.push(`${parts.slice(0, index).join("/")}/`);
	}
	return candidates;
}

export function parseAccessLockMetadata(
	value: unknown,
): PublicAccessLockMetadata | null {
	if (!value || typeof value !== "object") return null;
	const metadata = value as Partial<PublicAccessLockMetadata>;
	if (
		metadata.schemaVersion !== 1 ||
		typeof metadata.target !== "string" ||
		(metadata.scope !== "file" && metadata.scope !== "folder") ||
		metadata.scope !== (metadata.target.endsWith("/") ? "folder" : "file") ||
		!metadata.password ||
		typeof metadata.password.salt !== "string" ||
		typeof metadata.password.hash !== "string" ||
		metadata.password.iterations !== PASSWORD_ITERATIONS ||
		typeof metadata.authVersion !== "string" ||
		typeof metadata.createdAt !== "number" ||
		typeof metadata.updatedAt !== "number"
	)
		return null;
	return metadata as PublicAccessLockMetadata;
}

async function readAccessLock(
	bucket: R2Bucket,
	target: string,
): Promise<FoundAccessLock | null> {
	const object = await bucket.get(accessLockMetadataKey(target));
	if (!object) return null;
	try {
		const metadata = parseAccessLockMetadata(JSON.parse(await object.text()));
		if (!metadata || metadata.target !== target) return null;
		return { metadata, metadataEtag: object.etag };
	} catch {
		return null;
	}
}

export async function findAccessLock(bucket: R2Bucket, key: string) {
	for (const target of accessLockTargetCandidates(key)) {
		const found = await readAccessLock(bucket, target);
		if (found) return found;
	}
	return null;
}

async function listAccessLocks(bucket: R2Bucket) {
	const locks: PublicAccessLockMetadata[] = [];
	let cursor: string | undefined;
	for (;;) {
		const result = await bucket.list({
			prefix: LOCK_PREFIX,
			limit: 1000,
			cursor,
		});
		for (const object of result.objects) {
			const metadataObject = await bucket.get(object.key);
			if (!metadataObject) continue;
			try {
				const metadata = parseAccessLockMetadata(
					JSON.parse(await metadataObject.text()),
				);
				if (metadata) locks.push(metadata);
			} catch {
				// Ignore malformed internal metadata.
			}
		}
		if (!result.truncated) return locks;
		cursor = result.cursor;
	}
}

function locksOverlap(left: string, right: string) {
	const leftFolder = isFolderTarget(left);
	const rightFolder = isFolderTarget(right);
	if (leftFolder && rightFolder)
		return left.startsWith(right) || right.startsWith(left);
	if (leftFolder) return right.startsWith(left);
	if (rightFolder) return left.startsWith(right);
	return left === right;
}

export async function publicTargetExists(bucket: R2Bucket, target: string) {
	if (!isFolderTarget(target)) return (await bucket.head(target)) !== null;
	const result = await bucket.list({ prefix: target, limit: 1 });
	return result.objects.length > 0 || result.delimitedPrefixes.length > 0;
}

export async function validateAccessTarget(
	bucket: R2Bucket,
	target: string,
	config: PublicBucketConfig,
) {
	if (!isValidAccessTarget(target, config)) {
		throw new Error("Invalid public access target");
	}
	if (!(await publicTargetExists(bucket, target))) {
		throw new Error("Public access target not found");
	}
}

export async function getAccessLockStatus(bucket: R2Bucket, target: string) {
	const found = await findAccessLock(bucket, target);
	return found
		? {
				locked: true,
				target: found.metadata.target,
				scope: found.metadata.scope,
			}
		: { locked: false };
}

export async function setAccessLock(
	bucket: R2Bucket,
	target: string,
	password: string,
	config: PublicBucketConfig,
	env: AppEnv,
) {
	await validateAccessTarget(bucket, target, config);
	if (
		typeof password !== "string" ||
		!password ||
		encoder.encode(password).byteLength > 1024
	) {
		throw new Error("Invalid public access password");
	}

	const locks = await listAccessLocks(bucket);
	if (
		locks.some(
			(lock) => lock.target !== target && locksOverlap(lock.target, target),
		)
	) {
		throw new Error("Overlapping public access lock");
	}

	const now = Date.now();
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await derivePasswordHash(
		password,
		salt,
		requireSecret(env, "PUBLIC_ACCESS_PASSWORD_PEPPER"),
	);
	const existing = await readAccessLock(bucket, target);
	const metadata: PublicAccessLockMetadata = {
		schemaVersion: 1,
		target,
		scope: isFolderTarget(target) ? "folder" : "file",
		password: {
			salt: encodeBytes(salt),
			hash: encodeBytes(hash),
			iterations: PASSWORD_ITERATIONS,
		},
		authVersion: encodeBytes(crypto.getRandomValues(new Uint8Array(16))),
		createdAt: existing?.metadata.createdAt || now,
		updatedAt: now,
	};
	await bucket.put(accessLockMetadataKey(target), JSON.stringify(metadata), {
		httpMetadata: { contentType: "application/json" },
	});
	return { locked: true, target, scope: metadata.scope };
}

export async function removeAccessLock(
	bucket: R2Bucket,
	target: string,
	config: PublicBucketConfig,
) {
	if (!isValidAccessTarget(target, config))
		throw new Error("Invalid public access target");
	await bucket.delete(accessLockMetadataKey(target));
	return { locked: false };
}

export async function verifyAccessPassword(
	password: string,
	metadata: PublicAccessLockMetadata,
	env: AppEnv,
) {
	if (!password || encoder.encode(password).byteLength > 1024) return false;
	const salt = decodeBytes(metadata.password.salt);
	const expectedHash = decodeBytes(metadata.password.hash);
	if (
		!salt ||
		!expectedHash ||
		metadata.password.iterations !== PASSWORD_ITERATIONS
	)
		return false;
	const actualHash = await derivePasswordHash(
		password,
		salt,
		requireSecret(env, "PUBLIC_ACCESS_PASSWORD_PEPPER"),
	);
	if (actualHash.length !== expectedHash.length) return false;
	let difference = 0;
	for (let index = 0; index < actualHash.length; index++)
		difference |= actualHash[index] ^ expectedHash[index];
	return difference === 0;
}

export function publicAccessBucket(
	env: AppEnv,
	config: { publicBucket?: PublicBucketConfig },
) {
	if (!config.publicBucket) return null;
	const bucket = env[config.publicBucket.binding];
	return bucket && typeof bucket === "object" && "list" in bucket
		? { bucket: bucket as R2Bucket, config: config.publicBucket }
		: null;
}

export function publicAccessLockMetadataPrefix() {
	return LOCK_PREFIX;
}
