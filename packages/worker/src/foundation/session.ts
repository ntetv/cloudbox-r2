import type { MiddlewareHandler } from "hono";
import type { AppContext, AppEnv } from "../types";
import type { LoginRateLimitOutcome } from "./admin-login-rate-limiter";
import type { SourceLoginRateLimitOutcome } from "./admin-login-source-rate-limiter";
import type { AdminSessionStoreOutcome } from "./admin-session-store";
import type { PublicAccessRateLimitOutcome } from "./public-access-rate-limiter";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ADMIN_COOKIE = "__Host-cloudbox-r2-admin";
const PUBLIC_ACCESS_COOKIE = "__Host-cloudbox-r2-public";
const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
const PUBLIC_ACCESS_SESSION_TTL_SECONDS = 15 * 60;
export const TRANSFER_TTL_SECONDS = 24 * 60 * 60;
const MAX_ADMIN_USERNAME_BYTES = 256;
const MIN_ADMIN_PASSWORD_BYTES = 6;
const MAX_ADMIN_PASSWORD_BYTES = 16;
const MIN_SECURITY_SECRET_BYTES = 32;
const securitySecretNames = [
	"ADMIN_USERNAME",
	"ADMIN_PASSWORD",
	"ADMIN_SESSION_SECRET",
	"PUBLIC_ACCESS_SESSION_SECRET",
	"PUBLIC_ACCESS_PASSWORD_PEPPER",
	"TRANSFER_SESSION_SECRET",
] as const;

type AdminSession = {
	role: "admin";
	sessionId: string;
	expiresAt: number;
};

type PublicAccessSession = {
	role: "public-access";
	target: string;
	authVersion: string;
	expiresAt: number;
};

type SessionPayload = AdminSession | PublicAccessSession;

function encodeBase64Url(value: Uint8Array | string) {
	const bytes = typeof value === "string" ? encoder.encode(value) : value;
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

function decodeBase64Url(value: string) {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;

	const padded =
		value.replaceAll("-", "+").replaceAll("_", "/") +
		"=".repeat((4 - (value.length % 4)) % 4);
	try {
		const binary = atob(padded);
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
}

function parseCookies(request: Request) {
	const cookies = new Map<string, string>();
	for (const part of (request.headers.get("Cookie") || "").split(";")) {
		const separator = part.indexOf("=");
		if (separator <= 0) continue;
		cookies.set(
			part.slice(0, separator).trim(),
			part.slice(separator + 1).trim(),
		);
	}
	return cookies;
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
	if (left.length !== right.length) return false;

	let difference = 0;
	for (let index = 0; index < left.length; index++) {
		difference |= left[index] ^ right[index];
	}
	return difference === 0;
}

async function hmac(value: string, secret: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(
		await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
	);
}

export function requireSecret(
	env: AppEnv,
	name: (typeof securitySecretNames)[number],
) {
	const values = securitySecretNames.map((secretName) => {
		const value = env[secretName];
		if (typeof value !== "string" || !value) {
			throw new Error(`Missing Worker secret: ${secretName}`);
		}
		return value;
	});

	const adminPasswordBytes = encoder.encode(values[1]).byteLength;
	if (
		adminPasswordBytes < MIN_ADMIN_PASSWORD_BYTES ||
		adminPasswordBytes > MAX_ADMIN_PASSWORD_BYTES
	) {
		throw new Error("Administrator password must be between 6 and 16 bytes");
	}
	if (
		values
			.slice(2)
			.some(
				(value) => encoder.encode(value).byteLength < MIN_SECURITY_SECRET_BYTES,
			)
	) {
		throw new Error("Worker security secrets must be at least 32 bytes");
	}
	if (new Set(values).size !== values.length) {
		throw new Error("Worker security values must be independent");
	}

	return values[securitySecretNames.indexOf(name)];
}

async function sign(payload: SessionPayload, secret: string) {
	const encodedPayload = encodeBase64Url(JSON.stringify(payload));
	const signature = encodeBase64Url(await hmac(encodedPayload, secret));
	return `${encodedPayload}.${signature}`;
}

async function verify(token: string, secret: string) {
	const [encodedPayload, encodedSignature, ...rest] = token.split(".");
	if (!encodedPayload || !encodedSignature || rest.length) return null;

	const suppliedSignature = decodeBase64Url(encodedSignature);
	if (!suppliedSignature) return null;

	const expectedSignature = await hmac(encodedPayload, secret);
	if (!sameBytes(suppliedSignature, expectedSignature)) return null;

	const payloadBytes = decodeBase64Url(encodedPayload);
	if (!payloadBytes) return null;

	try {
		const payload = JSON.parse(decoder.decode(payloadBytes)) as SessionPayload;
		if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now())
			return null;
		return payload;
	} catch {
		return null;
	}
}

function sessionCookie(
	name: string,
	value: string,
	maxAge: number,
	sameSite: "Lax" | "Strict",
) {
	return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=${sameSite}`;
}

export function hasSameOrigin(request: Request) {
	const origin = request.headers.get("Origin");
	return origin !== null && origin === new URL(request.url).origin;
}

function requestSource(request: Request) {
	const source = request.headers.get("CF-Connecting-IP");
	if (source) return source;
	if (new URL(request.url).hostname === "localhost") return "local-miniflare";
	return null;
}

async function limitAdminLogin(
	request: Request,
	env: AppEnv,
	username: string,
	credentialsValid: boolean,
): Promise<LoginRateLimitOutcome> {
	const source = requestSource(request);
	const limiter = env.ADMIN_LOGIN_RATE_LIMITER;
	if (!source || !limiter)
		throw new Error("Administrator login limiter unavailable");

	const name = encodeBase64Url(
		await hmac(
			JSON.stringify([
				"cloudbox-r2/admin-login-rate-limiter/v1",
				source,
				username,
			]),
			requireSecret(env, "ADMIN_SESSION_SECRET"),
		),
	);
	const response = await limiter
		.getByName(name)
		.fetch("https://rate-limiter/attempt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ credentialsValid }),
		});
	if (!response.ok) throw new Error("Administrator login limiter unavailable");

	const outcome = (await response.json()) as LoginRateLimitOutcome;
	if (
		typeof outcome.locked !== "boolean" ||
		(outcome.retryAfter !== undefined && typeof outcome.retryAfter !== "number")
	) {
		throw new Error("Administrator login limiter unavailable");
	}
	return outcome;
}

async function adminLoginSourceName(request: Request, env: AppEnv) {
	const source = requestSource(request);
	if (!source)
		throw new Error("Administrator source login limiter unavailable");
	return encodeBase64Url(
		await hmac(
			JSON.stringify([
				"cloudbox-r2/admin-login-source-rate-limiter/v1",
				source,
			]),
			requireSecret(env, "ADMIN_SESSION_SECRET"),
		),
	);
}

async function limitAdminLoginSource(
	request: Request,
	env: AppEnv,
	credentialsValid: boolean,
): Promise<SourceLoginRateLimitOutcome> {
	const limiter = env.ADMIN_LOGIN_SOURCE_RATE_LIMITER;
	if (!limiter)
		throw new Error("Administrator source login limiter unavailable");
	const response = await limiter
		.getByName(await adminLoginSourceName(request, env))
		.fetch("https://rate-limiter/attempt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ operation: "attempt", credentialsValid }),
		});
	if (!response.ok)
		throw new Error("Administrator source login limiter unavailable");

	const outcome = (await response.json()) as SourceLoginRateLimitOutcome;
	if (
		typeof outcome.locked !== "boolean" ||
		(outcome.retryAfter !== undefined && typeof outcome.retryAfter !== "number")
	)
		throw new Error("Administrator source login limiter unavailable");
	return outcome;
}

async function clearAdminLoginSource(request: Request, env: AppEnv) {
	const limiter = env.ADMIN_LOGIN_SOURCE_RATE_LIMITER;
	if (!limiter)
		throw new Error("Administrator source login limiter unavailable");
	const response = await limiter
		.getByName(await adminLoginSourceName(request, env))
		.fetch("https://rate-limiter/clear", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ operation: "clear" }),
		});
	if (!response.ok)
		throw new Error("Administrator source login limiter unavailable");

	const outcome = (await response.json()) as SourceLoginRateLimitOutcome;
	if (outcome.locked !== false)
		throw new Error("Administrator source login limiter unavailable");
}

export async function limitPublicAccess(
	request: Request,
	env: AppEnv,
	target: string,
	operation: "admit" | "clear",
): Promise<PublicAccessRateLimitOutcome> {
	const source = requestSource(request);
	const limiter = env.PUBLIC_ACCESS_RATE_LIMITER;
	if (!source || !limiter) throw new Error("Public access limiter unavailable");

	const name = encodeBase64Url(
		await hmac(
			JSON.stringify([
				"cloudbox-r2/public-access-rate-limiter/v1",
				source,
				target,
			]),
			requireSecret(env, "PUBLIC_ACCESS_SESSION_SECRET"),
		),
	);
	const response = await limiter
		.getByName(name)
		.fetch("https://rate-limiter/attempt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ operation }),
		});
	if (!response.ok) throw new Error("Public access limiter unavailable");

	const outcome = (await response.json()) as PublicAccessRateLimitOutcome;
	if (typeof outcome.admitted !== "boolean") {
		throw new Error("Public access limiter unavailable");
	}
	return outcome;
}

function createAdminSessionId() {
	return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function isAdminSession(payload: SessionPayload): payload is AdminSession {
	return (
		payload.role === "admin" &&
		typeof payload.sessionId === "string" &&
		/^[A-Za-z0-9_-]{43}$/.test(payload.sessionId)
	);
}

async function useAdminSessionStore(
	env: AppEnv,
	sessionId: string,
	operation: "create" | "verify" | "verify-transfer" | "revoke",
	expiresAt?: number,
	retentionUntil?: number,
): Promise<AdminSessionStoreOutcome> {
	const store = env.ADMIN_SESSION_STORE;
	if (!store) throw new Error("Administrator session store unavailable");

	const name = encodeBase64Url(
		await hmac(
			JSON.stringify(["cloudbox-r2/admin-session/v1", sessionId]),
			requireSecret(env, "ADMIN_SESSION_SECRET"),
		),
	);
	const response = await store
		.getByName(name)
		.fetch("https://session-store/session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				operation,
				...(expiresAt === undefined ? {} : { expiresAt }),
				...(retentionUntil === undefined ? {} : { retentionUntil }),
			}),
		});
	if (!response.ok) throw new Error("Administrator session store unavailable");

	const outcome = (await response.json()) as AdminSessionStoreOutcome;
	if (typeof outcome.active !== "boolean") {
		throw new Error("Administrator session store unavailable");
	}
	return outcome;
}

export async function createAdminSession(env: AppEnv) {
	const secret = requireSecret(env, "ADMIN_SESSION_SECRET");
	const sessionId = createAdminSessionId();
	const expiresAt = Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000;
	const retentionUntil = expiresAt + TRANSFER_TTL_SECONDS * 1000;
	await useAdminSessionStore(
		env,
		sessionId,
		"create",
		expiresAt,
		retentionUntil,
	);
	return {
		cookie: sessionCookie(
			ADMIN_COOKIE,
			await sign({ role: "admin", sessionId, expiresAt }, secret),
			ADMIN_SESSION_TTL_SECONDS,
			"Strict",
		),
		expiresAt,
	};
}

export async function verifyAdminSession(request: Request, env: AppEnv) {
	const token = parseCookies(request).get(ADMIN_COOKIE);
	if (!token) return null;

	const payload = await verify(
		token,
		requireSecret(env, "ADMIN_SESSION_SECRET"),
	);
	if (!payload || !isAdminSession(payload)) return null;

	const outcome = await useAdminSessionStore(
		env,
		payload.sessionId,
		"verify",
		payload.expiresAt,
	);
	return outcome.active ? payload : null;
}

export async function verifyAdminTransferSession(
	env: AppEnv,
	sessionId: string,
	retentionUntil: number,
) {
	const outcome = await useAdminSessionStore(
		env,
		sessionId,
		"verify-transfer",
		undefined,
		retentionUntil,
	);
	return outcome.active;
}

export async function createPublicAccessSession(
	env: AppEnv,
	target: string,
	authVersion: string,
) {
	const secret = requireSecret(env, "PUBLIC_ACCESS_SESSION_SECRET");
	const expiresAt = Date.now() + PUBLIC_ACCESS_SESSION_TTL_SECONDS * 1000;
	return sessionCookie(
		PUBLIC_ACCESS_COOKIE,
		await sign(
			{ role: "public-access", target, authVersion, expiresAt },
			secret,
		),
		PUBLIC_ACCESS_SESSION_TTL_SECONDS,
		"Lax",
	);
}

export async function verifyPublicAccessSession(request: Request, env: AppEnv) {
	const token = parseCookies(request).get(PUBLIC_ACCESS_COOKIE);
	if (!token) return null;

	const payload = await verify(
		token,
		requireSecret(env, "PUBLIC_ACCESS_SESSION_SECRET"),
	);
	return payload?.role === "public-access" ? payload : null;
}

export async function verifyAdminCredentials(
	env: AppEnv,
	username: string,
	password: string,
) {
	const expectedUsername = requireSecret(env, "ADMIN_USERNAME");
	const expectedPassword = requireSecret(env, "ADMIN_PASSWORD");
	const usernameMatches = sameBytes(
		encoder.encode(username),
		encoder.encode(expectedUsername),
	);
	const passwordMatches = sameBytes(
		encoder.encode(password),
		encoder.encode(expectedPassword),
	);
	return usernameMatches && passwordMatches;
}

export const requireAdminSession: MiddlewareHandler = async (c, next) => {
	let session: AdminSession | null;
	try {
		session = await verifyAdminSession(c.req.raw, c.env as AppEnv);
	} catch {
		return c.json({ message: "Session temporarily unavailable" }, 503, {
			"Cache-Control": "no-store",
		});
	}
	if (!session) return c.json({ message: "Unauthorized" }, 401);

	if (
		!["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
		!hasSameOrigin(c.req.raw)
	) {
		return c.json({ message: "Invalid request origin" }, 403);
	}

	c.set("authentication_type", "session");
	c.set("authentication_username", "admin");
	c.set("authentication_session_id", session.sessionId);
	c.set("authentication_session_expires_at", session.expiresAt);
	await next();
};

export async function login(c: AppContext) {
	if (!hasSameOrigin(c.req.raw))
		return c.json({ message: "Invalid request origin" }, 403);

	let data: unknown;
	try {
		data = await c.req.json();
	} catch {
		return c.json({ message: "Invalid credentials" }, 401);
	}

	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return c.json({ message: "Invalid credentials" }, 401);
	}
	const credentials = data as { username?: unknown; password?: unknown };
	if (
		typeof credentials.username !== "string" ||
		typeof credentials.password !== "string" ||
		encoder.encode(credentials.username).byteLength >
			MAX_ADMIN_USERNAME_BYTES ||
		encoder.encode(credentials.password).byteLength <
			MIN_ADMIN_PASSWORD_BYTES ||
		encoder.encode(credentials.password).byteLength > MAX_ADMIN_PASSWORD_BYTES
	) {
		return c.json({ message: "Invalid credentials" }, 401);
	}

	let credentialsValid: boolean;
	try {
		credentialsValid = await verifyAdminCredentials(
			c.env,
			credentials.username,
			credentials.password,
		);
	} catch {
		return c.json({ message: "Login temporarily unavailable" }, 503, {
			"Cache-Control": "no-store",
		});
	}
	let sourceOutcome: SourceLoginRateLimitOutcome;
	let outcome: LoginRateLimitOutcome;
	try {
		sourceOutcome = await limitAdminLoginSource(
			c.req.raw,
			c.env,
			credentialsValid,
		);
		if (sourceOutcome.locked) {
			return c.json({ message: "Try again later" }, 429, {
				"Cache-Control": "no-store",
				"Retry-After": String(sourceOutcome.retryAfter || 1),
			});
		}
		outcome = await limitAdminLogin(
			c.req.raw,
			c.env,
			credentials.username,
			credentialsValid,
		);
	} catch {
		return c.json({ message: "Login temporarily unavailable" }, 503, {
			"Cache-Control": "no-store",
		});
	}

	if (outcome.locked) {
		return c.json({ message: "Try again later" }, 429, {
			"Cache-Control": "no-store",
			"Retry-After": String(outcome.retryAfter || 1),
		});
	}

	if (!credentialsValid) {
		return c.json({ message: "Invalid credentials" }, 401);
	}

	let session: Awaited<ReturnType<typeof createAdminSession>>;
	try {
		session = await createAdminSession(c.env);
		await clearAdminLoginSource(c.req.raw, c.env);
	} catch {
		return c.json({ message: "Login temporarily unavailable" }, 503, {
			"Cache-Control": "no-store",
		});
	}
	return c.json({ authenticated: true, expiresAt: session.expiresAt }, 200, {
		"Set-Cookie": session.cookie,
		"Cache-Control": "no-store",
	});
}

export async function logout(c: AppContext) {
	const sessionId = c.get("authentication_session_id");
	if (!sessionId) return c.json({ message: "Unauthorized" }, 401);

	try {
		await useAdminSessionStore(c.env, sessionId, "revoke");
	} catch {
		return c.json({ message: "Logout temporarily unavailable" }, 503, {
			"Cache-Control": "no-store",
		});
	}

	return c.json({ authenticated: false }, 200, {
		"Set-Cookie": sessionCookie(ADMIN_COOKIE, "", 0, "Strict"),
		"Cache-Control": "no-store",
	});
}
