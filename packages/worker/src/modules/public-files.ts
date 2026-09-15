import { decodeObjectKey, encodeObjectKey } from "../foundation/key-codec";
import { isPublicObjectKey } from "../foundation/public-access";
import {
	findAccessLock,
	publicAccessBucket,
} from "../foundation/public-access-lock";
import { serveR2Object } from "../foundation/range";
import { verifyPublicAccessSession } from "../foundation/session";
import type { AppContext } from "../types";

function notFound() {
	return Response.json({ message: "Not found" }, { status: 404 });
}

function locked() {
	return Response.json({ message: "Public object is locked" }, { status: 401 });
}

function parseLimit(value: string | null) {
	if (!value) return 50;
	const limit = Number(value);
	return Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : null;
}

function decodePrefix(value: string | null) {
	if (!value) return "";
	try {
		return decodeObjectKey(value);
	} catch {
		return null;
	}
}

async function hasAccess(
	c: AppContext,
	key: string,
	lock: Awaited<ReturnType<typeof findAccessLock>>,
) {
	if (!lock) return true;
	const session = await verifyPublicAccessSession(c.req.raw, c.env);
	return (
		session?.target === lock.metadata.target &&
		session.authVersion === lock.metadata.authVersion
	);
}

async function isLockedForRequest(
	c: AppContext,
	bucket: R2Bucket,
	key: string,
) {
	const lock = await findAccessLock(bucket, key);
	return Boolean(lock && !(await hasAccess(c, key, lock)));
}

export async function listPublicFiles(c: AppContext) {
	const config = c.get("config");
	const context = publicAccessBucket(c.env, config);
	if (!context) return notFound();

	const url = new URL(c.req.url);
	const limit = parseLimit(url.searchParams.get("limit"));
	let relativePrefix = decodePrefix(url.searchParams.get("prefix"));
	if (limit === null || relativePrefix === null) {
		return Response.json(
			{ message: "Invalid public file query" },
			{ status: 400 },
		);
	}

	const publicPrefix = context.config.prefix || "";
	if (publicPrefix && relativePrefix.startsWith(publicPrefix))
		relativePrefix = relativePrefix.slice(publicPrefix.length);
	const prefix = `${publicPrefix}${relativePrefix}`;
	if (!isPublicObjectKey(prefix || "public-root", context.config.prefix || ""))
		return notFound();

	const prefixLock = prefix
		? await findAccessLock(context.bucket, prefix)
		: null;
	if (prefixLock && !(await hasAccess(c, prefix, prefixLock))) return locked();

	const options: R2ListOptions = { limit, delimiter: "/" };
	if (prefix) options.prefix = prefix;
	const cursor = url.searchParams.get("cursor");
	if (cursor) options.cursor = cursor;
	const result = await context.bucket.list(options);

	const objects = await Promise.all(
		result.objects
			.filter((object) => !object.key.endsWith("/"))
			.filter((object) => isPublicObjectKey(object.key, publicPrefix))
			.map(async (object) => ({
				key: object.key,
				encodedKey: encodeObjectKey(object.key),
				size: object.size,
				uploaded: object.uploaded,
				locked: await isLockedForRequest(c, context.bucket, object.key),
			})),
	);
	const delimitedPrefixes = await Promise.all(
		result.delimitedPrefixes
			.filter((key) => isPublicObjectKey(key, publicPrefix))
			.map(async (key) => ({
				key,
				encodedKey: encodeObjectKey(key),
				locked: await isLockedForRequest(c, context.bucket, key),
			})),
	);

	return Response.json(
		{
			publicPrefix,
			objects,
			delimitedPrefixes,
			truncated: result.truncated,
			cursor: result.truncated ? result.cursor : null,
		},
		{ headers: { "Cache-Control": "no-store, max-age=0" } },
	);
}

export async function downloadPublicFile(c: AppContext) {
	const config = c.get("config");
	const context = publicAccessBucket(c.env, config);
	if (!context) return notFound();

	let key: string;
	try {
		key = decodeObjectKey(c.req.param("key"));
	} catch {
		return notFound();
	}

	if (!isPublicObjectKey(key, context.config.prefix || "")) return notFound();
	if (!(await context.bucket.head(key))) return notFound();

	const lock = await findAccessLock(context.bucket, key);
	if (lock && !(await hasAccess(c, key, lock))) return locked();

	return serveR2Object(context.bucket, key, c.req.raw, {
		fileName: key.split("/").pop() || "download",
		public: true,
	});
}
