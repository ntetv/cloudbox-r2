import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	WRANGLER_SAFE_ENV,
	runCommand,
	runWorkflow,
	validateApiToken,
	wrangler,
} from "../scripts/setup-cloudflare.mjs";

const pnpm = { command: process.execPath, args: ["fake-pnpm.cjs"] };
const secrets = {
	CLOUDBOX_R2_ADMIN_PATH: "admin",
	ADMIN_USERNAME: "user",
	ADMIN_PASSWORD: "password",
	ADMIN_SESSION_SECRET: "a",
	PUBLIC_ACCESS_SESSION_SECRET: "b",
	PUBLIC_ACCESS_PASSWORD_PEPPER: "c",
	TRANSFER_SESSION_SECRET: "d",
};

async function preflightRunner(args) {
	if (args[0] === "deploy" && args.includes("--dry-run"))
		return { code: 0, stdout: "", stderr: "" };
	if (args[0] === "deployments")
		return { code: 1, stdout: JSON.stringify({ code: 10007 }), stderr: "" };
	if (args[0] === "r2" && args[2] === "info")
		return { code: 1, stdout: "", stderr: "API error code: 10006" };
	return { code: 0, stdout: "", stderr: "" };
}

test("Wrangler subprocesses use non-debug sanitized logging", () => {
	assert.equal(WRANGLER_SAFE_ENV.WRANGLER_LOG, "info");
	assert.equal(WRANGLER_SAFE_ENV.WRANGLER_LOG_SANITIZE, "true");
	assert.match(WRANGLER_SAFE_ENV.WRANGLER_LOG_PATH, /wrangler-private\.log$/);
});

test("workflow defaults to refusal before any write", async () => {
	const writes = [];
	const result = await runWorkflow({
		apiToken: "test-token",
		pnpm,
		workerName: "default-no",
		bucketName: "default-no",
		accountId: "0123456789abcdef0123456789abcdef",
		secrets,
		run: async () => ({ code: 0, stdout: "", stderr: "" }),
		wranglerRunner: async (args, options) => {
			if (
				!(
					args[0] === "deployments" ||
					args[0] === "r2" ||
					(args[0] === "deploy" && args.includes("--dry-run"))
				)
			)
				writes.push({ args, options });
			return preflightRunner(args, options);
		},
	});
	assert.deepEqual(result.completed, []);
	assert.equal(writes.length, 0);
});

test("workflow rejects timed out code-zero commands before cloud writes", async () => {
	const writes = [];
	await assert.rejects(
		() =>
			runWorkflow({
				apiToken: "test-token",
				pnpm,
				workerName: "timeout-worker",
				bucketName: "timeout-bucket",
				accountId: "0123456789abcdef0123456789abcdef",
				secrets,
				run: async () => ({
					code: 0,
					stdout: "",
					stderr: "",
					timedOut: true,
				}),
				wranglerRunner: async (args) => {
					writes.push(args);
					return { code: 0, stdout: "", stderr: "" };
				},
			}),
		/超时/,
	);
	assert.deepEqual(writes, []);
});

test("workflow treats output truncation as a safe failure before cloud writes", async () => {
	const writes = [];
	await assert.rejects(
		() =>
			runWorkflow({
				apiToken: "test-token",
				pnpm,
				workerName: "flood-worker",
				bucketName: "flood-bucket",
				accountId: "0123456789abcdef0123456789abcdef",
				secrets,
				run: async () => ({
					code: 0,
					stdout: "x".repeat(1024),
					stderr: "",
					stdoutTruncated: true,
				}),
				wranglerRunner: async (args) => {
					writes.push(args);
					return { code: 0, stdout: "", stderr: "" };
				},
			}),
		/输出超过上限/,
	);
	assert.deepEqual(writes, []);
});

test("runCommand hard-kills a child that ignores SIGTERM", async () => {
	const result = await runCommand(
		process.execPath,
		["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
		{ capture: true, timeoutMs: 20, killGraceMs: 20 },
	);
	assert.equal(result.timedOut, true);
	assert.equal(result.signal, "SIGKILL");
});

test("runCommand keeps the hard deadline when SIGTERM exits with code zero", async () => {
	const result = await runCommand(
		process.execPath,
		[
			"-e",
			"process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
		],
		{ capture: true, timeoutMs: 20, killGraceMs: 20 },
	);
	assert.equal(result.timedOut, true);
	assert.ok(result.code === 0 || result.code === null);
	assert.equal(result.signal, "SIGKILL");
});

test("runCommand kills descendants that retain captured stdio", async () => {
	const childScript = [
		"const { spawn } = require('node:child_process');",
		"spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
		"process.on('SIGTERM', () => process.exit(0));",
		"setInterval(() => {}, 1000);",
	].join(" ");
	const result = await runCommand(process.execPath, ["-e", childScript], {
		capture: true,
		timeoutMs: 20,
		killGraceMs: 20,
	});
	assert.equal(result.timedOut, true);
	assert.equal(result.signal, "SIGKILL");
});

test("runCommand hard-stops captured output overflow", async () => {
	const result = await runCommand(
		process.execPath,
		["-e", "process.stdout.write('x'.repeat(10_000_000))"],
		{
			capture: true,
			maxOutputBytes: 1024,
			timeoutMs: 5_000,
			killGraceMs: 20,
		},
	);
	assert.equal(result.stdoutTruncated, true);
	assert.equal(Buffer.byteLength(result.stdout), 1024);
});

test("API token is isolated to Wrangler env and parent auth conflicts cannot override it", async () => {
	const seen = [];
	const token = "fake-token-only-in-wrangler";
	assert.equal(validateApiToken(token), token);
	const saved = {
		CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
		CLOUDFLARE_API_KEY: process.env.CLOUDFLARE_API_KEY,
		CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
	};
	Object.assign(process.env, {
		CLOUDFLARE_API_TOKEN: "parent-token",
		CLOUDFLARE_API_KEY: "parent-key",
		CLOUDFLARE_ACCOUNT_ID: "parent-account",
	});
	try {
		await runWorkflow({
			pnpm,
			workerName: "env-worker",
			bucketName: "env-bucket",
			accountId: "0123456789abcdef0123456789abcdef",
			apiToken: token,
			secrets,
			run: async (_command, _args, options) => {
				assert.ok(options.env);
				assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
				return { code: 0, stdout: "", stderr: "" };
			},
			wranglerRunner: async (args, options) => {
				seen.push({ args, env: options.env });
				if (args[0] === "deploy" && args.includes("--dry-run"))
					return { code: 0, stdout: "", stderr: "" };
				if (args[0] === "deployments")
					return {
						code: 1,
						stdout: JSON.stringify({ code: 10007 }),
						stderr: "",
					};
				if (args[0] === "r2" && args[2] === "info")
					return { code: 1, stdout: "", stderr: "API error code: 10006" };
				return { code: 0, stdout: "", stderr: "" };
			},
		});
		assert.ok(seen.length > 0);
		for (const { env } of seen) {
			assert.equal(env.CLOUDFLARE_API_TOKEN, token);
			assert.equal(
				env.CLOUDFLARE_ACCOUNT_ID,
				"0123456789abcdef0123456789abcdef",
			);
			assert.equal(env.CLOUDFLARE_API_KEY, undefined);
		}
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("actual Wrangler spawn env excludes parent and override auth conflicts", async () => {
	const saved = {
		CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
		CLOUDFLARE_API_BASE_URL: process.env.CLOUDFLARE_API_BASE_URL,
		CLOUDFLARE_API_KEY: process.env.CLOUDFLARE_API_KEY,
		CF_API_TOKEN: process.env.CF_API_TOKEN,
	};
	Object.assign(process.env, {
		CLOUDFLARE_API_TOKEN: "parent-token",
		CLOUDFLARE_API_BASE_URL: "https://evil.invalid",
		CLOUDFLARE_API_KEY: "parent-key",
		CF_API_TOKEN: "parent-cf-token",
	});
	let spawned;
	try {
		await wrangler(["--version"], {
			env: {
				CLOUDFLARE_API_TOKEN: "trusted-token",
				CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
				CLOUDFLARE_API_BASE_URL: "https://evil.invalid",
				CLOUDFLARE_API_KEY: "override-key",
			},
			run: async (_command, _args, options) => {
				spawned = options.env;
				return { code: 0, stdout: "", stderr: "" };
			},
		});
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
	assert.equal(spawned.CLOUDFLARE_API_TOKEN, "trusted-token");
	assert.equal(
		spawned.CLOUDFLARE_ACCOUNT_ID,
		"0123456789abcdef0123456789abcdef",
	);
	assert.equal(spawned.CLOUDFLARE_API_BASE_URL, undefined);
	assert.equal(spawned.CLOUDFLARE_API_KEY, undefined);
	assert.equal(spawned.CF_API_TOKEN, undefined);
});
