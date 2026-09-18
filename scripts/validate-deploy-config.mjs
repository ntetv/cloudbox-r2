import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	const values = {};
	const names = new Map([
		["--config", "config"],
		["--worker-name", "workerName"],
		["--bucket-name", "bucketName"],
	]);
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		const equals = argument.indexOf("=");
		const option = equals === -1 ? argument : argument.slice(0, equals);
		const name = names.get(option);
		if (!name)
			throw new Error(`Unsupported deployment config argument: ${argument}`);
		const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
		if (!value || values[name] !== undefined)
			throw new Error(`Missing deployment config value: ${argument}`);
		values[name] = value;
	}
	return values;
}

function resolveConfigPath(value) {
	if (value === undefined)
		return path.resolve(SCRIPT_DIRECTORY, "../wrangler.toml");
	if (
		value.includes("\0") ||
		(/^[A-Za-z][A-Za-z\d+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value))
	)
		throw new Error(
			"Deployment config path must be a local absolute or relative path.",
		);
	return path.resolve(process.cwd(), value);
}

function fieldValues(config, field, { topLevel = false } = {}) {
	const pattern = new RegExp(`(?:^|[,{])\\s*${field}\\s*=\\s*"([^"]+)"`);
	let table = null;
	const values = [];
	for (const line of config.split("\n")) {
		const source = line.replace(/(?:^|\s+)#.*$/, "");
		const tableMatch = source.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
		if (tableMatch) {
			table = tableMatch[1];
			continue;
		}
		const match = source.match(pattern);
		if (match && (!topLevel || table === null)) values.push(match[1]);
	}
	return values;
}

function matchesPath(value, relative) {
	const normalized = value.replaceAll("\\", "/");
	return normalized === relative || normalized.endsWith(`/${relative}`);
}

const args = parseArgs(process.argv.slice(2));
const expectedWorker = args.workerName ?? process.env.CLOUDBOX_WORKER_NAME;
const expectedBucket = args.bucketName ?? process.env.CLOUDBOX_BUCKET_NAME;
if (expectedWorker !== undefined && !NAME.test(expectedWorker))
	throw new Error("Worker name is invalid.");
if (
	expectedBucket !== undefined &&
	(!NAME.test(expectedBucket) || expectedBucket.length < 3)
)
	throw new Error("R2 bucket name is invalid.");

const config = await readFile(resolveConfigPath(args.config), "utf8");
const names = fieldValues(config, "name", { topLevel: true });
const buckets = fieldValues(config, "bucket_name");
if (names.length !== 1 || !NAME.test(names[0]))
	throw new Error("Deployment config must contain one valid Worker name.");
if (buckets.length !== 1 || !NAME.test(buckets[0]) || buckets[0].length < 3)
	throw new Error("Deployment config must contain one valid R2 bucket name.");
if (expectedWorker !== undefined && names[0] !== expectedWorker)
	throw new Error(`Worker name does not match: ${expectedWorker}`);
if (expectedBucket !== undefined && buckets[0] !== expectedBucket)
	throw new Error(`R2 bucket name does not match: ${expectedBucket}`);

const required = [
	["main", "src/index.ts"],
	["directory", "packages/dashboard/dist"],
];
for (const [field, relative] of required) {
	const values = fieldValues(config, field, { topLevel: true });
	if (values.length !== 1 || !matchesPath(values[0], relative))
		throw new Error(`Missing deployment config: ${field} = "${relative}"`);
}
for (const value of ['binding = "BUCKET"', 'tag = "v1-cloudbox-r2"']) {
	if (!config.includes(value))
		throw new Error(`Missing deployment config: ${value}`);
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
