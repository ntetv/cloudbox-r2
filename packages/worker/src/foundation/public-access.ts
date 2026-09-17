import type { PublicBucketConfig } from "../types";

const ADMIN_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{5,12}$/;

export function normalizeAdminPathSegment(value?: string) {
	if (typeof value !== "string" || !ADMIN_PATH_SEGMENT_PATTERN.test(value))
		throw new Error("Invalid CLOUDBOX_R2_ADMIN_PATH");
	return value;
}

export function normalizeAdminPath(value?: string) {
	return `/${normalizeAdminPathSegment(value)}`;
}

export function normalizePublicBucket(config?: PublicBucketConfig) {
	if (!config) return undefined;
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.binding)) {
		throw new Error("publicBucket.binding must be a valid Worker binding name");
	}

	const prefix = config.prefix || "";
	if (prefix.startsWith("/") || prefix.includes("\\")) {
		throw new Error("publicBucket.prefix must be an object-key prefix");
	}

	const normalizedPrefix =
		prefix === "" ? "" : prefix.endsWith("/") ? prefix : `${prefix}/`;
	if (prefix && !isPublicObjectKey(normalizedPrefix.slice(0, -1), "")) {
		throw new Error("publicBucket.prefix cannot contain hidden path segments");
	}

	return { binding: config.binding, prefix: normalizedPrefix };
}

export function isPublicObjectKey(key: string, prefix = "") {
	if (!key || (prefix && !key.startsWith(prefix))) return false;
	const segments = key.split("/");
	return !segments.some((segment) => segment.startsWith("."));
}
