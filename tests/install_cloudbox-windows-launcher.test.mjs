import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BAT = path.join(ROOT, "scripts", "install_cloudbox.bat");
const POWERSHELL = path.join(ROOT, "scripts", "install_cloudbox.ps1");

function exists(file) {
	return access(file).then(
		() => true,
		() => false,
	);
}

function runWindowsHelp() {
	return new Promise((resolve, reject) => {
		const child = spawn("cmd.exe", ["/d", "/s", "/c", `"${BAT}" --help`], {
			cwd: ROOT,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("Windows BAT --help 超时。"));
		}, 30_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

if (process.platform !== "win32") {
	test(
		"Windows native launcher tests require Windows",
		{ skip: true },
		() => {},
	);
} else {
	test("Windows native launcher files exist", async () => {
		assert.equal(await exists(BAT), true);
		assert.equal(await exists(POWERSHELL), true);
	});

	test("Windows BAT --help preserves successful non-deploy path", async () => {
		const result = await runWindowsHelp();
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /install_cloudbox/);
	});
}
