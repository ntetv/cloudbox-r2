#!/usr/bin/env node

import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_PACKAGE = path.join(ROOT, "packages/worker/package.json");
const WRANGLER_CONFIG = path.join(ROOT, "wrangler.toml");
const DASHBOARD_DIST = path.join(ROOT, "packages/dashboard/dist");
const DEFAULT_PNPM_CLI = path.join(
	ROOT,
	".wrangler/setup/pnpm/node_modules/pnpm/bin/pnpm.cjs",
);
const DEFAULT_APPLICATION_VERSION = "1.0.0";
const COMPATIBILITY_DATE = "2024-11-06";
const MIGRATION_TAG = "v1-cloudbox-r2";
const MIGRATION_CLASSES = [
	"AdminLoginRateLimiter",
	"AdminSessionStore",
	"PublicAccessRateLimiter",
	"AdminLoginSourceRateLimiter",
	"TransferStore",
	"TransferRegistry",
];
const DURABLE_OBJECT_BINDINGS = [
	["ADMIN_LOGIN_RATE_LIMITER", "AdminLoginRateLimiter"],
	["ADMIN_SESSION_STORE", "AdminSessionStore"],
	["PUBLIC_ACCESS_RATE_LIMITER", "PublicAccessRateLimiter"],
	["ADMIN_LOGIN_SOURCE_RATE_LIMITER", "AdminLoginSourceRateLimiter"],
	["TRANSFER_STORE", "TransferStore"],
	["TRANSFER_REGISTRY", "TransferRegistry"],
];

function fail(message) {
	throw new Error(`build_cloudbox_artifact: ${message}`);
}

function parseArgs(argv) {
	const values = { output: null, sourceCommit: process.env.CLOUDBOX_SOURCE_COMMIT ?? "" };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") {
			printHelp();
			process.exit(0);
		}
		const [name, inlineValue] = argument.split("=", 2);
		if (!["--output", "--source-commit", "--pnpm-cli"].includes(name))
			fail(`不支持的参数：${argument}`);
		const value = inlineValue ?? argv[++index];
		if (!value) fail(`缺少参数值：${name}`);
		if (name === "--output") values.output = path.resolve(process.cwd(), value);
		if (name === "--source-commit") values.sourceCommit = value;
		if (name === "--pnpm-cli") values.pnpmCli = path.resolve(process.cwd(), value);
	}
	if (!values.output) fail("必须提供 --output <artifact-directory>");
	if (path.resolve(values.output) === ROOT || path.dirname(path.resolve(values.output)) === ROOT) {
		fail("artifact 输出目录不能覆盖仓库根目录或根目录直接子目录");
	}
	return values;
}

function printHelp() {
	process.stdout.write(`生成 Cloudbox 固定部署 artifact。\n\n用法：\n  node scripts/build_cloudbox_artifact.mjs --output <目录> [--source-commit <SHA>]\n\n构建阶段会使用现有 pnpm build 和 Wrangler dry-run；不会执行真实 Cloudflare 写入。\n`);
}

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? ROOT,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		const stdout = [];
		const stderr = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.once("error", reject);
		child.once("close", (code, signal) => {
			resolve({
				code,
				signal,
				stdout: Buffer.concat(stdout).toString(),
				stderr: Buffer.concat(stderr).toString(),
			});
		});
	});
}

function printResult(result, label) {
	if (result.stdout.trim()) process.stdout.write(`[${label} stdout]\n${result.stdout}`);
	if (result.stderr.trim()) process.stderr.write(`[${label} stderr]\n${result.stderr}`);
	if (result.code !== 0) fail(`${label} 失败（退出码 ${result.code ?? "unknown"}）。`);
}

async function resolvePnpmCli(explicit) {
	const candidates = [explicit, process.env.CLOUDBOX_PNPM_CLI, DEFAULT_PNPM_CLI].filter(Boolean);
	for (const candidate of candidates) {
		try {
			const info = await stat(candidate);
			if (info.isFile()) return candidate;
		} catch {}
	}
	fail("未找到固定 pnpm CLI；请先完成现有项目依赖准备，或使用 --pnpm-cli 指定 pnpm.cjs。");
}

function resolveWranglerCli() {
	try {
		return require.resolve("wrangler/bin/wrangler.js", {
			paths: [path.join(ROOT, "packages/worker")],
		});
	} catch {
		fail("未找到固定 Wrangler CLI。");
	}
}

function resolveBlake3() {
	try {
		const wrangler = resolveWranglerCli();
		return require(require.resolve("blake3-wasm", { paths: [path.dirname(wrangler)] }));
	} catch {
		fail("未找到 Wrangler 使用的 blake3-wasm，无法生成兼容的 Assets hash。");
	}
}

function nodeExtname(filePath) {
	const basename = path.basename(filePath);
	const dot = basename.lastIndexOf(".");
	if (dot <= 0) return "";
	return basename.slice(dot + 1);
}

function assetHash(blake3, content, filePath) {
	const input = `${content.toString("base64")}${nodeExtname(filePath)}`;
	return blake3.hash(input).toString("hex").slice(0, 32);
}

async function scanArtifact(root) {
	const forbiddenNames = new Set([
		".env",
		".dev.vars",
		".wrangler",
		".git",
		".gitconfig",
	]);
	const forbiddenSuffixes = [".har", ".pem", ".key", ".p12", ".pfx"];
	const sensitivePatterns = [
		/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
		/\b(?:CLOUDFLARE|WRANGLER|CF)_API_TOKEN\b/,
		/\bBearer\s+[A-Za-z0-9._-]{20,}/,
		/(?:^|[/\\])(?:Users|home)[/\\][^/\\]+[/\\]/,
	];
	async function visit(current) {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) fail(`artifact 不允许 symlink：${entry.name}`);
			const absolute = path.join(current, entry.name);
			if (forbiddenNames.has(entry.name) || forbiddenSuffixes.some((suffix) => entry.name.toLowerCase().endsWith(suffix)))
				fail(`artifact 包含禁止文件：${path.relative(root, absolute)}`);
			if (entry.isDirectory()) {
				await visit(absolute);
				continue;
			}
			if (!entry.isFile()) fail(`artifact 包含非普通文件：${path.relative(root, absolute)}`);
			const content = await readFile(absolute);
			if (content.includes(0)) continue;
			const text = content.toString("utf8");
			for (const pattern of sensitivePatterns) {
				if (pattern.test(text)) fail(`artifact 文本包含敏感内容：${path.relative(root, absolute)}`);
			}
		}
	}
	await visit(root);
}

async function listAssets(directory, blake3) {
	const result = {};
	async function visit(current, relativeDirectory = "") {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) fail(`Dashboard artifact 不允许 symlink：${entry.name}`);
			const relative = path.join(relativeDirectory, entry.name);
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) {
				await visit(absolute, relative);
				continue;
			}
			if (!entry.isFile()) fail(`Dashboard artifact 包含非普通文件：${relative}`);
			const content = await readFile(absolute);
			const publicPath = `/${relative.split(path.sep).join("/")}`;
			result[publicPath] = assetHash(blake3, content, relative);
		}
	}
	await visit(directory);
	return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

async function resolveSourceCommit(explicit) {
	if (explicit) return explicit;
	const result = await run("git", ["rev-parse", "HEAD"]);
	if (result.code !== 0 || !/^[0-9a-f]{40}$/i.test(result.stdout.trim()))
		fail("无法确定 canonical artifact 的源码 commit SHA。");
	return result.stdout.trim().toLowerCase();
}

async function readApplicationVersion() {
	const packageJSON = JSON.parse(await readFile(WORKER_PACKAGE, "utf8"));
	return packageJSON.version || DEFAULT_APPLICATION_VERSION;
}

async function copyArtifact(output, workerBundleDirectory) {
	const assetsDirectory = path.join(output, "assets");
	await mkdir(assetsDirectory, { recursive: true, mode: 0o700 });
	const workerBundle = path.join(workerBundleDirectory, "index.js");
	try {
		await stat(workerBundle);
	} catch {
		fail(`Wrangler 未生成预期 Worker bundle：${workerBundle}`);
	}
	await cp(workerBundle, path.join(output, "worker.js"));
	await cp(DASHBOARD_DIST, assetsDirectory, { recursive: true });
	return assetsDirectory;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	try {
		await stat(options.output);
		fail(`输出目录已存在，拒绝覆盖：${options.output}`);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const pnpmCli = await resolvePnpmCli(options.pnpmCli);
	const pnpmBin = path.join(path.dirname(pnpmCli), "..", "..", ".bin");
	const node = process.execPath;
	printResult(
		await run(node, [pnpmCli, "build"], {
			env: { PATH: `${pnpmBin}${path.delimiter}${process.env.PATH ?? ""}` },
		}),
		"pnpm build",
	);
	const temporary = await mkdtemp(path.join(options.output ? path.dirname(options.output) : ROOT, ".cloudbox-wrangler-"));
	try {
		const wrangler = resolveWranglerCli();
		printResult(
			await run(node, [wrangler, "deploy", "--config", WRANGLER_CONFIG, "--dry-run", "--outdir", temporary], {
				cwd: ROOT,
			}),
			"Wrangler dry-run",
		);
		const blake3 = resolveBlake3();
		await mkdir(options.output, { recursive: true, mode: 0o700 });
		const assetsDirectory = await copyArtifact(options.output, temporary);
		await scanArtifact(options.output);
		const uploadHashes = await listAssets(assetsDirectory, blake3);
		await writeFile(path.join(options.output, "upload-hashes.json"), `${JSON.stringify(uploadHashes, null, 2)}\n`, { mode: 0o600 });
		const metadata = {
			applicationVersion: await readApplicationVersion(),
			sourceCommit: await resolveSourceCommit(options.sourceCommit),
			compatibilityDate: COMPATIBILITY_DATE,
			compatibilityFlags: [],
			mainModule: "worker.js",
			migrationTag: MIGRATION_TAG,
			migrationClasses: MIGRATION_CLASSES,
			r2Binding: "BUCKET",
			durableObjectBindings: Object.fromEntries(DURABLE_OBJECT_BINDINGS),
		};
		await writeFile(path.join(options.output, "build-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
		process.stdout.write(`固定 artifact 已生成：${options.output}\n`);
	} finally {
		await rm(temporary, { recursive: true, force: true }).catch(() => {});
	}
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
