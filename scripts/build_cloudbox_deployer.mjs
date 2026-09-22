#!/usr/bin/env node

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GO_ROOT = path.join(ROOT, "tools/cloudbox-deployer");
const TARGETS = [
	{ name: "darwin-arm64", goos: "darwin", goarch: "arm64" },
	{ name: "darwin-amd64", goos: "darwin", goarch: "amd64" },
	{ name: "linux-amd64", goos: "linux", goarch: "amd64" },
	{ name: "linux-386", goos: "linux", goarch: "386" },
	{ name: "linux-arm64", goos: "linux", goarch: "arm64" },
	{ name: "linux-armv7", goos: "linux", goarch: "arm", goarm: "7" },
	{ name: "windows-amd64", goos: "windows", goarch: "amd64" },
	{ name: "windows-386", goos: "windows", goarch: "386" },
	{ name: "windows-arm64", goos: "windows", goarch: "arm64" },
];
const DEFAULT_OUTPUT = path.join(
	GO_ROOT,
	process.platform === "win32" ? "cloudbox_deployer.exe" : "cloudbox_deployer",
);

function fail(message) {
	throw new Error(`build_cloudbox_deployer: ${message}`);
}

function parseArgs(argv) {
	let output = DEFAULT_OUTPUT;
	let target = null;
	let allTargets = false;
	let explicitOutput = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		const [name, inlineValue] = argument.split("=", 2);
		if (name === "--all-targets") {
			allTargets = true;
			continue;
		}
		if (name !== "--output" && name !== "--target")
			fail(`不支持的参数：${argument}`);
		const value = inlineValue ?? argv[++index];
		if (!value) fail(`${name} 缺少值`);
		if (name === "--output") {
			output = path.resolve(process.cwd(), value);
			explicitOutput = true;
		} else {
			target = TARGETS.find((candidate) => candidate.name === value);
			if (!target) fail(`不支持的目标平台：${value}`);
		}
	}
	if (allTargets && explicitOutput) fail("--all-targets 不能与 --output 同时使用");
	if (allTargets && target) fail("--all-targets 不能与 --target 同时使用");
	if (allTargets) {
		return { mode: "all", output: path.join(GO_ROOT, "releases") };
	}
	if (target) {
		return { mode: "one", output: explicitOutput ? output : path.join(GO_ROOT, `cloudbox_deployer-${target.name}${target.goos === "windows" ? ".exe" : ""}`), target };
	}
	return { mode: "one", output, target: null };
}

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? ROOT,
			stdio: "inherit",
			shell: false,
			env: { ...process.env, ...(options.env ?? {}) },
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code !== 0) reject(new Error(`${command} 退出码 ${code ?? "unknown"}`));
			else resolve();
		});
	});
}

function targetEnv(target) {
	if (!target) return {};
	return {
		CGO_ENABLED: "0",
		GOOS: target.goos,
		GOARCH: target.goarch,
		...(target.goarm ? { GOARM: target.goarm } : {}),
	};
}

async function buildOne(output, target) {
	await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
	await run("go", ["build", "-o", output, "./cmd/cloudbox-deployer"], {
		cwd: GO_ROOT,
		env: targetEnv(target),
	});
	process.stdout.write(`Go 单文件部署器已生成：${output}\n`);
}

async function main() {
	const build = parseArgs(process.argv.slice(2));
	const temporaryParent = await mkdtemp(path.join(os.tmpdir(), "cloudbox-deployer-build-"));
	const artifact = path.join(temporaryParent, "artifact");
	try {
		await run(process.execPath, [path.join(ROOT, "scripts/build_cloudbox_artifact.mjs"), "--output", artifact]);
		await run("go", ["run", "./cmd/cloudbox-artifact", "build-manifest", "--artifact-root", artifact, "--build-metadata", path.join(artifact, "build-metadata.json")], { cwd: GO_ROOT });
		await run(process.execPath, [path.join(ROOT, "scripts/embed_cloudbox_artifact.mjs"), "--input", artifact]);
		if (build.mode === "all") {
			for (const target of TARGETS) {
				await buildOne(path.join(build.output, `cloudbox_deployer-${target.name}${target.goos === "windows" ? ".exe" : ""}`), target);
			}
		} else {
			await buildOne(build.output, build.target);
		}
		process.stdout.write("部署二进制不接受特殊命令或参数；直接运行即可进入真实部署。\n");
	} finally {
		await rm(temporaryParent, { recursive: true, force: true }).catch(() => {});
	}
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
