import type { AppEnv } from "../types";

const FAILURE_LIMIT = 5;
const WINDOW_SECONDS = 15 * 60;
const LOCK_SECONDS = 15 * 60;
const STATE_KEY = "state";

type LoginRateLimitState = {
	failures?: number;
	windowExpiresAt?: number;
	lockExpiresAt?: number;
};

export type LoginRateLimitOutcome = {
	locked: boolean;
	retryAfter?: number;
};

export function transitionAdminLoginRateLimit(
	state: LoginRateLimitState | undefined,
	credentialsValid: boolean,
	now: number,
): {
	state?: LoginRateLimitState;
	outcome: LoginRateLimitOutcome;
} {
	if (state?.lockExpiresAt && state.lockExpiresAt > now) {
		return {
			state,
			outcome: {
				locked: true,
				retryAfter: Math.ceil((state.lockExpiresAt - now) / 1000),
			},
		};
	}

	if (
		state?.lockExpiresAt ||
		(state?.windowExpiresAt && state.windowExpiresAt <= now)
	) {
		state = undefined;
	}

	if (credentialsValid) {
		return { outcome: { locked: false } };
	}

	const failures = (state?.failures || 0) + 1;
	if (failures >= FAILURE_LIMIT) {
		const lockExpiresAt = now + LOCK_SECONDS * 1000;
		return {
			state: { lockExpiresAt },
			outcome: { locked: true, retryAfter: LOCK_SECONDS },
		};
	}

	return {
		state: {
			failures,
			windowExpiresAt: state?.windowExpiresAt || now + WINDOW_SECONDS * 1000,
		},
		outcome: { locked: false },
	};
}

export class AdminLoginRateLimiter implements DurableObject {
	constructor(
		private readonly ctx: DurableObjectState,
		_env: AppEnv,
	) {}

	async fetch(request: Request) {
		let input: { credentialsValid?: unknown };
		try {
			input = await request.json();
		} catch {
			return Response.json(
				{ message: "Invalid login rate limit request" },
				{ status: 400 },
			);
		}

		if (typeof input.credentialsValid !== "boolean") {
			return Response.json(
				{ message: "Invalid login rate limit request" },
				{ status: 400 },
			);
		}

		const now = Date.now();
		const state = await this.ctx.storage.get<LoginRateLimitState>(STATE_KEY);
		const result = transitionAdminLoginRateLimit(
			state,
			input.credentialsValid,
			now,
		);

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
		const state = await this.ctx.storage.get<LoginRateLimitState>(STATE_KEY);
		if (!state) return;

		const expiresAt = state.lockExpiresAt || state.windowExpiresAt;
		if (!expiresAt || expiresAt <= Date.now()) {
			await this.ctx.storage.delete(STATE_KEY);
			return;
		}

		await this.ctx.storage.setAlarm(expiresAt);
	}
}
