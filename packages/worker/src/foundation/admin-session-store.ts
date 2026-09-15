import type { AppEnv } from "../types";

const STATE_KEY = "state";

type AdminSessionState = {
	expiresAt: number;
	retentionUntil: number;
	revokedAt?: number;
};

type AdminSessionStoreInput = {
	operation?: unknown;
	expiresAt?: unknown;
	retentionUntil?: unknown;
};

export type AdminSessionStoreOutcome = {
	active: boolean;
};

export class AdminSessionStore implements DurableObject {
	constructor(
		private readonly ctx: DurableObjectState,
		_env: AppEnv,
	) {}

	async fetch(request: Request) {
		let input: AdminSessionStoreInput;
		try {
			input = await request.json();
		} catch {
			return Response.json(
				{ message: "Invalid administrator session request" },
				{ status: 400 },
			);
		}

		if (
			input.operation !== "create" &&
			input.operation !== "verify" &&
			input.operation !== "verify-transfer" &&
			input.operation !== "revoke"
		) {
			return Response.json(
				{ message: "Invalid administrator session request" },
				{ status: 400 },
			);
		}

		const expiresAt =
			typeof input.expiresAt === "number" && Number.isFinite(input.expiresAt)
				? input.expiresAt
				: null;
		const retentionUntil =
			typeof input.retentionUntil === "number" &&
			Number.isFinite(input.retentionUntil)
				? input.retentionUntil
				: null;
		if (input.operation === "create") {
			if (
				expiresAt === null ||
				retentionUntil === null ||
				expiresAt <= Date.now() ||
				retentionUntil < expiresAt
			) {
				return Response.json(
					{ message: "Invalid administrator session request" },
					{ status: 400 },
				);
			}
			await this.ctx.storage.put(STATE_KEY, { expiresAt, retentionUntil });
			await this.ctx.storage.setAlarm(retentionUntil);
			return Response.json({ active: true } satisfies AdminSessionStoreOutcome);
		}
		if (
			input.operation === "verify" &&
			(expiresAt === null || expiresAt <= Date.now())
		) {
			return Response.json(
				{ message: "Invalid administrator session request" },
				{ status: 400 },
			);
		}
		if (
			input.operation === "verify-transfer" &&
			(retentionUntil === null || retentionUntil <= Date.now())
		) {
			return Response.json(
				{ message: "Invalid administrator session request" },
				{ status: 400 },
			);
		}

		if (input.operation === "revoke") {
			const state = await this.ctx.storage.get<AdminSessionState>(STATE_KEY);
			if (state) {
				state.revokedAt = Date.now();
				await this.ctx.storage.put(STATE_KEY, state);
				await this.ctx.storage.setAlarm(state.retentionUntil);
			}
			return Response.json({
				active: false,
			} satisfies AdminSessionStoreOutcome);
		}

		const state = await this.ctx.storage.get<AdminSessionState>(STATE_KEY);
		const active =
			state !== undefined &&
			state.revokedAt === undefined &&
			(input.operation === "verify"
				? state.expiresAt === input.expiresAt && state.expiresAt > Date.now()
				: state.retentionUntil === input.retentionUntil &&
					state.retentionUntil > Date.now());
		return Response.json({ active } satisfies AdminSessionStoreOutcome);
	}

	async alarm() {
		const state = await this.ctx.storage.get<AdminSessionState>(STATE_KEY);
		if (!state || state.retentionUntil <= Date.now()) {
			await this.clear();
			return;
		}

		await this.ctx.storage.setAlarm(state.retentionUntil);
	}

	private async clear() {
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
	}
}
