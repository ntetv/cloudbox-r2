import type { AppEnv } from "../types";

const STATE_KEY = "registry";
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;

export type RegistryRecord = {
	storeName: string;
	tokenHash: string;
	bucket: string;
	key: string;
	size?: number;
	fileName?: string;
	lastModified?: number;
	sha256?: string;
	partSize?: number;
	createdAt: number;
	expiresAt: number;
	retentionUntil?: number;
	status: "reserved" | "active" | "terminal";
	terminalStatus?:
		| "completed"
		| "cancelled"
		| "expired"
		| "conflict"
		| "failed";
};

type RegistryState = {
	records: Record<string, RegistryRecord>;
};

type RegistryOperation =
	| { operation: "reserve"; record: RegistryRecord }
	| { operation: "activate"; storeName: string; record: RegistryRecord }
	| {
			operation: "remove";
			storeName: string;
			terminalStatus?: RegistryRecord["terminalStatus"];
	  }
	| { operation: "resolve"; tokenHash: string }
	| { operation: "rotate"; storeName: string; tokenHash: string }
	| {
			operation: "find";
			bucket: string;
			key: string;
			size: number;
			sha256?: string;
	  }
	| { operation: "list" }
	| { operation: "cleanup"; limit: number };

function response(data: unknown, status = 200) {
	return Response.json(data, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

function emptyState(): RegistryState {
	return { records: {} };
}

function isActive(record: RegistryRecord) {
	return ["reserved", "active"].includes(record.status);
}

export class TransferRegistry implements DurableObject {
	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: AppEnv,
	) {}

	async fetch(request: Request) {
		let input: RegistryOperation;
		try {
			input = (await request.json()) as RegistryOperation;
		} catch {
			return response({ message: "Invalid transfer registry request" }, 400);
		}
		const state =
			(await this.ctx.storage.get<RegistryState>(STATE_KEY)) || emptyState();
		if (input.operation === "reserve") return this.reserve(state, input.record);
		if (input.operation === "activate") return this.activate(state, input);
		if (input.operation === "remove")
			return this.remove(state, input.storeName, input.terminalStatus);
		if (input.operation === "resolve")
			return this.resolve(state, input.tokenHash);
		if (input.operation === "rotate")
			return this.rotate(state, input.storeName, input.tokenHash);
		if (input.operation === "find") return this.find(state, input);
		if (input.operation === "list") return this.list(state);
		if (input.operation === "cleanup") return this.cleanup(state, input.limit);
		return response({ message: "Invalid transfer registry request" }, 400);
	}

	private async reserve(state: RegistryState, record: RegistryRecord) {
		const now = Date.now();
		for (const [storeName, item] of Object.entries(state.records)) {
			if (isActive(item) && item.expiresAt <= now)
				delete state.records[storeName];
		}
		const destination = Object.values(state.records).find(
			(item) =>
				isActive(item) &&
				item.bucket === record.bucket &&
				item.key === record.key &&
				item.expiresAt > now,
		);
		if (destination) return response({ message: "Upload already exists" }, 409);
		state.records[record.storeName] = { ...record, status: "reserved" };
		await this.ctx.storage.put(STATE_KEY, state);
		return response({ reserved: true });
	}

	private async activate(
		state: RegistryState,
		input: Extract<RegistryOperation, { operation: "activate" }>,
	) {
		const current = state.records[input.storeName];
		if (!current || current.status !== "reserved")
			return response({ message: "Reservation not found" }, 404);
		state.records[input.storeName] = { ...input.record, status: "active" };
		await this.ctx.storage.put(STATE_KEY, state);
		return response({ active: true });
	}

	private async remove(
		state: RegistryState,
		storeName: string,
		terminalStatus: RegistryRecord["terminalStatus"] = "failed",
	) {
		const record = state.records[storeName];
		if (!record) return response({ removed: true });
		state.records[storeName] = {
			...record,
			status: "terminal",
			terminalStatus,
			retentionUntil: Date.now() + TERMINAL_RETENTION_MS,
		};
		await this.ctx.storage.put(STATE_KEY, state);
		return response({ removed: true });
	}

	private async resolve(state: RegistryState, tokenHash: string) {
		const record = Object.values(state.records).find(
			(item) => item.tokenHash === tokenHash,
		);
		if (!record) return response({ message: "Transfer not found" }, 404);
		return response({ storeName: record.storeName });
	}

	private async rotate(
		state: RegistryState,
		storeName: string,
		tokenHash: string,
	) {
		const record = state.records[storeName];
		if (!record || !isActive(record))
			return response({ message: "Transfer not found" }, 404);
		if (
			Object.values(state.records).some((item) => item.tokenHash === tokenHash)
		)
			return response({ message: "Transfer token collision" }, 409);
		record.tokenHash = tokenHash;
		await this.ctx.storage.put(STATE_KEY, state);
		return response({ rotated: true });
	}

	private async find(
		state: RegistryState,
		input: Extract<RegistryOperation, { operation: "find" }>,
	) {
		const match = Object.values(state.records).find(
			(record) =>
				record.status === "active" &&
				record.expiresAt > Date.now() &&
				record.bucket === input.bucket &&
				record.key === input.key &&
				record.size === input.size &&
				(!input.sha256 || record.sha256 === input.sha256),
		);
		return response({ record: match || null });
	}

	private async list(state: RegistryState) {
		const records = Object.values(state.records).filter(
			(record) => record.status === "active",
		);
		return response({ records });
	}

	private async cleanup(state: RegistryState, limit: number) {
		const now = Date.now();
		const candidates = Object.values(state.records)
			.filter(
				(record) =>
					(record.status === "active" && record.expiresAt <= now) ||
					(record.status === "terminal" && (record.retentionUntil || 0) <= now),
			)
			.slice(0, Math.max(1, Math.min(limit, 100)));
		const reaped: string[] = [];
		const stale: string[] = [];
		const failed: string[] = [];
		for (const record of candidates) {
			if (record.status === "terminal") {
				delete state.records[record.storeName];
				stale.push(record.storeName);
				continue;
			}
			const namespace = this.env.TRANSFER_STORE;
			if (!namespace) {
				failed.push(record.storeName);
				continue;
			}
			try {
				const result = await namespace
					.getByName(record.storeName)
					.fetch("https://transfer/reap", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ operation: "reap" }),
					});
				if (!result.ok && result.status !== 404) {
					failed.push(record.storeName);
					continue;
				}
				state.records[record.storeName] = {
					...record,
					status: "terminal",
					terminalStatus: "expired",
					retentionUntil: now + TERMINAL_RETENTION_MS,
				};
				reaped.push(record.storeName);
				await result.arrayBuffer();
			} catch {
				failed.push(record.storeName);
			}
		}
		await this.ctx.storage.put(STATE_KEY, state);
		return response({ eligible: candidates.length, reaped, stale, failed });
	}
}

async function registryStub(env: AppEnv) {
	if (!env.TRANSFER_REGISTRY) throw new Error("Transfer registry unavailable");
	return env.TRANSFER_REGISTRY.getByName("cloudbox-r2-transfer-registry");
}

async function registryRequest(env: AppEnv, operation: RegistryOperation) {
	const result = await (await registryStub(env)).fetch(
		"https://transfer-registry/operation",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(operation),
		},
	);
	if (!result.ok) {
		const body = (await result.json().catch(() => ({}))) as {
			message?: string;
		};
		throw new Error(body.message || "Transfer registry unavailable");
	}
	return result.json();
}

export function transferRegistryStub(env: AppEnv) {
	return registryStub(env);
}

export function reserveTransfer(env: AppEnv, record: RegistryRecord) {
	return registryRequest(env, { operation: "reserve", record });
}

export function activateTransfer(
	env: AppEnv,
	storeName: string,
	record: RegistryRecord,
) {
	return registryRequest(env, { operation: "activate", storeName, record });
}

export function removeTransfer(
	env: AppEnv,
	storeName: string,
	terminalStatus: RegistryRecord["terminalStatus"] = "failed",
) {
	return registryRequest(env, {
		operation: "remove",
		storeName,
		terminalStatus,
	});
}

export async function resolveTransferStoreName(env: AppEnv, tokenHash: string) {
	const result = await (await registryStub(env)).fetch(
		"https://transfer-registry/resolve",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ operation: "resolve", tokenHash }),
		},
	);
	if (result.status === 404) {
		await result.arrayBuffer();
		return null;
	}
	if (!result.ok) throw new Error("Transfer registry unavailable");
	return ((await result.json()) as { storeName: string }).storeName;
}

export function rotateTransfer(
	env: AppEnv,
	storeName: string,
	tokenHash: string,
) {
	return registryRequest(env, { operation: "rotate", storeName, tokenHash });
}

export function findTransfer(
	env: AppEnv,
	bucket: string,
	key: string,
	size: number,
	sha256?: string,
) {
	return registryRequest(env, { operation: "find", bucket, key, size, sha256 });
}

export function listTransfers(env: AppEnv) {
	return registryRequest(env, { operation: "list" });
}

export function cleanupTransfers(env: AppEnv, limit = 50) {
	return registryRequest(env, { operation: "cleanup", limit });
}
