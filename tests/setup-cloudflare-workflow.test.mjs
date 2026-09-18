import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	makeSecrets,
	runCommand,
	runWorkflow,
} from "../scripts/setup-cloudflare.mjs";

const pnpm = { command: process.execPath, args: ["fake-pnpm.cjs"] };
const secrets = makeSecrets({
	adminPath: "admin",
	username: "user",
	password: "password",
});

async function runDeploymentScenario(deployResult) {
	const stages = [];
	let fetchCalls = 0;
	const result = await runWorkflow({
		apiToken: "test-token",
		pnpm,
		workerName: "scenario-worker",
		bucketName: "scenario-bucket",
		accountId: "0123456789abcdef0123456789abcdef",
		secrets,
		run: async () => ({ code: 0, stdout: "", stderr: "" }),
		wranglerRunner: async (args, options) => {
			if (args[0] === "deploy" && args.includes("--dry-run"))
				return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "deployments")
				return { code: 1, stdout: JSON.stringify({ code: 10007 }), stderr: "" };
			if (args[0] === "r2" && args[2] === "info")
				return { code: 1, stdout: "", stderr: "API error code: 10006" };
			if (args[0] === "r2" && args[2] === "create")
				return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "secret") return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "deploy") return deployResult;
			throw new Error(`unexpected ${args.join(" ")}`);
		},
		confirm: async () => true,
		fetchImpl: async () => {
			fetchCalls += 1;
			return new Response("<title>Cloudbox</title>", { status: 200 });
		},
		onStage: (stage) => stages.push(stage),
	});
	return { result, stages, fetchCalls };
}

test("mock workflow performs dry-run, double preflight, bucket, seven secrets, deploy, and HTTP check", async () => {
	const calls = [];
	const stages = [];
	const result = await runWorkflow({
		apiToken: "test-token",
		pnpm,
		workerName: "mock-worker",
		bucketName: "mock-bucket",
		accountId: "0123456789abcdef0123456789abcdef",
		secrets,
		run: async (command, args, options) => {
			calls.push({ command, args, options });
			return { code: 0, stdout: "", stderr: "" };
		},
		wranglerRunner: async (args, options) => {
			calls.push({ args, options });
			if (args[0] === "deploy" && args.includes("--dry-run"))
				return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "deploy")
				return {
					code: 0,
					stdout: "https://mock-worker.account.workers.dev",
					stderr: "",
				};
			if (args[0] === "deployments")
				return { code: 1, stdout: JSON.stringify({ code: 10007 }), stderr: "" };
			if (args[0] === "r2" && args[2] === "info")
				return { code: 1, stdout: "", stderr: "API error code: 10006" };
			if (args[0] === "r2" && args[2] === "create")
				return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "secret") {
				assert.deepEqual(JSON.parse(options.input), secrets);
				return { code: 0, stdout: "", stderr: "" };
			}
			throw new Error(`unexpected ${args.join(" ")}`);
		},
		confirm: async () => true,
		fetchImpl: async () =>
			new Response("<title>Cloudbox</title>", { status: 200 }),
		onStage: (stage) => stages.push(stage),
	});
	assert.match(result.url, /mock-worker\.account\.workers\.dev/);
	assert.deepEqual(stages, [
		"R2 bucket mock-bucket",
		"七项 secrets",
		"Worker mock-worker",
	]);
	const validationCalls = calls.filter(({ args }) =>
		args?.includes?.("--worker-name"),
	);
	assert.equal(validationCalls.length, 2);
	const configPaths = validationCalls.map(({ args }) => {
		const index = args.indexOf("--config");
		assert.ok(index >= 0);
		assert.ok(path.isAbsolute(args[index + 1]));
		assert.ok(args.includes("mock-worker"));
		assert.ok(args.includes("mock-bucket"));
		return args[index + 1];
	});
	assert.equal(new Set(configPaths).size, 1);
	for (const { options } of validationCalls)
		assert.equal(options.env?.CLOUDFLARE_API_TOKEN, undefined);
	assert.equal(
		calls.filter(({ args }) => args?.[0] === "deployments").length,
		2,
	);
});

test("workflow extracts a workers.dev URL from stderr", async () => {
	const { result, fetchCalls } = await runDeploymentScenario({
		code: 0,
		stdout: "部署完成，但标准输出没有地址",
		stderr: "Published https://scenario-worker.account.workers.dev",
	});
	assert.equal(result.url, "https://scenario-worker.account.workers.dev");
	assert.equal(fetchCalls, 1);
});

test("workflow accepts code-zero deployment without a workers.dev URL", async () => {
	const { result, stages, fetchCalls } = await runDeploymentScenario({
		code: 0,
		stdout: "Worker deployed with a custom domain",
		stderr: "",
	});
	assert.equal(result.url, null);
	assert.equal(fetchCalls, 0);
	assert.ok(stages.includes("Worker scenario-worker"));
});

test("workflow ignores invalid and conflicting deployment URLs", async () => {
	for (const output of [
		"Published https://scenario-worker.example.com",
		"Published https://scenario-worker.account.workers.dev and https://other.account.workers.dev",
	]) {
		const { result, fetchCalls } = await runDeploymentScenario({
			code: 0,
			stdout: output,
			stderr: "",
		});
		assert.equal(result.url, null, output);
		assert.equal(fetchCalls, 0, output);
	}
});

test("mock workflow cancellation performs no writes", async () => {
	const writes = [];
	const result = await runWorkflow({
		apiToken: "test-token",
		pnpm,
		workerName: "cancel-worker",
		bucketName: "cancel-bucket",
		accountId: "0123456789abcdef0123456789abcdef",
		secrets,
		run: async () => ({ code: 0, stdout: "", stderr: "" }),
		wranglerRunner: async (args) => {
			if (args[0] === "deploy" && args.includes("--dry-run"))
				return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "deployments")
				return { code: 1, stdout: JSON.stringify({ code: 10007 }), stderr: "" };
			if (args[0] === "r2" && args[2] === "info")
				return { code: 1, stdout: "", stderr: "API error code: 10006" };
			writes.push(args);
			return { code: 0, stdout: "", stderr: "" };
		},
		confirm: async () => false,
	});
	assert.deepEqual(result.completed, []);
	assert.deepEqual(writes, []);
});

test("workflow uses structural validation for a fixed snapshot validator without dynamic args", async () => {
	const root = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-old-validator-test-"),
	);
	const calls = [];
	try {
		await writeFile(
			path.join(root, "wrangler.toml"),
			`name = "snapshot-worker"
main = "src/index.ts"
assets = { directory = "packages/dashboard/dist" }
[[durable_objects.bindings]]
class_name = "AdminLoginRateLimiter"
class_name = "AdminSessionStore"
class_name = "PublicAccessRateLimiter"
class_name = "AdminLoginSourceRateLimiter"
class_name = "TransferStore"
class_name = "TransferRegistry"
[[migrations]]
tag = "v1-cloudbox-r2"
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "snapshot-bucket"
`,
		);
		await mkdir(path.join(root, "scripts"), { recursive: true });
		await writeFile(
			path.join(root, "scripts/validate-deploy-config.mjs"),
			"throw new Error('old validator should not run with dynamic names');\n",
		);
		const result = await runWorkflow({
			root,
			apiToken: "test-token",
			pnpm,
			workerName: "selected-worker",
			bucketName: "selected-bucket",
			accountId: "0123456789abcdef0123456789abcdef",
			secrets,
			run: async (_command, args) => {
				calls.push(args);
				return { code: 0, stdout: "", stderr: "" };
			},
			wranglerRunner: async (args) => {
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
				throw new Error(`unexpected ${args.join(" ")}`);
			},
			confirm: async () => false,
		});
		assert.deepEqual(result.completed, []);
		assert.deepEqual(calls, [["fake-pnpm.cjs", "build"]]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
