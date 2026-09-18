import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	assertMissingResource,
	byteLength,
	deploymentUrl,
	deriveConfig,
	ensurePnpm,
	makeSecrets,
	runCommand,
	secretBulk,
	validateAdminPath,
	validateBucketName,
	validateCanonicalSourceConfig,
	validateDownloadedSourceSnapshot,
	validatePassword,
	validateUsername,
	validateWorkerName,
} from "../scripts/setup-cloudflare.mjs";

test("validates resource names and UTF-8 boundaries", () => {
	assert.equal(validateWorkerName("new-worker"), "new-worker");
	assert.equal(validateWorkerName("bad_name"), null);
	assert.equal(validateBucketName("a"), null);
	assert.equal(validateBucketName("ab"), null);
	assert.equal(validateBucketName("abc"), "abc");
	assert.equal(validateAdminPath("admin"), "admin");
	assert.equal(validateAdminPath("admin_update"), "admin_update");
	assert.equal(validateAdminPath("four"), null);
	assert.equal(validateAdminPath("bad/path"), null);
	assert.equal(validateUsername("你".repeat(86)), null);
	assert.equal(validateUsername("你".repeat(85)), "你".repeat(85));
	assert.equal(validatePassword("密码123", "admin"), "密码123");
	assert.equal(validatePassword("12345", "admin"), null);
	assert.equal(byteLength("密码123"), 9);
});

test("creates seven distinct secrets", () => {
	const secrets = makeSecrets({
		adminPath: "admin",
		username: "user",
		password: "password",
	});
	assert.deepEqual(Object.keys(secrets), [
		"CLOUDBOX_R2_ADMIN_PATH",
		"ADMIN_USERNAME",
		"ADMIN_PASSWORD",
		"ADMIN_SESSION_SECRET",
		"PUBLIC_ACCESS_SESSION_SECRET",
		"PUBLIC_ACCESS_PASSWORD_PEPPER",
		"TRANSFER_SESSION_SECRET",
	]);
	assert.equal(new Set(Object.values(secrets).slice(1)).size, 6);
	const samePath = makeSecrets({
		adminPath: "user",
		username: "user",
		password: "password",
	});
	assert.equal(samePath.CLOUDBOX_R2_ADMIN_PATH, samePath.ADMIN_USERNAME);
	assert.ok(
		Object.values(secrets)
			.slice(3)
			.every((value) => value.length === 64),
	);
});

test("prepares pnpm through npm install only after consent", async () => {
	const calls = [];
	const tool = await ensurePnpm({
		npm: "npm",
		confirmDownload: async () => true,
		run: async (command, args) => {
			calls.push({ command, args });
			return {
				code: 0,
				stdout:
					command === "pnpm"
						? "9.0.0"
						: args.at(-1) === "--version"
							? "9.15.4"
							: "",
				stderr: "",
			};
		},
	});
	assert.equal(tool.command, process.execPath);
	assert.deepEqual(calls[0].args, ["--version"]);
	assert.equal(calls[1].args[0], "install");
	assert.ok(!calls[1].args.includes("--offline"));
	await assert.rejects(
		() =>
			ensurePnpm({
				npm: "npm",
				run: async () => ({ code: 1, stdout: "", stderr: "" }),
			}),
		/未同意下载/,
	);
});

test("only accepts an explicit not-found code during preflight", async () => {
	await assert.doesNotReject(() =>
		assertMissingResource("Worker", [], async () => ({
			code: 1,
			stdout: JSON.stringify({ code: 10007 }),
		})),
	);
	await assert.rejects(
		() =>
			assertMissingResource("Worker", [], async () => ({
				code: 1,
				stdout: "",
			})),
		/未确认不存在/,
	);
	await assert.rejects(
		() =>
			assertMissingResource("Worker", [], async () => ({
				code: 0,
				stdout: "{}",
			})),
		/已存在/,
	);
	await assert.doesNotReject(() =>
		assertMissingResource("R2 bucket", [], async () => ({
			code: 1,
			stdout: "",
			stderr: "API error code: 10006",
		})),
	);
	await assert.rejects(
		() =>
			assertMissingResource("R2 bucket", [], async () => ({
				code: 1,
				stdout: JSON.stringify({ code: 10007 }),
				stderr: "",
			})),
		/未确认不存在/,
	);
});

test("derives config from a custom root Worker and bucket name", async () => {
	const root = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-custom-config-test-"),
	);
	try {
		await writeFile(
			path.join(root, "wrangler.toml"),
			'name = "local-root"\nmain = "src/index.ts"\nassets = { directory = "packages/dashboard/dist" }\n[[durable_objects.bindings]]\nname = "A_BINDING"\nclass_name = "AdminLoginRateLimiter"\nclass_name = "AdminSessionStore"\nclass_name = "PublicAccessRateLimiter"\nclass_name = "AdminLoginSourceRateLimiter"\nclass_name = "TransferStore"\nclass_name = "TransferRegistry"\n[[migrations]]\ntag = "v1-cloudbox-r2"\n[[r2_buckets]]\nbinding = "BUCKET"\nbucket_name = "local-bucket"\n',
		);
		const config = await deriveConfig(
			"selected-worker",
			"selected-bucket",
			"0123456789abcdef0123456789abcdef",
			"custom-root",
			{ root },
		);
		const derived = await readFile(config, "utf8");
		assert.match(derived, /name = "selected-worker"/);
		assert.match(derived, /bucket_name = "selected-bucket"/);
		const validation = await runCommand(
			process.execPath,
			[
				path.resolve("scripts/validate-deploy-config.mjs"),
				"--config",
				config,
				"--worker-name",
				"selected-worker",
				"--bucket-name",
				"selected-bucket",
			],
			{ capture: true },
		);
		assert.equal(validation.code, 0, validation.stderr);
		await assert.doesNotReject(() => validateCanonicalSourceConfig(root));
		await assert.rejects(
			() => validateDownloadedSourceSnapshot(root),
			/Worker 与 bucket 身份/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("derives config without changing the canonical config", async () => {
	const config = await deriveConfig(
		"test-worker",
		"test-bucket",
		"0123456789abcdef0123456789abcdef",
		"node-test",
	);
	const derived = await readFile(config, "utf8");
	assert.match(derived, /account_id = "0123456789abcdef0123456789abcdef"/);
	assert.match(derived, /name = "test-worker"/);
	assert.match(derived, /bucket_name = "test-bucket"/);
	assert.match(derived, /main = ".*src\/index\.ts"/);
	assert.match(derived, /directory = ".*packages\/dashboard\/dist"/);
	await rm(config, { force: true });
});
