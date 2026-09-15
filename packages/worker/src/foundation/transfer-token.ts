import type { AppEnv } from "../types";
import { TRANSFER_TTL_SECONDS, requireSecret } from "./session";
import { resolveTransferStoreName, rotateTransfer } from "./transfer-registry";
import type { TransferState } from "./transfer-store";
import { rotateTransferTokenHash } from "./transfer-store";

const TOKEN_BYTES = 32;
const encoder = new TextEncoder();

function encodeBase64Url(value: Uint8Array) {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

export function createTransferToken() {
	return encodeBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

async function tokenName(token: string, secret: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			key,
			encoder.encode(JSON.stringify(["cloudbox-r2/transfer/v1", token])),
		),
	);
	return encodeBase64Url(digest);
}

export function isTransferToken(value: string) {
	return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export async function transferStoreName(env: AppEnv, token: string) {
	if (!isTransferToken(token)) throw new Error("Invalid transfer token");
	return tokenName(token, requireSecret(env, "TRANSFER_SESSION_SECRET"));
}

export async function transferStub(env: AppEnv, token: string) {
	const namespace = env.TRANSFER_STORE;
	if (!namespace) throw new Error("Transfer store unavailable");
	const directName = await transferStoreName(env, token);
	if (env.TRANSFER_REGISTRY) {
		const resolvedName = await resolveTransferStoreName(env, directName);
		if (resolvedName) return namespace.getByName(resolvedName);
	}
	return namespace.getByName(directName);
}

export async function rotateTransferToken(env: AppEnv, storeName: string) {
	const token = createTransferToken();
	const tokenHash = await transferStoreName(env, token);
	await rotateTransfer(env, storeName, tokenHash);
	const namespace = env.TRANSFER_STORE;
	if (!namespace) throw new Error("Transfer store unavailable");
	await rotateTransferTokenHash(namespace.getByName(storeName), tokenHash);
	return token;
}

export async function createTransfer(
	env: AppEnv,
	state: Omit<TransferState, "createdAt" | "expiresAt" | "status">,
	token = createTransferToken(),
) {
	const createdAt = Date.now();
	const expiresAt = createdAt + TRANSFER_TTL_SECONDS * 1000;
	const storeName = await transferStoreName(env, token);
	const transferState: TransferState = {
		...state,
		createdAt,
		expiresAt,
		status: "active",
		generation: state.generation || 0,
		registryStoreName: state.registryStoreName || storeName,
		tokenHash: state.tokenHash || storeName,
		retentionUntil: expiresAt + TRANSFER_TTL_SECONDS * 1000,
	};
	const namespace = env.TRANSFER_STORE;
	if (!namespace) throw new Error("Transfer store unavailable");
	const stub = namespace.getByName(storeName);
	const response = await stub.fetch("https://transfer/create", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operation: "create", state: transferState }),
	});
	if (!response.ok) throw new Error("Unable to create transfer");
	await response.arrayBuffer();
	return {
		token,
		expiresAt,
		stub,
		storeName,
		state: transferState,
	};
}
