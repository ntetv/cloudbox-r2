import { decodeObjectKey, encodeObjectKey } from "../foundation/key-codec";
import { isPublicObjectKey } from "../foundation/public-access";
import {
	findAccessLock,
	isFolderTarget,
	publicAccessBucket,
	publicTargetExists,
	verifyAccessPassword,
} from "../foundation/public-access-lock";
import {
	createPublicAccessSession,
	limitPublicAccess,
	verifyPublicAccessSession,
} from "../foundation/session";
import type { AppContext } from "../types";
import { dashboardAssetRequest } from "./dashboard";
import { createPublicDownloadTransfer } from "./transfers";

const pageHeaders = {
	"Cache-Control": "no-store",
	"Content-Security-Policy":
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
};

function notFound() {
	return new Response("Not found", {
		status: 404,
		headers: pageHeaders,
	});
}

function getPublicContext(c: AppContext) {
	return publicAccessBucket(c.env, c.get("config"));
}

function decodeTarget(value: string) {
	try {
		return decodeObjectKey(value);
	} catch {
		return null;
	}
}

function sessionMatches(
	request: Request,
	env: AppContext["env"],
	lock: Awaited<ReturnType<typeof findAccessLock>>,
) {
	if (!lock) return Promise.resolve(false);
	return verifyPublicAccessSession(request, env).then(
		(session) =>
			session?.target === lock.metadata.target &&
			session.authVersion === lock.metadata.authVersion,
	);
}

function page(title: string, action: string, message = "") {
	const escapedTitle = title.replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				character
			],
	);
	const escapedAction = action.replace(/[^A-Za-z0-9_./-]/g, "");
	const escapedMessage = message.replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				character
			],
	);
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapedTitle}</title></head><body><h1>${escapedTitle}</h1>${escapedMessage ? `<p>${escapedMessage}</p>` : ""}<form method="post" action="${escapedAction}"><label>Password <input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Unlock</button></form></body></html>`,
		{ headers: { ...pageHeaders, "Content-Type": "text/html; charset=utf-8" } },
	);
}

async function unlock(c: AppContext, key: string, action: string) {
	const origin = c.req.header("Origin");
	const sameOriginFetch = c.req.header("Sec-Fetch-Site") === "same-origin";
	if (
		origin !== new URL(c.req.url).origin &&
		!(sameOriginFetch && (!origin || origin === "null"))
	)
		return notFound();
	const context = getPublicContext(c);
	if (
		!context ||
		!key ||
		!isPublicObjectKey(key, context.config.prefix || "") ||
		!(await publicTargetExists(context.bucket, key))
	)
		return notFound();
	const lock = await findAccessLock(context.bucket, key);
	if (!lock) return notFound();

	try {
		const outcome = await limitPublicAccess(
			c.req.raw,
			c.env,
			lock.metadata.target,
			"admit",
		);
		if (!outcome.admitted) return notFound();
	} catch {
		return notFound();
	}

	let password: unknown;
	try {
		const body = await c.req.parseBody();
		password = body.password;
	} catch {
		return notFound();
	}
	if (
		typeof password !== "string" ||
		!(await verifyAccessPassword(password, lock.metadata, c.env))
	) {
		return notFound();
	}

	try {
		await limitPublicAccess(c.req.raw, c.env, lock.metadata.target, "clear");
	} catch {
		return notFound();
	}

	const sessionCookie = await createPublicAccessSession(
		c.env,
		lock.metadata.target,
		lock.metadata.authVersion,
	);
	const wantsJson = c.req.header("Accept")?.includes("application/json");
	const response = wantsJson
		? Response.json({ unlocked: true }, { headers: pageHeaders })
		: c.redirect(action, 303);
	response.headers.set("Set-Cookie", sessionCookie);
	for (const [name, value] of Object.entries(pageHeaders))
		response.headers.set(name, value);
	return response;
}

export async function getPublicFile(c: AppContext) {
	const context = getPublicContext(c);
	const key = decodeTarget(c.req.param("key"));
	if (!context || !key || isFolderTarget(key)) return notFound();
	if (!isPublicObjectKey(key, context.config.prefix || "")) return notFound();
	const object = await context.bucket.head(key);
	if (!object) return notFound();

	const lock = await findAccessLock(context.bucket, key);
	if (lock && !(await sessionMatches(c.req.raw, c.env, lock))) {
		return page("Locked file", `/public/file/${encodeObjectKey(key)}/unlock`);
	}
	return (await createPublicDownloadTransfer(c, key, lock)) || notFound();
}

export async function unlockPublicFile(c: AppContext) {
	const key = decodeTarget(c.req.param("key"));
	if (!key || isFolderTarget(key)) return notFound();
	return unlock(c, key, `/public/file/${encodeObjectKey(key)}`);
}

export async function getPublicFolder(c: AppContext) {
	const context = getPublicContext(c);
	const key = decodeTarget(c.req.param("key"));
	if (!context || !key || !isFolderTarget(key)) return notFound();
	if (!isPublicObjectKey(key, context.config.prefix || "")) return notFound();
	if (!(await publicTargetExists(context.bucket, key))) return notFound();

	const lock = await findAccessLock(context.bucket, key);
	if (lock && !(await sessionMatches(c.req.raw, c.env, lock))) {
		return page(
			"Locked folder",
			`/public/folder/${encodeObjectKey(key)}/unlock`,
		);
	}
	return dashboardAssetRequest(c);
}

export async function unlockPublicFolder(c: AppContext) {
	const key = decodeTarget(c.req.param("key"));
	if (!key || !isFolderTarget(key)) return notFound();
	return unlock(c, key, `/public/folder/${encodeObjectKey(key)}`);
}
