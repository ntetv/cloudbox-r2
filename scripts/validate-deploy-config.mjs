import { readFile } from "node:fs/promises";

const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
const required = [
	'name = "cloudbox-r2"',
	'main = "src/index.ts"',
	'directory = "packages/dashboard/dist"',
	'binding = "BUCKET"',
	'bucket_name = "cloudbox-r2"',
	'tag = "v1-cloudbox-r2"',
];

for (const value of required) {
	if (!config.includes(value)) throw new Error(`Missing deployment config: ${value}`);
}

const classes = [
	"AdminLoginRateLimiter",
	"AdminSessionStore",
	"PublicAccessRateLimiter",
	"AdminLoginSourceRateLimiter",
	"TransferStore",
	"TransferRegistry",
];
for (const className of classes) {
	if (!config.includes(`class_name = "${className}"`))
		throw new Error(`Missing Durable Object class: ${className}`);
}

console.log("Deployment configuration is valid.");
