import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/install_cloudbox.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerDirectory = path.resolve(scriptDirectory, "..");
const rootDirectory = path.resolve(workerDirectory, "../..");

async function run(command, args) {
	const result = await runCommand(command, args, {
		root: workerDirectory,
		capture: true,
		timeoutMs: 120_000,
	});
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.timedOut) throw new Error(`${command} timed out`);
	if (result.stdoutTruncated || result.stderrTruncated)
		throw new Error(`${command} output exceeded the limit`);
	if (result.code !== 0)
		throw new Error(`${command} exited with ${result.code ?? result.signal}`);
}

await run(process.execPath, [
	path.join(
		rootDirectory,
		"packages/dashboard/scripts/build-cloudbox-assets.mjs",
	),
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
