import assert from "node:assert/strict";
import test from "node:test";
import { deploymentUrl, secretBulk } from "../scripts/install_cloudbox.mjs";

const validSecrets = {
	CLOUDBOX_R2_ADMIN_PATH: "admin",
	ADMIN_USERNAME: "user",
	ADMIN_PASSWORD: "password",
	ADMIN_SESSION_SECRET: "a".repeat(32),
	PUBLIC_ACCESS_SESSION_SECRET: "b".repeat(32),
	PUBLIC_ACCESS_PASSWORD_PEPPER: "c".repeat(32),
	TRANSFER_SESSION_SECRET: "d".repeat(32),
};

test("secret bulk sends object JSON on stdin and never argv", async () => {
	let call;
	await secretBulk("/tmp/config.toml", validSecrets, async (args, options) => {
		call = { args, options };
		return { code: 0, stdout: "", stderr: "" };
	});
	assert.deepEqual(call.args, [
		"secret",
		"bulk",
		"--config",
		"/tmp/config.toml",
	]);
	assert.deepEqual(JSON.parse(call.options.input), validSecrets);
	assert.equal(call.options.capture, true);
	await assert.rejects(
		() =>
			secretBulk("/tmp/config.toml", validSecrets, async () => ({
				code: 1,
				stdout: "partial failure",
				stderr: "",
			})),
		/上传 secrets 失败/,
	);
});

test("secret bulk validates the complete server-shaped mapping", async () => {
	await assert.rejects(
		() => secretBulk("/tmp/config.toml", { ...validSecrets, EXTRA: "x" }),
		/恰好包含七项/,
	);
	await assert.rejects(
		() =>
			secretBulk("/tmp/config.toml", {
				...validSecrets,
				ADMIN_PASSWORD: 7,
			}),
		/1–1024/,
	);
	await assert.rejects(
		() =>
			secretBulk("/tmp/config.toml", {
				...validSecrets,
				ADMIN_PASSWORD: "x".repeat(1025),
			}),
		/1–1024/,
	);
});

test("deployment URL requires the selected Worker name and exact origin", () => {
	assert.equal(
		deploymentUrl(
			"Uploaded https://new-worker.account.workers.dev",
			"new-worker",
		),
		"https://new-worker.account.workers.dev",
	);
	for (const output of [
		"Uploaded https://other.account.workers.dev",
		"Uploaded https://new-worker.example.com",
		"Uploaded https://new-worker.account_.workers.dev",
		"Uploaded https://new-worker.account.workers.dev:443",
		"Uploaded https://user:pass@new-worker.account.workers.dev",
	])
		assert.throws(() => deploymentUrl(output, "new-worker"), /不是本次 Worker/);
	assert.throws(
		() =>
			deploymentUrl(
				"Uploaded https://new-worker.a.workers.dev and https://new-worker.b.workers.dev",
				"new-worker",
			),
		/多个冲突/,
	);
});

test("optional deployment URL extraction returns null without leaking output", () => {
	const token = "deployment-token-canary";
	const output = `Published ${token} https://new-worker.example.com`;
	assert.equal(deploymentUrl(output, "new-worker", { optional: true }), null);
	assert.throws(
		() => deploymentUrl(output, "new-worker"),
		(error) => {
			assert.doesNotMatch(error.message, new RegExp(token));
			return /不是本次 Worker/.test(error.message);
		},
	);
	assert.equal(
		deploymentUrl(
			`${String.fromCharCode(27)}[32mhttps://new-worker.account.workers.dev${String.fromCharCode(27)}[0m`,
			"new-worker",
		),
		"https://new-worker.account.workers.dev",
	);
});
