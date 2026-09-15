import type { AppEnv } from "../types";

const ATTEMPT_LIMIT = 5;
const WINDOW_SECONDS = 15 * 60;
const LOCK_SECONDS = 15 * 60;
const STATE_KEY = "state";

type PublicAccessRateLimitState = {
	attempts?: number;
	windowExpiresAt?: number;
	lockExpiresAt?: number;
};

export type PublicAccessRateLimitOutcome = {
	admitted: boolean;
};

export function transitionPublicAccessRateLimit(
	state: PublicAccessRateLimitState | undefined,
	operation: "admit" | "clear",
	now: number,
): {
	state?: PublicAccessRateLimitState;
	outcome: PublicAccessRateLimitOutcome;
} {
	if (operation === "clear") return { outcome: { admitted: true } };

	if (state?.lockExpiresAt && state.lockExpiresAt > now) {
		return { state, outcome: { admitted: false } };
	}

	const activeState =
		state?.lockExpiresAt ||
		(state?.windowExpiresAt && state.windowExpiresAt <= now)
			? undefined
			: state;
	const attempts = (activeState?.attempts || 0) + 1;
	if (attempts >= ATTEMPT_LIMIT) {
		return {
			state: { lockExpiresAt: now + LOCK_SECONDS * 1000 },
			outcome: { admitted: true },
		};
	}

	return {
		state: {
			attempts,
			windowExpiresAt:
				activeState?.windowExpiresAt || now + WINDOW_SECONDS * 1000,
		},
		outcome: { admitted: true },
	};
}

export class PublicAccessRateLimiter implements DurableObject {
	constructor(
		private readonly ctx: DurableObjectState,
		_env: AppEnv,
	) {}

	async fetch(request: Request) {
		let input: { operation?: unknown };
		try {
			input = await request.json();
		} catch {
			return Response.json(
				{ message: "Invalid public access rate limit request" },
				{ status: 400 },
			);
		}

		if (input.operation !== "admit" && input.operation !== "clear") {
			return Response.json(
				{ message: "Invalid public access rate limit request" },
				{ status: 400 },
			);
		}

		const now = Date.now();
		const state =
			await this.ctx.storage.get<PublicAccessRateLimitState>(STATE_KEY);
		const result = transitionPublicAccessRateLimit(state, input.operation, now);

		if (result.state) {
			await this.ctx.storage.put(STATE_KEY, result.state);
			await this.ctx.storage.setAlarm(
				result.state.lockExpiresAt || result.state.windowExpiresAt || now,
			);
		} else {
			await this.ctx.storage.delete(STATE_KEY);
			await this.ctx.storage.deleteAlarm();
		}

		return Response.json(result.outcome);
	}

	async alarm() {
		const state =
			await this.ctx.storage.get<PublicAccessRateLimitState>(STATE_KEY);
		if (!state) return;

		const expiresAt = state.lockExpiresAt || state.windowExpiresAt;
		if (!expiresAt || expiresAt <= Date.now()) {
			await this.ctx.storage.delete(STATE_KEY);
			return;
		}

		await this.ctx.storage.setAlarm(expiresAt);
	}
}
