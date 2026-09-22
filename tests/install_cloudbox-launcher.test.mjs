import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const LAUNCHER = path.join(ROOT, "install_cloudbox.sh");
const REF = "85e5888122ef43017f1a1146e7eeae4265476966";
const SHAS = {
	"darwin-arm64": "25f27cd58909b28b458aa42efe9ab895f3c83ee9b53c4b85254d898f662ff32d",
	"darwin-amd64": "338ab6bc1d1502a432b948306ca02e6454d993bee11868a196277019cc8e6ed8",
	"linux-amd64": "cd1bca34f04a69a7deab52acdf61a008b2ee02d34ecd1b04df08140d07232eff",
	"linux-386": "a9fcdf50919863aa4e63262f8fb03cbe841284bc7d4633d9d4fa6ac064b46470",
	"linux-arm64": "c872182a5b0e67ae9978007c5bd37204ca2e480c076ccf0068116ea6caeca628",
	"linux-armv7": "f0a30f7f4a95e52f043e88a33c95705148c8ceeaf7f382d0ab1d451034e91f1d",
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

async function makeFixture(platform, { checksum = true, kernel, machine } = {}) {
	const root = await mkdtemp(path.join(os.tmpdir(), "cloudbox-binary-launcher-"));
	const bin = path.join(root, "bin");
	const home = path.join(root, "home");
	const cache = path.join(root, "cache");
	await mkdir(bin, { recursive: true });
	await mkdir(home, { recursive: true });
	for (const name of ["cat", "chmod", "mkdir", "mktemp", "mv", "rm"]) {
		const source = ["/bin/", "/usr/bin/"].map((prefix) => `${prefix}${name}`).find((candidate) => {
			try {
				return existsSync(candidate);
			} catch {
				return false;
			}
		});
		assert.ok(source, `missing ${name}`);
		await symlink(source, path.join(bin, name));
	}
	const isDarwin = (kernel ?? (platform.startsWith("darwin") ? "Darwin" : "Linux")) === "Darwin";
	const reportedMachine = machine ?? (platform.endsWith("armv7") ? "armv7l" : platform.endsWith("386") ? "i686" : platform.endsWith("arm64") ? "arm64" : "x86_64");
	await writeExecutable(
		path.join(bin, "uname"),
		`#!/bin/sh
case "$1" in
  -s) printf '%s\\n' '${kernel ?? (isDarwin ? "Darwin" : "Linux")}' ;;
  -m) printf '%s\\n' '${reportedMachine}' ;;
  *) exit 2 ;;
esac
`,
	);
	const logs = { curl: path.join(root, "curl.log"), binary: path.join(root, "binary.log") };
	await writeExecutable(
		path.join(bin, "curl"),
		`#!/bin/sh
printf '%s\\n' "$*" >> "${logs.curl}"
out=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|-o) out=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ] || exit 2
cat > "$out" <<'BIN'
#!/bin/sh
printf 'argc=%s\\n' "$#" >> "$FAKE_BINARY_LOG"
for argument do printf 'arg=%s\\n' "$argument" >> "$FAKE_BINARY_LOG"; done
exit "\${FAKE_BINARY_EXIT:-0}"
BIN
chmod 700 "$out"
`,
	);
	if (checksum) {
		await writeExecutable(
			path.join(bin, "sha256sum"),
			`#!/bin/sh
printf '%s  %s\\n' "${SHAS[platform]}" "$1"
`,
		);
	}
	return { root, bin, home, cache, logs, platform };
}

function runLauncher(root, fixture, args = []) {
	return new Promise((resolve, reject) => {
		const child = spawn("/bin/sh", [path.join(root, "install_cloudbox.sh"), ...args], {
			cwd: root,
			env: {
				...process.env,
				HOME: fixture.home,
				XDG_CACHE_HOME: fixture.cache,
				PATH: fixture.bin,
				CLOUDBOX_BINARY_REF: REF,
				FAKE_BINARY_LOG: fixture.logs.binary,
				FAKE_BINARY_EXIT: "0",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
}

async function copyLauncher(fixture) {
	await copyFile(LAUNCHER, path.join(fixture.root, "install_cloudbox.sh"));
	await chmod(path.join(fixture.root, "install_cloudbox.sh"), 0o700);
}

for (const platform of Object.keys(SHAS)) {
	test(`downloads ${platform} binary and preserves arguments`, async () => {
		const fixture = await makeFixture(platform);
		try {
			await copyLauncher(fixture);
			const result = await runLauncher(fixture.root, fixture, ["argument with spaces"]);
			assert.equal(result.code, 0, result.stderr);
			const curl = await readFile(fixture.logs.curl, "utf8");
			assert.match(curl, new RegExp(`/${REF}/tool/cloudbox_deployer-${platform}`));
			const binaryLog = await readFile(fixture.logs.binary, "utf8");
			assert.match(binaryLog, /arg=argument with spaces/);
			const sameDirectoryBinary = path.join(fixture.root, `cloudbox_deployer-${platform}`);
			assert.equal(await exists(sameDirectoryBinary), false);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});
}

