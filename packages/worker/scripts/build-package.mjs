import { spawn } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerDirectory = path.resolve(scriptDirectory, "..");
const rootDirectory = path.resolve(workerDirectory, "../..");

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: workerDirectory,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		const stdout = [];
		const stderr = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.once("error", reject);
		child.once("close", (code, signal) => {
			const result = {
				code,
				signal,
				stdout: Buffer.concat(stdout).toString(),
				stderr: Buffer.concat(stderr).toString(),
			};
			if (result.stdout) process.stdout.write(result.stdout);
			if (result.stderr) process.stderr.write(result.stderr);
			if (code !== 0) reject(new Error(`${command} exited with ${code ?? signal}`));
			else resolve(result);
		});
	});
}

await run(process.execPath, [
	path.join(rootDirectory, "packages/dashboard/scripts/build-cloudbox-assets.mjs"),
]);
await rm(path.join(workerDirectory, "dist"), { recursive: true, force: true });
await rm(path.join(workerDirectory, "dashboard"), {
	recursive: true,
	force: true,
});
await rm(path.join(workerDirectory, "LICENSE"), { force: true });
await rm(path.join(workerDirectory, "README.md"), { force: true });
await run(process.execPath, [
	path.join(workerDirectory, "node_modules/tsup/dist/cli-default.js"),
	"src/index.ts",
	"--format",
	"cjs,esm",
	"--dts",
]);
await cp(
	path.join(rootDirectory, "packages/dashboard/dist"),
	path.join(workerDirectory, "dashboard"),
	{
		recursive: true,
	},
);
await cp(
	path.join(rootDirectory, "LICENSE"),
	path.join(workerDirectory, "LICENSE"),
);
await cp(
	path.join(rootDirectory, "README.md"),
	path.join(workerDirectory, "README.md"),
);
