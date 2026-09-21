import { createHash } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { askSecret } from "../scripts/install_cloudbox.mjs";

const rl = createInterface({ input: stdin, output: stdout, terminal: true });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const valid = (value) => value.length > 0 ? value : null;
try {
	const hidden1 = await askSecret(rl, "hidden-1: ", valid);
	const normal = await rl.question("normal: ");
	const hidden2 = await askSecret(rl, "hidden-2: ", valid);
	const hidden3 = await askSecret(rl, "hidden-3: ", valid);
	const confirmed = (await rl.question("confirm [y/N]: ")).trim().toLowerCase();
	if (confirmed !== "yes") throw new Error("confirmation failed");
	console.log(`OK ${[hidden1, normal, hidden2, hidden3].map(hash).join(" ")}`);
} catch (error) {
	console.log(`EXIT ${error.message}`);
	process.exitCode = 1;
} finally {
	rl.close();
}
