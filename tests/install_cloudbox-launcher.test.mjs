import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	access,
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const LAUNCHER = path.join(ROOT, "scripts/install_cloudbox.sh");
const NODE_VERSION = "22.23.2";
const TOKEN_CANARY = "launcher-token-canary";
const REF = "0123456789abcdef0123456789abcdef01234567";
const REMOTE_REF = "d9d36a3173e7647c9007f8640b75ad75ed924dcf";
const REMOTE_SHA256 =
	"a8d9c520da5716337ee1addbfc4d1e9707d39f8796726557dd9ab9ac248a6cd1";
const REMOTE_URL = `https://raw.githubusercontent.com/ntetv/cloudbox-r2/${REMOTE_REF}/scripts/install_cloudbox.mjs`;
const SHAS = {
	"darwin-x64":
		"58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
	"darwin-arm64":
		"61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
	"linux-x64":
		"b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a",
	"linux-arm64":
		"013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30",
};

async function exists(file) {
	return access(file).then(
		() => true,
		() => false,
	);
}

async function writeExecutable(file, source) {
	await writeFile(file, source, { mode: 0o700 });
	await chmod(file, 0o700);
}

async function makeFixture({ markers = true } = {}) {
	const root = await mkdtemp(path.join(os.tmpdir(), "cloudbox-launcher-"));
	const scripts = path.join(root, "scripts");
	await mkdir(scripts, { recursive: true });
	await copyFile(LAUNCHER, path.join(scripts, "install_cloudbox.sh"));
	await chmod(path.join(scripts, "install_cloudbox.sh"), 0o755);
	await writeFile(path.join(scripts, "install_cloudbox.mjs"), "export {}\n");
	if (markers) {
		for (const marker of [
			"package.json",
			"pnpm-lock.yaml",
			"pnpm-workspace.yaml",
			"wrangler.toml",
			"src/index.ts",
			"packages/worker/package.json",
			"packages/dashboard/package.json",
		]) {
			const file = path.join(root, marker);
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, "fixture\n");
		}
	}
	return root;
}

async function makeCoreBin(root) {
	const bin = path.join(root, "bin");
	await mkdir(bin, { recursive: true });
	for (const name of ["chmod", "mkdir", "mktemp", "mv", "pwd", "rm"]) {
		const candidates = [`/bin/${name}`, `/usr/bin/${name}`];
		const source = candidates.find((candidate) => existsSync(candidate));
		assert.ok(source, `missing core command ${name}`);
		await symlink(source, path.join(bin, name));
	}
	return bin;
}

async function makeFakeBin(root, options = {}) {
	const bin = await makeCoreBin(root);
	const logs = {
		curl: path.join(root, "curl.log"),
		tar: path.join(root, "tar.log"),
		checksum: path.join(root, "checksum.log"),
		node: path.join(root, "node.log"),
	};
	const platform = options.platform ?? "darwin-x64";
	const machine =
		options.machine ?? (platform.endsWith("arm64") ? "arm64" : "x86_64");
	const kernel =
		options.kernel ?? (platform.startsWith("darwin") ? "Darwin" : "Linux");

	await writeExecutable(
		path.join(bin, "uname"),
		`#!/bin/sh
case "$1" in
  -s) printf '%s\\n' '${kernel}' ;;
  -m) printf '%s\\n' '${machine}' ;;
  *) exit 2 ;;
esac
`,
	);
	if (kernel === "Linux") {
		await writeExecutable(
			path.join(bin, "ldd"),
			`#!/bin/sh
printf '%s\\n' '${options.libc ?? "ldd (GNU libc) 2.0"}'
`,
		);
	}
	if (options.withNode) {
		await writeExecutable(
			path.join(bin, "node"),
			`#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  printf '%s\\n' "\${FAKE_NODE_VERSION:-v24.3.0}"
  exit "\${FAKE_NODE_VERSION_EXIT:-0}"
fi
if [ -n "\${FAKE_NODE_LOG:-}" ]; then
  printf 'cwd=%s\\n' "$(pwd)" >> "$FAKE_NODE_LOG"
  if [ -t 0 ]; then printf 'tty=yes\\n' >> "$FAKE_NODE_LOG"; else printf 'tty=no\\n' >> "$FAKE_NODE_LOG"; fi
  printf 'argc=%s\\n' "$#" >> "$FAKE_NODE_LOG"
  for argument do printf 'arg=%s\\n' "$argument" >> "$FAKE_NODE_LOG"; done
  if [ "\${FAKE_NODE_READ_STDIN:-0}" = 1 ]; then
    IFS= read -r line || :
    printf 'stdin=%s\\n' "$line" >> "$FAKE_NODE_LOG"
  fi
  if [ "\${CLOUDFLARE_API_TOKEN:-}" = "\${TOKEN_CANARY:-}" ]; then
    printf 'token-preserved=yes\\n' >> "$FAKE_NODE_LOG"
  fi
fi
exit "\${FAKE_NODE_EXIT:-0}"
`,
		);
	}
	if (options.withCurl !== false) {
		await writeExecutable(
			path.join(bin, "curl"),
			`#!/bin/sh
printf '%s\\n' "$*" >> "\${FAKE_CURL_LOG}"
out=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|-o) out=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ] || exit 2
printf '%s\\n' fake-archive > "$out"
`,
		);
	}
	if (options.withTar !== false) {
		await writeExecutable(
			path.join(bin, "tar"),
			`#!/bin/sh
printf '%s\\n' "$*" >> "\${FAKE_TAR_LOG}"
out=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -C) out=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ] || exit 2
home="$out/node-v22.23.2-\${FAKE_PLATFORM}"
/bin/mkdir -p "$home/bin"
printf '%s\\n' '#!/bin/sh' 'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then printf "%s\\n" "v22.23.2"; exit 0; fi' 'if [ -n "\${FAKE_NODE_LOG:-}" ]; then printf "cwd=%s\\n" "$(pwd)" >> "$FAKE_NODE_LOG"; if [ -t 0 ]; then printf "tty=yes\\n" >> "$FAKE_NODE_LOG"; else printf "tty=no\\n" >> "$FAKE_NODE_LOG"; fi; printf "argc=%s\\n" "$#" >> "$FAKE_NODE_LOG"; for argument do printf "arg=%s\\n" "$argument" >> "$FAKE_NODE_LOG"; done; fi' 'exit "\${FAKE_NODE_EXIT:-0}"' > "$home/bin/node"
printf '%s\\n' '#!/bin/sh' 'exit 0' > "$home/bin/npm"
/bin/chmod 700 "$home/bin/node" "$home/bin/npm"
`,
		);
	}
	if (options.checksum === "shasum") {
		await writeExecutable(
			path.join(bin, "shasum"),
			`#!/bin/sh
printf '%s\\n' "$*" >> "\${FAKE_CHECKSUM_LOG}"
expected="\${EXPECTED_SHA256}"
case "$2" in
  *node-v22.23.2-*) expected="\${EXPECTED_NODE_SHA256:-$expected}" ;;
esac
printf '%s  %s\\n' "$expected" "$2"
`,
		);
	} else if (options.checksum !== false) {
		await writeExecutable(
			path.join(bin, "sha256sum"),
			`#!/bin/sh
printf '%s\\n' "$*" >> "\${FAKE_CHECKSUM_LOG}"
expected="\${EXPECTED_SHA256}"
case "$1" in
  *node-v22.23.2-*) expected="\${EXPECTED_NODE_SHA256:-$expected}" ;;
esac
printf '%s  %s\\n' "$expected" "$1"
`,
		);
	}
	return { bin, logs, platform, kernel };
}

function launcherEnv({
	bin,
	home,
	dataHome,
	logs,
	platform,
	expectedSha,
	extra = {},
}) {
	return {
		...process.env,
		HOME: home,
		XDG_DATA_HOME: dataHome,
		PATH: bin,
		FAKE_PLATFORM: platform,
		FAKE_NODE_VERSION: "v24.3.0",
		FAKE_NODE_VERSION_EXIT: "0",
		FAKE_NODE_LOG: logs.node,
		FAKE_NODE_EXIT: "0",
		FAKE_NODE_READ_STDIN: "0",
		FAKE_CURL_LOG: logs.curl,
		FAKE_TAR_LOG: logs.tar,
		FAKE_CHECKSUM_LOG: logs.checksum,
		EXPECTED_SHA256: expectedSha ?? SHAS[platform],
		TOKEN_CANARY,
		CLOUDFLARE_API_TOKEN: TOKEN_CANARY,
		...extra,
	};
}

function runLauncher(launcher, { cwd, env, args = [], input = "" } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn("/bin/sh", [launcher, ...args], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code, signal) =>
			resolve({ code, signal, stdout, stderr }),
		);
		child.stdin.end(input);
	});
}

async function readIfPresent(file) {
	return exists(file)
		? (await import("node:fs/promises")).readFile(file, "utf8")
		: "";
}

async function removeFixture(root) {
	await rm(root, { recursive: true, force: true });
}

test("reuses Node 22+, preserves cwd/args/stdin/exit, and does not log the token", async () => {
	const root = await makeFixture();
	const state = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-launcher-state-"),
	);
	const cwd = path.join(state, "cwd with spaces");
	await mkdir(cwd);
	const fake = await makeFakeBin(state, { withNode: true, checksum: false });
	try {
		const result = await runLauncher(
			path.join(root, "scripts/install_cloudbox.sh"),
			{
				cwd,
				env: launcherEnv({
					bin: fake.bin,
					home: path.join(state, "home"),
					dataHome: path.join(state, "data"),
					logs: fake.logs,
					platform: fake.platform,
					extra: {
						FAKE_NODE_EXIT: "37",
						FAKE_NODE_READ_STDIN: "1",
					},
				}),
				args: ["--ref", REF, "argument with spaces"],
				input: "stdin-sentinel\n",
			},
		);
		assert.equal(result.code, 37);
		assert.equal(result.signal, null);
		const log = await readIfPresent(fake.logs.node);
		assert.match(log, /cwd=.*cwd with spaces/);
		assert.match(log, /tty=no/);
		assert.match(
			log,
			new RegExp(`arg=--ref\\narg=${REF}\\narg=argument with spaces`),
		);
		assert.match(log, /stdin=stdin-sentinel/);
		assert.match(log, /token-preserved=yes/);
		assert.doesNotMatch(
			`${result.stdout}\n${result.stderr}\n${log}`,
			new RegExp(TOKEN_CANARY),
		);
		assert.equal(await exists(fake.logs.curl), false);
	} finally {
		await removeFixture(root);
		await removeFixture(state);
	}
});

test("preserves a TTY for the exec'd Node process", async (t) => {
	const root = await makeFixture();
	const state = await mkdtemp(path.join(os.tmpdir(), "cloudbox-launcher-pty-"));
	const fake = await makeFakeBin(state, { withNode: true, checksum: false });
	try {
		const python = "python3";
		const code = [
			"import os, pty, select, sys",
			"pid, fd = pty.fork()",
			"if pid == 0: os.execvpe(sys.argv[1], sys.argv[1:], os.environ)",
			"chunks = []",
			"status = None",
			"while status is None:",
			"    ready, _, _ = select.select([fd], [], [], 0.1)",
			"    if ready:",
			"        try: chunks.append(os.read(fd, 4096))",
			"        except OSError: pass",
			"    done, status_value = os.waitpid(pid, os.WNOHANG)",
			"    if done: status = status_value",
			"sys.stdout.buffer.write(b''.join(chunks))",
			"sys.exit(os.waitstatus_to_exitcode(status))",
		].join("\n");
		const env = launcherEnv({
			bin: fake.bin,
			home: path.join(state, "home"),
			dataHome: path.join(state, "data"),
			logs: fake.logs,
			platform: fake.platform,
			extra: { PATH: `${fake.bin}:${process.env.PATH ?? ""}` },
		});
		const result = await new Promise((resolve, reject) => {
			const child = spawn(
				python,
				[
					"-c",
					code,
					"/bin/sh",
					path.join(root, "scripts/install_cloudbox.sh"),
					"--help",
				],
				{
					cwd: state,
					env,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.once("error", reject);
			child.once("close", (exitCode, signal) =>
				resolve({ exitCode, signal, stdout, stderr }),
			);
		});
		if (result.exitCode === null && /ENOENT/.test(result.stderr)) {
			t.skip("python3 is unavailable");
			return;
		}
		assert.equal(result.exitCode, 0, result.stderr);
		assert.match(await readIfPresent(fake.logs.node), /tty=yes/);
	} finally {
		await removeFixture(root);
		await removeFixture(state);
	}
});

test("maps all supported platforms to fixed URLs and SHA-256 values", async () => {
	for (const [platform, expectedSha] of Object.entries(SHAS)) {
		const root = await makeFixture();
		const state = await mkdtemp(
			path.join(os.tmpdir(), "cloudbox-launcher-platform-"),
		);
		const fake = await makeFakeBin(state, {
			platform,
			checksum: platform.startsWith("darwin") ? "shasum" : "sha256sum",
			withNode: false,
		});
		try {
			const result = await runLauncher(
				path.join(root, "scripts/install_cloudbox.sh"),
				{
					cwd: state,
					env: launcherEnv({
						bin: fake.bin,
						home: path.join(state, "home"),
						dataHome: path.join(state, "data"),
						logs: fake.logs,
						platform,
						expectedSha,
					}),
					args: ["--help"],
				},
			);
			assert.equal(result.code, 0, `${platform}: ${result.stderr}`);
			const curl = await readIfPresent(fake.logs.curl);
			assert.match(
				curl,
				new RegExp(
					`https://nodejs\\.org/download/release/v22\\.23\\.2/node-v22\\.23\\.2-${platform}\\.tar\\.gz`,
				),
			);
			assert.match(curl, /--proto =https/);
			assert.match(curl, /--proto-redir =https/);
			assert.match(
				await readIfPresent(fake.logs.checksum),
				platform.startsWith("darwin") ? /-a 256/ : /node-v22\.23\.2/,
			);
			assert.match(await readIfPresent(fake.logs.tar), /-xzf/);
			assert.match(await readIfPresent(fake.logs.node), /arg=--help/);
			const cache = path.join(
				state,
				"data",
				"cloudbox-r2",
				`node-v${NODE_VERSION}-${platform}`,
			);
			assert.equal(await exists(path.join(cache, "bin", "node")), true);
			assert.deepEqual(
				await (await import("node:fs/promises")).readdir(
					path.join(state, "data", "cloudbox-r2"),
				),
				[`node-v${NODE_VERSION}-${platform}`],
			);
		} finally {
			await removeFixture(root);
			await removeFixture(state);
		}
	}
});

test("installs fixed Node when Node is missing, old, or unparsable", async () => {
	for (const version of [null, "v18.20.0", "not-a-version"]) {
		const root = await makeFixture();
		const state = await mkdtemp(
			path.join(os.tmpdir(), "cloudbox-launcher-node-"),
		);
		const fake = await makeFakeBin(state, {
			platform: "darwin-arm64",
			withNode: version !== null,
			checksum: "shasum",
		});
		try {
			const env = launcherEnv({
				bin: fake.bin,
				home: path.join(state, "home"),
				dataHome: path.join(state, "data"),
				logs: fake.logs,
				platform: fake.platform,
				extra: { FAKE_NODE_VERSION: version ?? "v24.3.0" },
			});
			const result = await runLauncher(
				path.join(root, "scripts/install_cloudbox.sh"),
				{
					cwd: state,
					env,
					args: ["--ref", REF],
				},
			);
			assert.equal(result.code, 0, `${version ?? "missing"}: ${result.stderr}`);
			assert.match(
				await readIfPresent(fake.logs.curl),
				/node-v22\.23\.2-darwin-arm64\.tar\.gz/,
			);
			assert.match(
				await readIfPresent(fake.logs.node),
				new RegExp(`arg=--ref\\narg=${REF}`),
			);
		} finally {
			await removeFixture(root);
			await removeFixture(state);
		}
	}
});

test("rejects a checksum mismatch before tar or Node execution", async () => {
	const root = await makeFixture();
	const state = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-launcher-checksum-"),
	);
	const fake = await makeFakeBin(state, {
		platform: "linux-x64",
		checksum: "sha256sum",
		withNode: false,
	});
	try {
		const result = await runLauncher(
			path.join(root, "scripts/install_cloudbox.sh"),
			{
				cwd: state,
				env: launcherEnv({
					bin: fake.bin,
					home: path.join(state, "home"),
					dataHome: path.join(state, "data"),
					logs: fake.logs,
					platform: fake.platform,
					extra: { EXPECTED_SHA256: "wrong-sha" },
				}),
				args: ["--help"],
			},
		);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /SHA-256 不匹配/);
		assert.equal(await exists(fake.logs.tar), false);
		assert.equal(await exists(fake.logs.node), false);
		assert.deepEqual(
			await (await import("node:fs/promises")).readdir(
				path.join(state, "data", "cloudbox-r2"),
			),
			[],
		);
	} finally {
		await removeFixture(root);
		await removeFixture(state);
	}
});

test("reuses a valid cache and rejects a corrupt cache without downloading", async () => {
	const root = await makeFixture();
	const state = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-launcher-cache-"),
	);
	const dataHome = path.join(state, "data");
	const validHome = path.join(
		dataHome,
		"cloudbox-r2",
		"node-v22.23.2-darwin-x64",
	);
	const fake = await makeFakeBin(state, {
		platform: "darwin-x64",
		withNode: false,
		checksum: false,
	});
	try {
		await mkdir(path.join(validHome, "bin"), { recursive: true });
		await writeExecutable(
			path.join(validHome, "bin", "node"),
			`#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then printf '%s\\n' 'v22.23.2'; exit 0; fi
printf 'cached\\n' >> "$FAKE_NODE_LOG"
exit 0
`,
		);
		await writeExecutable(
			path.join(validHome, "bin", "npm"),
			"#!/bin/sh\nexit 0\n",
		);
		const valid = await runLauncher(
			path.join(root, "scripts/install_cloudbox.sh"),
			{
				cwd: state,
				env: launcherEnv({
					bin: fake.bin,
					home: path.join(state, "home"),
					dataHome,
					logs: fake.logs,
					platform: fake.platform,
				}),
			},
		);
		assert.equal(valid.code, 0, valid.stderr);
		assert.match(await readIfPresent(fake.logs.node), /cached/);
		assert.equal(await exists(fake.logs.curl), false);

		await rm(validHome, { recursive: true, force: true });
		await mkdir(path.join(validHome, "bin"), { recursive: true });
		await writeExecutable(
			path.join(validHome, "bin", "node"),
			"#!/bin/sh\nprintf '%s\\n' 'v22.23.2'\n",
		);
		const corrupt = await runLauncher(
			path.join(root, "scripts/install_cloudbox.sh"),
			{
				cwd: state,
				env: launcherEnv({
					bin: fake.bin,
					home: path.join(state, "home"),
					dataHome,
					logs: fake.logs,
					platform: fake.platform,
				}),
			},
		);
		assert.equal(corrupt.code, 1);
		assert.match(corrupt.stderr, /缓存已存在但校验失败/);
	} finally {
		await removeFixture(root);
		await removeFixture(state);
	}
});

test("stops before networking when required download tools are missing", async () => {
	for (const missing of ["curl", "tar", "checksum"]) {
		const root = await makeFixture();
		const state = await mkdtemp(
			path.join(os.tmpdir(), "cloudbox-launcher-tools-"),
		);
		const fake = await makeFakeBin(state, {
			platform: "darwin-x64",
			withNode: false,
			withCurl: missing !== "curl",
			withTar: missing !== "tar",
			checksum: missing === "checksum" ? false : "shasum",
		});
		try {
			const result = await runLauncher(
				path.join(root, "scripts/install_cloudbox.sh"),
				{
					cwd: state,
					env: launcherEnv({
						bin: fake.bin,
						home: path.join(state, "home"),
						dataHome: path.join(state, "data"),
						logs: fake.logs,
						platform: fake.platform,
					}),
				},
			);
			assert.equal(result.code, 1, missing);
			assert.match(
				result.stderr,
				missing === "checksum"
					? /sha256sum 或 shasum/
					: new RegExp(`缺少必需命令 ${missing}`),
			);
			assert.equal(await exists(fake.logs.curl), false, missing);
		} finally {
			await removeFixture(root);
			await removeFixture(state);
		}
	}
});

test("rejects unsupported OS, architecture, and Linux musl explicitly", async () => {
	for (const options of [
		{ platform: "freebsd-x64", kernel: "FreeBSD", expected: /不支持的平台/ },
		{
			platform: "linux-x86",
			machine: "i686",
			expected: /不支持的 Linux CPU 架构/,
		},
		{
			platform: "linux-x64",
			libc: "musl libc (x86_64)",
			expected: /musl libc/,
		},
	]) {
		const root = await makeFixture();
		const state = await mkdtemp(
			path.join(os.tmpdir(), "cloudbox-launcher-platform-fail-"),
		);
		const fake = await makeFakeBin(state, {
			...options,
			withNode: false,
			checksum: "sha256sum",
		});
		try {
			const result = await runLauncher(
				path.join(root, "scripts/install_cloudbox.sh"),
				{
					cwd: state,
					env: launcherEnv({
						bin: fake.bin,
						home: path.join(state, "home"),
						dataHome: path.join(state, "data"),
						logs: fake.logs,
						platform: fake.platform,
					}),
				},
			);
			assert.equal(result.code, 1);
			assert.match(result.stderr, options.expected);
			assert.equal(await exists(fake.logs.curl), false);
		} finally {
			await removeFixture(root);
			await removeFixture(state);
		}
	}
});

test("falls back to HOME/.local/share when XDG_DATA_HOME is empty", async () => {
	const root = await makeFixture();
	const state = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-launcher-home-"),
	);
	const fake = await makeFakeBin(state, {
		platform: "darwin-x64",
		withNode: false,
		checksum: "shasum",
	});
	try {
		const home = path.join(state, "home");
		const result = await runLauncher(
			path.join(root, "scripts/install_cloudbox.sh"),
			{
				cwd: state,
				env: launcherEnv({
					bin: fake.bin,
					home,
					dataHome: path.join(state, "unused-data"),
					logs: fake.logs,
					platform: fake.platform,
					extra: { XDG_DATA_HOME: "" },
				}),
			},
		);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(
			await exists(
				path.join(
					home,
					".local/share/cloudbox-r2/node-v22.23.2-darwin-x64/bin/node",
				),
			),
			true,
		);
	} finally {
		await removeFixture(root);
		await removeFixture(state);
	}
});

test("downloads and caches the fixed remote MJS without a trusted sibling", async () => {
	const root = await makeFixture({ markers: false });
	const state = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-launcher-remote-"),
	);
	const fake = await makeFakeBin(state, {
		withNode: true,
		checksum: "shasum",
	});
	const cacheHome = path.join(state, "cache");
	const cachePath = path.join(
		cacheHome,
		"cloudbox-r2",
		`install_cloudbox-${REMOTE_REF}.mjs`,
	);
	try {
		const env = launcherEnv({
			bin: fake.bin,
			home: path.join(state, "home"),
			dataHome: path.join(state, "data"),
			logs: fake.logs,
			platform: fake.platform,
			expectedSha: REMOTE_SHA256,
			extra: { XDG_CACHE_HOME: cacheHome },
		});
		const downloaded = await runLauncher(
			path.join(root, "scripts/install_cloudbox.sh"),
			{ cwd: state, env, args: ["--help"] },
		);
		assert.equal(downloaded.code, 0, downloaded.stderr);
		const curl = await readIfPresent(fake.logs.curl);
		assert.ok(curl.includes(REMOTE_URL), curl);
		assert.match(curl, /--proto =https/);
		assert.match(curl, /--proto-redir =https/);
		assert.match(curl, /--connect-timeout 10/);
		assert.match(curl, /--max-time 120/);
		assert.match(await readIfPresent(fake.logs.checksum), /-a 256/);
		assert.equal(await exists(cachePath), true);
		assert.equal((await stat(cachePath)).mode & 0o777, 0o700);

		const cached = await runLauncher(
			path.join(root, "scripts/install_cloudbox.sh"),
			{ cwd: state, env, args: ["--help"] },
		);
		assert.equal(cached.code, 0, cached.stderr);
		assert.equal(
			(await readIfPresent(fake.logs.curl)).trim().split("\n").length,
			1,
		);
		assert.equal(
			(await readIfPresent(fake.logs.checksum)).trim().split("\n").length,
			3,
		);
	} finally {
		await removeFixture(root);
		await removeFixture(state);
	}
});

test("downloads the remote MJS before installing Node when Node is missing", async () => {
	const root = await makeFixture({ markers: false });
	const state = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-launcher-remote-no-node-"),
	);
	const fake = await makeFakeBin(state, {
		withNode: false,
		checksum: "sha256sum",
	});
	const cacheHome = path.join(state, "cache");
	try {
		const result = await runLauncher(
			path.join(root, "scripts/install_cloudbox.sh"),
			{
				cwd: state,
				env: launcherEnv({
					bin: fake.bin,
					home: path.join(state, "home"),
					dataHome: path.join(state, "data"),
					logs: fake.logs,
					platform: fake.platform,
					expectedSha: REMOTE_SHA256,
					extra: {
						XDG_CACHE_HOME: cacheHome,
						EXPECTED_NODE_SHA256: SHAS[fake.platform],
					},
				}),
				args: ["--help"],
			},
		);
		assert.equal(result.code, 0, result.stderr);
		const curlLines = (await readIfPresent(fake.logs.curl)).trim().split("\n");
		assert.equal(curlLines.length, 2);
		assert.ok(curlLines[0].includes(REMOTE_URL), curlLines[0]);
		assert.match(curlLines[1], /node-v22\.23\.2-darwin-x64\.tar\.gz/);
		assert.equal(
			await exists(
				path.join(
					cacheHome,
					"cloudbox-r2",
					`install_cloudbox-${REMOTE_REF}.mjs`,
				),
			),
			true,
		);
	} finally {
		await removeFixture(root);
		await removeFixture(state);
	}
});

test("rehashes a mismatched remote cache and refuses to overwrite it", async () => {
	const root = await makeFixture({ markers: false });
	const state = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-launcher-remote-mismatch-"),
	);
	const fake = await makeFakeBin(state, {
		withNode: true,
		checksum: "sha256sum",
	});
	const cacheHome = path.join(state, "cache");
	const cachePath = path.join(
		cacheHome,
		"cloudbox-r2",
		`install_cloudbox-${REMOTE_REF}.mjs`,
	);
	try {
		await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
		await writeFile(cachePath, "corrupt-cache\n", { mode: 0o700 });
		await chmod(cachePath, 0o700);
		const result = await runLauncher(
			path.join(root, "scripts/install_cloudbox.sh"),
			{
				cwd: state,
				env: launcherEnv({
					bin: fake.bin,
					home: path.join(state, "home"),
					dataHome: path.join(state, "data"),
					logs: fake.logs,
					platform: fake.platform,
					expectedSha: "wrong-cache-sha",
					extra: { XDG_CACHE_HOME: cacheHome },
				}),
				args: ["--help"],
			},
		);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /缓存 SHA-256 不匹配/);
		assert.equal(await exists(fake.logs.curl), false);
		assert.equal(await exists(fake.logs.node), false);
		assert.equal(
			await (await import("node:fs/promises")).readFile(cachePath, "utf8"),
			"corrupt-cache\n",
		);
		assert.equal((await stat(cachePath)).mode & 0o777, 0o700);
	} finally {
		await removeFixture(root);
		await removeFixture(state);
	}
});

test("does not execute a same-directory MJS without project markers when remote checksum tooling is absent", async () => {
	const root = await makeFixture({ markers: false });
	const state = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-launcher-untrusted-"),
	);
	const fake = await makeFakeBin(state, { withNode: true, checksum: false });
	try {
		const result = await runLauncher(
			path.join(root, "scripts/install_cloudbox.sh"),
			{
				cwd: state,
				env: launcherEnv({
					bin: fake.bin,
					home: path.join(state, "home"),
					dataHome: path.join(state, "data"),
					logs: fake.logs,
					platform: fake.platform,
				}),
			},
		);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /sha256sum 或 shasum/);
		assert.equal(await exists(fake.logs.node), false);
	} finally {
		await removeFixture(root);
		await removeFixture(state);
	}
});
