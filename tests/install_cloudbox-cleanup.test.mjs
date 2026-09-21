import assert from "node:assert/strict";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	DEFAULT_SOURCE_REF,
	REMOTE_MJS_REF,
	cleanupLocalState,
	cleanupManagedTarget,
	cleanupMjsCache,
	cleanupSetupNamespace,
	ensureSetupNamespace,
	makeSecrets,
	runWorkflow,
} from "../scripts/install_cloudbox.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const secrets = makeSecrets({
	adminPath: "admin",
	username: "user",
	password: "password",
});

async function exists(target) {
	return access(target).then(
		() => true,
		() => false,
	);
}

function managedTarget(cwd, token = "a".repeat(64), ref = DEFAULT_SOURCE_REF) {
	return {
		cwd,
		target: path.join(cwd, `cloudbox-r2-${ref.slice(0, 12)}`),
		ref,
		marker: token,
	};
}

async function writeManagedTarget(value) {
	await mkdir(value.target, { recursive: true });
	await writeFile(
		path.join(value.target, ".cloudbox-r2-bootstrap-managed.json"),
		JSON.stringify({
			kind: "cloudbox-r2-bootstrap-target-v1",
			ref: value.ref,
			target: value.target,
			token: value.marker,
		}),
		{ mode: 0o600 },
	);
}

function canonicalConfig() {
	return `name = "cloudbox-r2"
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
bucket_name = "cloudbox-r2"
`;
}

async function workflowRoot() {
	const root = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-cleanup-workflow-"),
	);
	await writeFile(path.join(root, "wrangler.toml"), canonicalConfig());
	await mkdir(path.join(root, ".wrangler"), { recursive: true });
	await writeFile(path.join(root, ".wrangler", "keep.state"), "preserve");
	return root;
}

async function runMockWorkflow(root, failureStage = null) {
	return runWorkflow({
		root,
		apiToken: "test-token",
		pnpm: { command: "pnpm", args: [] },
		workerName: "cleanup-worker",
		bucketName: "cleanup-bucket",
		accountId,
		secrets,
		run: async () => ({ code: 0, stdout: "", stderr: "" }),
		wranglerRunner: async (args) => {
			if (args[0] === "deploy" && args.includes("--dry-run"))
				return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "deployments")
				return { code: 1, stdout: JSON.stringify({ code: 10007 }), stderr: "" };
			if (args[0] === "r2" && args[2] === "info")
				return { code: 1, stdout: "", stderr: "API error code: 10006" };
			if (failureStage === "bucket" && args[0] === "r2")
				return { code: 1, stdout: "", stderr: "bucket failed" };
			if (failureStage === "secret" && args[0] === "secret")
				return { code: 1, stdout: "", stderr: "secret failed" };
			if (failureStage === "deploy" && args[0] === "deploy")
				return { code: 1, stdout: "", stderr: "deploy failed" };
			if (args[0] === "r2") return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "secret") return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "deploy")
				return {
					code: 0,
					stdout: "https://cleanup-worker.account.workers.dev",
					stderr: "",
				};
			throw new Error(`unexpected ${args.join(" ")}`);
		},
		confirm: async () => true,
		fetchImpl: async () =>
			new Response("<title>Cloudbox</title>", { status: 200 }),
	});
}

test("successful managed target cleanup removes only the marked source copy", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "cloudbox-cleanup-target-"));
	try {
		const target = managedTarget(cwd);
		await writeManagedTarget(target);
		await writeFile(path.join(target.target, "keep.txt"), "generated");
		assert.equal(await cleanupManagedTarget(target), true);
		assert.equal(await exists(target.target), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("existing same-name target without this-call marker is preserved", async () => {
	const cwd = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-cleanup-existing-"),
	);
	try {
		const target = managedTarget(cwd);
		await mkdir(target.target);
		await writeFile(path.join(target.target, "keep.txt"), "user");
		await assert.rejects(() => cleanupManagedTarget(target), /标记缺失或无效/);
		assert.equal(
			await readFile(path.join(target.target, "keep.txt"), "utf8"),
			"user",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("managed target cleanup rejects paths outside the bootstrap cwd", async () => {
	const cwd = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-cleanup-boundary-"),
	);
	const outside = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-cleanup-outside-"),
	);
	try {
		const target = managedTarget(cwd);
		target.target = path.join(outside, "cloudbox-r2-owned");
		await mkdir(target.target);
		await assert.rejects(() => cleanupManagedTarget(target), /越出本次 cwd/);
		assert.equal(await exists(target.target), true);
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("cleanup refuses symlink targets, setup namespaces, and MJS caches", async () => {
	const cwd = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-cleanup-symlink-"),
	);
	const outside = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-cleanup-symlink-outside-"),
	);
	try {
		const target = managedTarget(cwd);
		await symlink(outside, target.target);
		await assert.rejects(() => cleanupManagedTarget(target), /普通目录/);
		assert.equal(await exists(outside), true);

		const setupRoot = path.join(cwd, ".wrangler");
		await mkdir(setupRoot);
		await symlink(outside, path.join(setupRoot, "setup"));
		await assert.rejects(() => cleanupSetupNamespace(cwd), /普通目录/);

		const cacheDirectory = path.join(cwd, "cache", "cloudbox-r2");
		const cachePath = path.join(
			cacheDirectory,
			`install_cloudbox-${REMOTE_MJS_REF}.mjs`,
		);
		await mkdir(cacheDirectory, { recursive: true });
		await symlink(path.join(outside, "payload"), cachePath);
		await assert.rejects(
			() =>
				cleanupMjsCache({
					scriptPath: cachePath,
					env: { XDG_CACHE_HOME: path.join(cwd, "cache") },
				}),
			/普通文件/,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("workflow success cleanup removes setup namespace but preserves repo state", async () => {
	const root = await workflowRoot();
	try {
		await runMockWorkflow(root);
		const warnings = await cleanupLocalState({ root });
		assert.deepEqual(warnings, []);
		assert.equal(await exists(path.join(root, ".wrangler", "setup")), false);
		assert.equal(
			await exists(path.join(root, ".wrangler", "keep.state")),
			true,
		);
		assert.equal(await exists(path.join(root, "wrangler.toml")), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("workflow failures after bucket or secret partial writes still clean local setup", async () => {
	for (const failureStage of ["bucket", "secret", "deploy"]) {
		const root = await workflowRoot();
		try {
			await assert.rejects(() => runMockWorkflow(root, failureStage));
			const warnings = await cleanupLocalState({ root });
			assert.deepEqual(warnings, [], failureStage);
			assert.equal(
				await exists(path.join(root, ".wrangler", "setup")),
				false,
				failureStage,
			);
			assert.equal(
				await exists(path.join(root, ".wrangler", "keep.state")),
				true,
				failureStage,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
});

test("repo mode keeps the complete source tree while removing only setup namespace", async () => {
	const root = await workflowRoot();
	try {
		await ensureSetupNamespace(root);
		await cleanupSetupNamespace(root);
		assert.equal(await exists(path.join(root, "wrangler.toml")), true);
		assert.equal(
			await exists(path.join(root, ".wrangler", "keep.state")),
			true,
		);
		assert.equal(await exists(path.join(root, ".wrangler", "setup")), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("fixed remote MJS cache cleanup removes only the current fixed payload", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "cloudbox-cleanup-cache-"));
	const cacheDirectory = path.join(home, ".cache", "cloudbox-r2");
	const cachePath = path.join(
		cacheDirectory,
		`install_cloudbox-${REMOTE_MJS_REF}.mjs`,
	);
	const otherPath = path.join(cacheDirectory, "other-payload.mjs");
	try {
		await mkdir(cacheDirectory, { recursive: true });
		await writeFile(cachePath, "fixed payload");
		await writeFile(otherPath, "preserve");
		assert.equal(
			await cleanupMjsCache({
				scriptPath: await realpath(cachePath),
				env: { HOME: home },
			}),
			true,
		);
		assert.equal(await exists(cachePath), false);
		assert.equal(await exists(otherPath), true);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("cleanup failures return sanitized warnings without masking the primary operation", async () => {
	const root = await workflowRoot();
	try {
		await ensureSetupNamespace(root);
		const warnings = await cleanupLocalState({
			root,
			rmImpl: async () => {
				throw new Error("CLOUDFLARE_API_TOKEN=must-not-leak");
			},
		});
		assert.deepEqual(warnings, ["setup 临时目录"]);
		assert.equal(warnings.join(" ").includes("CLOUDFLARE"), false);
		assert.equal(await exists(path.join(root, ".wrangler", "setup")), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
