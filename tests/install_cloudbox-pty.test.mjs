import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import test from "node:test";

const script = new URL("./pty-ask-secret.py", import.meta.url);

test(
	"Python stdlib pty drives hidden and normal prompts",
	{ skip: process.platform === "win32" },
	async () => {
		await access(script);
		await new Promise((resolve, reject) => {
			const child = spawn("python3", [script.pathname], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.on("error", reject);
			child.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(stderr || `pty test exited ${code}`));
			});
		});
	},
);
