import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";

export const SECRET_NAMES = [
	"CLOUDBOX_R2_ADMIN_PATH",
	"ADMIN_USERNAME",
	"ADMIN_PASSWORD",
	"ADMIN_SESSION_SECRET",
	"PUBLIC_ACCESS_SESSION_SECRET",
	"PUBLIC_ACCESS_PASSWORD_PEPPER",
	"TRANSFER_SESSION_SECRET",
];
const SCRIPT_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const DEFAULT_ROOT = [
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"wrangler.toml",
	"src/index.ts",
	"packages/worker/package.json",
	"packages/dashboard/package.json",
].every((relative) => existsSync(path.join(SCRIPT_ROOT, relative)))
	? SCRIPT_ROOT
	: null;
const ROOT = DEFAULT_ROOT ?? process.cwd();
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ADMIN_PATH = /^[A-Za-z0-9_-]{5,12}$/;
const encoder = new TextEncoder();
const WORKFLOW_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
export const COMMAND_TERM_GRACE_MS = 2_000;
export const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
export const TAR_WORKER_TIMEOUT_MS = 60_000;
export const TAR_WORKER_MAX_OLD_SPACE_MB = 128;
export const TAR_WORKER_MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_SOURCE_REF = "b168336b35c4a6d93c97c18dcfab17cc8c46ac00";
export const SOURCE_REPOSITORY = "ntetv/cloudbox-r2";
export const SOURCE_ARCHIVE_HOST = "codeload.github.com";
export const NPM_REGISTRY = "https://registry.npmjs.org/";
export const PNPM_VERSION = "9.15.4";
export const WRANGLER_VERSION = "4.51.0";
export const TAR_VERSION = "7.5.14";
export const TAR_TARBALL_URL = `${NPM_REGISTRY}tar/-/tar-${TAR_VERSION}.tgz`;
export const TAR_INTEGRITY =
	"sha512-/7sHKgQO3JLP9ESlwTYUUftHUadOURUqq23xs1vjcnp8Vss6k0wCfzulyEtk5g91pjvnuriimGlyG7k6msrzRw==";
export const TAR_DEPENDENCY_LOCK = Object.freeze({
	"@isaacs/fs-minipass": Object.freeze({
		version: "4.0.1",
		resolved:
			"https://registry.npmjs.org/@isaacs/fs-minipass/-/fs-minipass-4.0.1.tgz",
		integrity:
			"sha512-wgm9Ehl2jpeqP3zw/7mo3kRHFp5MEDhqAdwy1fTGkHAwnkGOVsgpvQhL8B5n1qlb01jV3n/bI0ZfZp5lWA1k4w==",
	}),
	chownr: Object.freeze({
		version: "3.0.0",
		resolved: "https://registry.npmjs.org/chownr/-/chownr-3.0.0.tgz",
		integrity:
			"sha512-+IxzY9BZOQd/XuYPRmrvEVjF/nqj5kgT4kEq7VofrDoM1MxoRjEWkrCC3EtLi59TVawxTAn+orJwFQcrqEN1+g==",
	}),
	minipass: Object.freeze({
		version: "7.1.3",
		resolved: "https://registry.npmjs.org/minipass/-/minipass-7.1.3.tgz",
		integrity:
			"sha512-tEBHqDnIoM/1rXME1zgka9g6Q2lcoCkxHLuc7ODJ5BxbP5d4c2Z5cGgtXAku59200Cx7diuHTOYfSBD8n6mm8A==",
	}),
	minizlib: Object.freeze({
		version: "3.1.0",
		resolved: "https://registry.npmjs.org/minizlib/-/minizlib-3.1.0.tgz",
		integrity:
			"sha512-KZxYo1BUkWD2TVFLr0MQoM8vUUigWD3LlD83a/75BqC+4qE0Hb1Vo5v1FgcfaNXvfXzr+5EhQ6ing/CaBijTlw==",
	}),
	tar: Object.freeze({
		version: TAR_VERSION,
		resolved: TAR_TARBALL_URL,
		integrity: TAR_INTEGRITY,
	}),
	yallist: Object.freeze({
		version: "5.0.0",
		resolved: "https://registry.npmjs.org/yallist/-/yallist-5.0.0.tgz",
		integrity:
			"sha512-YgvUTfwqyc7UXVMrB+SImsVYSmTS8X/tSrtdNZMImM+n7+QTriRXyXim0mBrTXNeqzVF0KWGgHPeiyViFFrNDw==",
	}),
});
export const DEFAULT_SOURCE_WORKER_NAME = "cloudbox-r2";
export const DEFAULT_SOURCE_BUCKET_NAME = "cloudbox-r2";
export const REMOTE_MJS_REF = "499f2b41895a6402747bb3a6ff7e924fdc7c96b3";
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 10_000;

const SETUP_MARKER_KIND = "cloudbox-r2-setup-namespace-v1";
const SETUP_MARKER_FILE = ".cloudbox-r2-setup-managed";
const MANAGED_TARGET_MARKER_KIND = "cloudbox-r2-bootstrap-target-v1";
const MANAGED_TARGET_MARKER_FILE = ".cloudbox-r2-bootstrap-managed.json";
const REMOTE_MJS_CACHE_FILE = `setup-cloudflare-${REMOTE_MJS_REF}.mjs`;
const SETUP_MARKER_CONTENT = `${SETUP_MARKER_KIND}\n`;

function resolveRoot(root = ROOT) {
	if (typeof root !== "string" || !root) fail("缺少有效的源码根目录。");
	return path.resolve(root);
}
function setupRoot(root = ROOT) {
	return path.join(resolveRoot(root), ".wrangler", "setup");
}

async function lstatOrNull(target) {
	try {
		return await lstat(target);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

async function ensureSetupDirectory(directory, label) {
	let info = await lstatOrNull(directory);
	if (info?.isSymbolicLink() || (info && !info.isDirectory()))
		fail(`${label} 必须是普通目录。`);
	if (!info) await mkdir(directory, { recursive: true, mode: 0o700 });
	info = await lstatOrNull(directory);
	if (!info || info.isSymbolicLink() || !info.isDirectory())
		fail(`${label} 必须是普通目录。`);
	return directory;
}

export async function ensureSetupNamespace(root = ROOT) {
	const resolvedRoot = resolveRoot(root);
	const rootInfo = await lstat(resolvedRoot);
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
		fail("源码根目录必须是普通目录。");
	const wranglerDirectory = await ensureSetupDirectory(
		path.join(resolvedRoot, ".wrangler"),
		".wrangler",
	);
	const directory = await ensureSetupDirectory(
		path.join(wranglerDirectory, "setup"),
		".wrangler/setup",
	);
	const marker = path.join(directory, SETUP_MARKER_FILE);
	const markerInfo = await lstatOrNull(marker);
	if (markerInfo) {
		if (markerInfo.isSymbolicLink() || !markerInfo.isFile())
			fail(".wrangler/setup 所有权标记无效。");
		if ((await readFile(marker, "utf8")) !== SETUP_MARKER_CONTENT)
			fail(".wrangler/setup 所有权标记不匹配。");
		return directory;
	}
	await writeFile(marker, SETUP_MARKER_CONTENT, { flag: "wx", mode: 0o600 });
	return directory;
}

function wranglerSafeEnv(root = ROOT) {
	return {
		WRANGLER_LOG: "info",
		WRANGLER_LOG_SANITIZE: "true",
		WRANGLER_LOG_PATH: path.join(setupRoot(root), "wrangler-private.log"),
	};
}
export const WRANGLER_SAFE_ENV = wranglerSafeEnv(ROOT);
export function createSetupContext(root = DEFAULT_ROOT ?? ROOT) {
	const resolvedRoot = resolveRoot(root);
	return Object.freeze({
		root: resolvedRoot,
		setupRoot: setupRoot(resolvedRoot),
		wranglerSafeEnv: wranglerSafeEnv(resolvedRoot),
	});
}

export async function cleanupSetupNamespace(root, { rmImpl = rm } = {}) {
	if (typeof rmImpl !== "function") fail("setup 清理器无效。");
	const resolvedRoot = resolveRoot(root);
	const rootInfo = await lstatOrNull(resolvedRoot);
	if (!rootInfo) return false;
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
		fail("源码根目录必须是普通目录。");
	const wranglerDirectory = path.join(resolvedRoot, ".wrangler");
	const wranglerInfo = await lstatOrNull(wranglerDirectory);
	if (!wranglerInfo) return false;
	if (wranglerInfo.isSymbolicLink() || !wranglerInfo.isDirectory())
		fail(".wrangler 必须是普通目录。");
	const directory = path.join(wranglerDirectory, "setup");
	const directoryInfo = await lstatOrNull(directory);
	if (!directoryInfo) return false;
	if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory())
		fail(".wrangler/setup 必须是普通目录。");
	const expectedDirectory = path.join(
		await realpath(resolvedRoot),
		".wrangler",
		"setup",
	);
	if ((await realpath(directory)) !== expectedDirectory)
		fail(".wrangler/setup 路径校验失败。");
	const marker = path.join(directory, SETUP_MARKER_FILE);
	const markerInfo = await lstatOrNull(marker);
	if (!markerInfo) return false;
	if (markerInfo.isSymbolicLink() || !markerInfo.isFile())
		fail(".wrangler/setup 所有权标记无效。");
	if ((await readFile(marker, "utf8")) !== SETUP_MARKER_CONTENT)
		fail(".wrangler/setup 所有权标记不匹配。");
	await rmImpl(directory, { recursive: true, force: true });
	return true;
}

export async function cleanupMjsCache({
	scriptPath,
	env = process.env,
	rmImpl = rm,
} = {}) {
	if (typeof rmImpl !== "function") fail("MJS 缓存清理器无效。");
	if (typeof scriptPath !== "string" || !scriptPath) return false;
	const cacheHome =
		typeof env?.XDG_CACHE_HOME === "string" && env.XDG_CACHE_HOME
			? env.XDG_CACHE_HOME
			: typeof env?.HOME === "string" && env.HOME
				? path.join(env.HOME, ".cache")
				: null;
	if (!cacheHome) return false;
	if (!path.isAbsolute(cacheHome)) fail("MJS 缓存根目录必须是绝对路径。");
	const cacheDirectory = path.resolve(cacheHome, "cloudbox-r2");
	const resolvedScript = path.resolve(scriptPath);
	if (path.basename(resolvedScript) !== REMOTE_MJS_CACHE_FILE) return false;
	const cacheInfo = await lstatOrNull(cacheDirectory);
	if (!cacheInfo) return false;
	if (cacheInfo.isSymbolicLink() || !cacheInfo.isDirectory())
		fail("MJS 缓存目录必须是普通目录。");
	const scriptInfo = await lstatOrNull(resolvedScript);
	if (!scriptInfo) return false;
	if (scriptInfo.isSymbolicLink() || !scriptInfo.isFile())
		fail("固定 MJS 缓存必须是普通文件。");
	const realCacheDirectory = await realpath(cacheDirectory);
	if (
		(await realpath(resolvedScript)) !==
		path.join(realCacheDirectory, REMOTE_MJS_CACHE_FILE)
	)
		fail("固定 MJS 缓存路径校验失败。");
	await rmImpl(resolvedScript, { force: true });
	return true;
}

function managedTargetInput(value) {
	if (!value || typeof value !== "object") fail("缺少受管理的源码目标。");
	const ref = validateSourceRef(value.ref);
	if (!ref) fail("受管理的源码目标 ref 无效。");
	if (typeof value.cwd !== "string" || typeof value.target !== "string")
		fail("受管理的源码目标路径无效。");
	if (typeof value.marker !== "string" || !/^[0-9a-f]{64}$/.test(value.marker))
		fail("受管理的源码目标标记无效。");
	const cwd = path.resolve(value.cwd);
	const target = path.resolve(value.target);
	const expectedTarget = path.join(
		cwd,
		`${DEFAULT_SOURCE_WORKER_NAME}-${ref.slice(0, 12)}`,
	);
	if (target !== expectedTarget || path.dirname(target) !== cwd)
		fail("受管理的源码目标越出本次 cwd。");
	return { cwd, target, ref, expectedTarget, marker: value.marker };
}

export async function cleanupManagedTarget(
	managedTarget,
	{ rmImpl = rm } = {},
) {
	if (!managedTarget) return false;
	if (typeof rmImpl !== "function") fail("源码目标清理器无效。");
	const { cwd, target, ref, expectedTarget, marker } =
		managedTargetInput(managedTarget);
	const cwdInfo = await lstatOrNull(cwd);
	if (!cwdInfo) return false;
	if (cwdInfo.isSymbolicLink() || !cwdInfo.isDirectory())
		fail("源码目标 cwd 必须是普通目录。");
	const realCwd = await realpath(cwd);
	const targetInfo = await lstatOrNull(target);
	if (!targetInfo) return false;
	if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory())
		fail("受管理的源码目标不是普通目录。");
	if (
		(await realpath(target)) !==
		path.join(realCwd, path.basename(expectedTarget))
	)
		fail("受管理的源码目标路径校验失败。");
	const markerPath = path.join(target, MANAGED_TARGET_MARKER_FILE);
	const markerInfo = await lstatOrNull(markerPath);
	if (!markerInfo || markerInfo.isSymbolicLink() || !markerInfo.isFile())
		fail("受管理的源码目标标记缺失或无效。");
	let metadata;
	try {
		metadata = JSON.parse(await readFile(markerPath, "utf8"));
	} catch {
		fail("受管理的源码目标标记无法读取。");
	}
	const fields = Object.keys(metadata ?? {}).sort();
	if (
		fields.join(",") !== "kind,ref,target,token" ||
		metadata.kind !== MANAGED_TARGET_MARKER_KIND ||
		metadata.ref !== ref ||
		metadata.target !== expectedTarget ||
		metadata.token !== marker
	)
		fail("受管理的源码目标标记不匹配。");
	await rmImpl(target, { recursive: true, force: true });
	return true;
}

async function removeOwnedBootstrapDirectory(owned, cwd, ref) {
	if (!owned) return;
	const normalizedRef = validateSourceRef(ref);
	if (!normalizedRef) fail("bootstrap 临时目录 ref 无效。");
	const resolvedCwd = path.resolve(cwd);
	const resolvedOwned = path.resolve(owned);
	const prefix = `.cloudbox-r2-bootstrap-${normalizedRef.slice(0, 12)}-`;
	if (
		path.dirname(resolvedOwned) !== resolvedCwd ||
		!path.basename(resolvedOwned).startsWith(prefix)
	)
		fail("bootstrap 临时目录越出本次 cwd。");
	const cwdInfo = await lstatOrNull(resolvedCwd);
	if (!cwdInfo) return;
	if (cwdInfo.isSymbolicLink() || !cwdInfo.isDirectory())
		fail("bootstrap 临时目录 cwd 必须是普通目录。");
	const info = await lstatOrNull(resolvedOwned);
	if (!info) return;
	if (info.isSymbolicLink() || !info.isDirectory())
		fail("bootstrap 临时目录必须是普通目录。");
	if (
		(await realpath(resolvedOwned)) !==
		path.join(await realpath(resolvedCwd), path.basename(resolvedOwned))
	)
		fail("bootstrap 临时目录路径校验失败。");
	await rm(resolvedOwned, { recursive: true, force: true });
}

export async function cleanupLocalState({
	managedTarget = null,
	root = null,
	scriptPath = null,
	env = process.env,
	rmImpl = rm,
} = {}) {
	const warnings = [];
	const attempt = async (label, action) => {
		try {
			await action();
		} catch {
			warnings.push(label);
		}
	};
	if (managedTarget)
		await attempt("源码副本", () =>
			cleanupManagedTarget(managedTarget, { rmImpl }),
		);
	if (root)
		await attempt("setup 临时目录", () =>
			cleanupSetupNamespace(root, { rmImpl }),
		);
	if (scriptPath)
		await attempt("MJS 缓存", () =>
			cleanupMjsCache({ scriptPath, env, rmImpl }),
		);
	return warnings;
}

const AUTH_ENV_NAMES = new Set([
	"CLOUDFLARE_API_TOKEN",
	"CLOUDFLARE_API_KEY",
	"CLOUDFLARE_EMAIL",
	"CLOUDFLARE_ACCOUNT_ID",
	"CLOUDFLARE_API_BASE_URL",
	"CF_API_TOKEN",
	"CF_API_KEY",
	"CF_EMAIL",
	"CF_ACCOUNT_ID",
	"CF_API_BASE_URL",
	"WRANGLER_API_TOKEN",
	"WRANGLER_LOG",
	"WRANGLER_LOG_PATH",
	"WRANGLER_LOG_SANITIZE",
	"WRANGLER_SEND_METRICS",
	"NODE_OPTIONS",
]);

export function validateApiToken(value) {
	return typeof value === "string" &&
		/^\S+$/.test(value) &&
		byteLength(value) <= 512
		? value
		: null;
}
function cleanParentEnv() {
	return Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !AUTH_ENV_NAMES.has(name)),
	);
}
export function wranglerEnv(
	apiToken,
	accountId,
	overrides = {},
	root = DEFAULT_ROOT ?? ROOT,
) {
	if (!validateApiToken(apiToken)) fail("Cloudflare API Token 格式无效。");
	return {
		...cleanParentEnv(),
		...wranglerSafeEnv(root),
		...Object.fromEntries(
			Object.entries(overrides).filter(([name]) => !AUTH_ENV_NAMES.has(name)),
		),
		CLOUDFLARE_API_TOKEN: apiToken,
		CLOUDFLARE_ACCOUNT_ID: accountId,
	};
}

export function byteLength(value) {
	return encoder.encode(value).byteLength;
}
export function validateWorkerName(value) {
	return typeof value === "string" && NAME.test(value) ? value : null;
}
export function validateBucketName(value) {
	return typeof value === "string" && NAME.test(value) && value.length >= 3
		? value
		: null;
}
export function validateUsername(value) {
	return value.length > 0 && byteLength(value) <= 256 ? value : null;
}
export function validateAdminPath(value) {
	return ADMIN_PATH.test(value) ? value : null;
}
export function validatePassword(value, username) {
	return byteLength(value) >= 6 && byteLength(value) <= 16 && value !== username
		? value
		: null;
}
export function makeSecrets({ adminPath, username, password }) {
	const generated = Array.from({ length: 4 }, () =>
		randomBytes(32).toString("hex"),
	);
	const values = [username, password, ...generated];
	if (new Set(values).size !== values.length)
		throw new Error("Generated secret collision");
	return {
		CLOUDBOX_R2_ADMIN_PATH: adminPath,
		ADMIN_USERNAME: username,
		ADMIN_PASSWORD: password,
		ADMIN_SESSION_SECRET: generated[0],
		PUBLIC_ACCESS_SESSION_SECRET: generated[1],
		PUBLIC_ACCESS_PASSWORD_PEPPER: generated[2],
		TRANSFER_SESSION_SECRET: generated[3],
	};
}

function fail(message) {
	throw new Error(message);
}
function ask(rl, question, validator, message) {
	return rl.question(question).then((value) => {
		const valid = validator(value);
		if (!valid) fail(message);
		return valid;
	});
}
export async function askSecret(
	rl,
	question,
	validator,
	message,
	{ inputStream = stdin, outputStream = stdout } = {},
) {
	if (!inputStream.isTTY) return ask(rl, question, validator, message);
	outputStream.write(question);
	rl.pause();
	const savedListeners = Object.fromEntries(
		["keypress", "data", "end"].map((event) => [
			event,
			inputStream.listeners(event),
		]),
	);
	const originalRaw = inputStream.isRaw ?? false;
	for (const event of Object.keys(savedListeners))
		inputStream.removeAllListeners(event);
	inputStream.resume();
	inputStream.setRawMode(true);
	let value = "";
	return await new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			if (settled) return;
			settled = true;
			inputStream.off("data", onData);
			inputStream.off("end", onEnd);
			inputStream.setRawMode(originalRaw);
			for (const [event, listeners] of Object.entries(savedListeners))
				for (const listener of listeners) inputStream.on(event, listener);
			inputStream.resume();
			rl.resume();
		};
		const onEnd = () => {
			cleanup();
			reject(new Error("输入已结束。"));
		};
		const onData = (chunk) => {
			for (const character of String(chunk)) {
				if (character.charCodeAt(0) === 3 || character.charCodeAt(0) === 4) {
					cleanup();
					reject(new Error("操作已取消。"));
					return;
				}
				if (character.charCodeAt(0) === 13 || character.charCodeAt(0) === 10) {
					const valid = validator(value);
					if (!valid) {
						cleanup();
						reject(new Error(message));
						return;
					}
					outputStream.write("\n");
					cleanup();
					resolve(valid);
					return;
				}
				if (character.charCodeAt(0) === 127) value = value.slice(0, -1);
				else if (character >= " ") value += character;
			}
		};
		inputStream.on("data", onData);
		inputStream.once("end", onEnd);
	});
}
function confirm(value) {
	return /^(y|yes)$/i.test(value.trim());
}
function appendLimitedOutput(state, chunk) {
	if (state.truncated) return false;
	const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
	const remaining = state.limit - state.bytes;
	if (remaining <= 0) {
		state.truncated = true;
		return true;
	}
	const selected =
		buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
	state.chunks.push(selected);
	state.bytes += selected.byteLength;
	if (selected.byteLength < buffer.byteLength) {
		state.truncated = true;
		return true;
	}
	return false;
}

function killChild(child, signal, killProcessGroup) {
	const pid = Number(child?.pid);
	try {
		if (
			process.platform === "win32" &&
			killProcessGroup &&
			Number.isSafeInteger(pid) &&
			pid > 0
		) {
			spawn(
				"taskkill",
				["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
				{
					shell: false,
					windowsHide: true,
					stdio: "ignore",
				},
			);
			return;
		}
		if (killProcessGroup && process.platform !== "win32" && pid > 0)
			process.kill(-pid, signal);
		else child.kill(signal);
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
	}
}

export async function runCommand(command, args, options = {}) {
	const {
		input,
		capture = false,
		timeoutMs = 0,
		killGraceMs = COMMAND_TERM_GRACE_MS,
		maxOutputBytes = MAX_COMMAND_OUTPUT_BYTES,
		killProcessGroup = true,
		abortSignal = null,
		root = DEFAULT_ROOT ?? ROOT,
		...spawnOptions
	} = options;
	if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0)
		fail("子进程输出上限必须是非负整数。");
	if (abortSignal?.aborted) return Promise.reject(new Error("操作已取消。"));
	return new Promise((resolve, reject) => {
		const detached = killProcessGroup && process.platform !== "win32";
		const child = spawn(command, args, {
			...spawnOptions,
			shell: false,
			detached,
			cwd: resolveRoot(root),
			env: spawnOptions.env ?? cleanParentEnv(),
			stdio: [
				input === undefined ? "inherit" : "pipe",
				capture ? "pipe" : "inherit",
				capture ? "pipe" : "inherit",
			],
		});
		const stdoutState = {
			chunks: [],
			bytes: 0,
			limit: maxOutputBytes,
			truncated: false,
		};
		const stderrState = {
			chunks: [],
			bytes: 0,
			limit: maxOutputBytes,
			truncated: false,
		};
		if (capture) {
			child.stdout.on("data", (chunk) => {
				if (appendLimitedOutput(stdoutState, chunk)) beginTermination("output");
			});
			child.stderr.on("data", (chunk) => {
				if (appendLimitedOutput(stderrState, chunk)) beginTermination("output");
			});
		}
		let timedOut = false;
		let aborted = false;
		let timeoutTimer = null;
		let killTimer = null;
		let termination = null;
		let closeInfo = null;
		let settled = false;
		const clearTimers = () => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			timeoutTimer = null;
			killTimer = null;
		};
		const cleanupChild = () => {
			abortSignal?.removeEventListener("abort", onAbort);
			child.removeListener("error", onError);
			child.removeListener("close", onClose);
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.unref?.();
		};
		const rejectOnce = (error) => {
			if (settled) return;
			settled = true;
			clearTimers();
			cleanupChild();
			reject(error);
		};
		const resolveOnce = (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimers();
			cleanupChild();
			resolve({
				code,
				signal,
				timedOut,
				aborted,
				stdout: capture ? Buffer.concat(stdoutState.chunks).toString() : "",
				stderr: capture ? Buffer.concat(stderrState.chunks).toString() : "",
				stdoutTruncated: capture && stdoutState.truncated,
				stderrTruncated: capture && stderrState.truncated,
			});
		};
		const forceKill = () => {
			if (settled) return;
			try {
				killChild(child, "SIGKILL", killProcessGroup);
			} catch (error) {
				rejectOnce(error);
				return;
			}
			resolveOnce(closeInfo?.code ?? null, "SIGKILL");
		};
		const beginTermination = (reason) => {
			if (settled || termination) return;
			termination = reason;
			timedOut = reason === "timeout";
			aborted = reason === "abort";
			try {
				killChild(child, "SIGTERM", killProcessGroup);
			} catch (error) {
				rejectOnce(error);
				return;
			}
			killTimer = setTimeout(forceKill, Math.max(0, killGraceMs));
		};
		const onAbort = () => beginTermination("abort");
		const onError = (error) => {
			if (!termination) rejectOnce(error);
		};
		const onClose = (code, signal) => {
			closeInfo = { code, signal };
			if (!termination) resolveOnce(code, signal);
		};
		if (abortSignal)
			abortSignal.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs > 0) {
			timeoutTimer = setTimeout(() => beginTermination("timeout"), timeoutMs);
			timeoutTimer.unref?.();
		}
		if (input !== undefined) {
			child.stdin.on("error", (error) => {
				if (error.code !== "EPIPE") rejectOnce(error);
			});
			child.stdin.end(input);
		}
		child.once("error", onError);
		child.once("close", onClose);
	});
}

function assertCommandSafe(result, label) {
	if (result?.aborted) fail(`${label} 已取消，已停止。`);
	if (result?.timedOut) fail(`${label} 超时，已停止。`);
	if (result?.stdoutTruncated || result?.stderrTruncated)
		fail(`${label} 输出超过上限，已停止。`);
}

function assertCommandSuccess(result, label) {
	assertCommandSafe(result, label);
	if (result?.code !== 0)
		fail(`${label} 失败（退出码 ${result?.code ?? "unknown"}）。`);
}

async function npmPath() {
	const nodeDirectory = path.dirname(await realpath(process.execPath));
	const candidates = [
		path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
		path.join(
			nodeDirectory,
			"..",
			"lib",
			"node_modules",
			"npm",
			"bin",
			"npm-cli.js",
		),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			const cli = await realpath(candidate);
			return { command: process.execPath, args: [cli] };
		}
	}
	const npmLink = path.join(nodeDirectory, "npm");
	if (existsSync(npmLink)) {
		const cli = await realpath(npmLink);
		if (cli.endsWith(`${path.sep}npm-cli.js`))
			return { command: process.execPath, args: [cli] };
	}
	return null;
}

export async function ensurePnpm({
	run = runCommand,
	npm,
	confirmDownload = async () => false,
	root = DEFAULT_ROOT ?? ROOT,
} = {}) {
	const expected = PNPM_VERSION;
	const resolvedRoot = resolveRoot(root);
	npm ??= await npmPath();
	const configured = "pnpm";
	const version = await run(configured, ["--version"], {
		capture: true,
		timeoutMs: WORKFLOW_TIMEOUT_MS,
		env: cleanParentEnv(),
		root: resolvedRoot,
		killProcessGroup: true,
	}).catch(() => null);
	if (version) assertCommandSafe(version, "检查 pnpm");
	if (version?.code === 0 && version.stdout.trim() === expected)
		return { command: configured, args: [] };
	if (!npm)
		fail(`找不到官方 Node.js 附带的 npm，无法准备固定 pnpm@${PNPM_VERSION}。`);
	if (!(await confirmDownload()))
		fail(`未同意下载固定 pnpm@${PNPM_VERSION}，已停止。`);
	const setupDirectory = await ensureSetupNamespace(resolvedRoot);
	const installRoot = path.join(setupDirectory, "pnpm");
	await mkdir(installRoot, { recursive: true });
	const npmTool = typeof npm === "string" ? { command: npm, args: [] } : npm;
	const result = await run(
		npmTool.command,
		[
			...npmTool.args,
			"install",
			"--prefix",
			installRoot,
			"--no-package-lock",
			"--ignore-scripts",
			`pnpm@${PNPM_VERSION}`,
		],
		{
			capture: true,
			timeoutMs: WORKFLOW_TIMEOUT_MS,
			env: cleanParentEnv(),
			root: resolvedRoot,
			killProcessGroup: true,
		},
	);
	assertCommandSuccess(result, `准备固定 pnpm@${PNPM_VERSION}`);
	const cli = path.join(installRoot, "node_modules", "pnpm", "bin", "pnpm.cjs");
	const check = await run(process.execPath, [cli, "--version"], {
		capture: true,
		env: cleanParentEnv(),
		root: resolvedRoot,
		killProcessGroup: true,
	});
	assertCommandSuccess(check, `检查准备出的 pnpm@${PNPM_VERSION}`);
	if (check.stdout.trim() !== expected)
		fail(`准备出的 pnpm 版本不是 ${PNPM_VERSION}，已停止。`);
	return {
		command: process.execPath,
		args: [cli],
		env: {
			PATH: `${path.join(installRoot, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
		},
	};
}

export function wranglerPath(root = DEFAULT_ROOT ?? ROOT) {
	const resolvedRoot = resolveRoot(root);
	const candidates = [
		path.join(
			resolvedRoot,
			"packages/worker/node_modules/wrangler/bin/wrangler.js",
		),
		path.join(resolvedRoot, "node_modules/wrangler/bin/wrangler.js"),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
async function runTool(tool, args, options = {}) {
	return runCommand(tool.command, [...tool.args, ...args], {
		...options,
		killProcessGroup: true,
		env: { ...cleanParentEnv(), ...tool.env, ...options.env },
	});
}
export async function wrangler(args, options = {}) {
	const {
		run = runCommand,
		root = DEFAULT_ROOT ?? ROOT,
		...runOptions
	} = options;
	const resolvedRoot = resolveRoot(root);
	const cli = wranglerPath(resolvedRoot);
	if (!cli)
		fail(
			`缺少锁定的 Wrangler ${WRANGLER_VERSION}，请先完成 pnpm install --frozen-lockfile。`,
		);
	const setupDirectory = await ensureSetupNamespace(resolvedRoot);
	const logDirectory = path.join(
		setupDirectory,
		"logs",
		`run-${Date.now()}-${randomBytes(4).toString("hex")}`,
	);
	await mkdir(logDirectory, { recursive: true, mode: 0o700 });
	const logPath = path.join(logDirectory, "wrangler.log");
	try {
		const result = await run(process.execPath, [cli, ...args], {
			...runOptions,
			killProcessGroup: true,
			root: resolvedRoot,
			timeoutMs: runOptions.timeoutMs ?? WORKFLOW_TIMEOUT_MS,
			env: {
				...cleanParentEnv(),
				...wranglerSafeEnv(resolvedRoot),
				WRANGLER_LOG_PATH: logPath,
				...(args[0] === "secret" && { WRANGLER_LOG: "none" }),
				...Object.fromEntries(
					Object.entries(runOptions.env ?? {}).filter(
						([name]) => !AUTH_ENV_NAMES.has(name),
					),
				),
				...(runOptions.env?.CLOUDFLARE_API_TOKEN && {
					CLOUDFLARE_API_TOKEN: runOptions.env.CLOUDFLARE_API_TOKEN,
				}),
				...(runOptions.env?.CLOUDFLARE_ACCOUNT_ID && {
					CLOUDFLARE_ACCOUNT_ID: runOptions.env.CLOUDFLARE_ACCOUNT_ID,
				}),
			},
		});
		assertCommandSafe(result, "Wrangler");
		return result;
	} finally {
		await rm(logDirectory, { recursive: true, force: true }).catch(() => {});
	}
}

function parseJsonOutput(result, stage) {
	if (!result.stdout?.trim()) return null;
	try {
		return JSON.parse(result.stdout);
	} catch {
		if (result.code === 0) fail(`${stage} 返回无法解析的结果，已停止。`);
		return null;
	}
}
function hasApiCode(value, code) {
	return (
		value?.code === code ||
		value?.error?.code === code ||
		value?.errors?.some?.((error) => error.code === code)
	);
}
function isExplicitNotFound(kind, result, value) {
	const code = kind === "Worker" ? 10007 : 10006;
	return (
		hasApiCode(value, code) ||
		new RegExp(`(?:code|error_code)[^0-9]{0,8}${code}`).test(
			result.stderr ?? "",
		)
	);
}
export async function assertMissingResource(kind, args, runner = wrangler) {
	const result = await runner(args, {
		capture: true,
		timeoutMs: WORKFLOW_TIMEOUT_MS,
		killProcessGroup: true,
	});
	assertCommandSafe(result, kind);
	const parsed = parseJsonOutput(result, kind);
	if (result.code === 0) fail(`目标 ${kind} 已存在，已停止。`);
	if (isExplicitNotFound(kind, result, parsed)) return;
	fail(
		`${kind} 预检失败（未确认不存在，退出码 ${result.code ?? "unknown"}），已停止。`,
	);
}

function tomlString(value) {
	return JSON.stringify(String(value).replaceAll("\\", "/"));
}

function tomlFieldEntries(lines, field, { topLevel = false } = {}) {
	const matcher = new RegExp(`^\\s*${field}\\s*=\\s*"([^"]+)"\\s*$`);
	let table = null;
	const entries = [];
	for (const [index, line] of lines.entries()) {
		const tableMatch = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
		if (tableMatch) {
			table = tableMatch[1];
			continue;
		}
		const match = line.match(matcher);
		if (match && (!topLevel || table === null))
			entries.push({ index, value: match[1] });
	}
	return entries;
}

export async function deriveConfig(
	workerName,
	bucketName,
	accountId,
	runId = `${Date.now()}-${randomBytes(4).toString("hex")}`,
	options = {},
) {
	const configOptions = runId && typeof runId === "object" ? runId : options;
	const configRunId =
		runId && typeof runId === "object"
			? `${Date.now()}-${randomBytes(4).toString("hex")}`
			: runId;
	const { root = DEFAULT_ROOT ?? ROOT } = configOptions;
	if (typeof configRunId !== "string" || !/^[A-Za-z0-9_-]+$/.test(configRunId))
		fail("配置临时目录标识无效。");
	if (!validateWorkerName(workerName)) fail("Worker 名称格式无效。");
	if (!validateBucketName(bucketName)) fail("bucket 名称格式无效。");
	if (!/^[a-f0-9]{32}$/i.test(accountId)) fail("账号 ID 格式无效。");
	const resolvedRoot = resolveRoot(root);
	const source = await readFile(
		path.join(resolvedRoot, "wrangler.toml"),
		"utf8",
	);
	const lines = source.split("\n");
	const replaceExactlyOne = (matcher, replacement, label) => {
		const indexes = lines.flatMap((line, index) =>
			matcher.test(line) ? [index] : [],
		);
		if (indexes.length !== 1) fail(`根配置字段替换次数不正确：${label}`);
		const index = indexes[0];
		const indent = lines[index].match(/^\s*/)?.[0] ?? "";
		lines[index] = `${indent}${replacement}`;
	};
	const workerNames = tomlFieldEntries(lines, "name", { topLevel: true });
	if (workerNames.length !== 1) fail("根配置必须包含唯一的 Worker 名称。");
	const nameIndex = workerNames[0].index;
	const nameIndent = lines[nameIndex].match(/^\s*/)?.[0] ?? "";
	lines[nameIndex] = `${nameIndent}name = ${tomlString(workerName)}`;
	const accountIndexes = lines.flatMap((line, index) =>
		/^\s*account_id\s*=\s*"[^"]*"\s*$/.test(line) ||
		line.trim() === "# setup-account-id"
			? [index]
			: [],
	);
	if (accountIndexes.length > 1) fail("根配置中的 account_id 占位字段不唯一。");
	if (accountIndexes.length === 1) {
		const index = accountIndexes[0];
		const indent = lines[index].match(/^\s*/)?.[0] ?? "";
		lines[index] = `${indent}account_id = ${tomlString(accountId)}`;
	} else {
		lines.splice(nameIndex + 1, 0, `account_id = ${tomlString(accountId)}`);
	}
	replaceExactlyOne(
		/^\s*main\s*=\s*"src\/index\.ts"\s*$/,
		`main = ${tomlString(path.join(resolvedRoot, "src/index.ts"))}`,
		"main",
	);
	replaceExactlyOne(
		/^\s*assets\s*=.*directory\s*=\s*"packages\/dashboard\/dist".*$/,
		lines
			.find((line) => line.includes('directory = "packages/dashboard/dist"'))
			?.replace(
				'directory = "packages/dashboard/dist"',
				`directory = ${tomlString(path.join(resolvedRoot, "packages/dashboard/dist"))}`,
			) ?? "",
		"assets directory",
	);
	const bucketFields = tomlFieldEntries(lines, "bucket_name");
	if (bucketFields.length !== 1 || !validateBucketName(bucketFields[0]?.value))
		fail("根配置必须包含唯一且合法的 R2 bucket 名称。");
	replaceExactlyOne(
		/^\s*bucket_name\s*=\s*"[^"]+"\s*$/,
		`bucket_name = ${tomlString(bucketName)}`,
		"bucket_name",
	);
	const setupDirectory = await ensureSetupNamespace(resolvedRoot);
	const directory = path.join(setupDirectory, configRunId);
	await mkdir(directory, { recursive: true });
	const config = path.join(directory, "wrangler.toml");
	await writeFile(config, lines.join("\n"), { mode: 0o600 });
	return config;
}

export async function secretBulk(config, secrets, runner = wrangler) {
	const keys = Object.keys(secrets ?? {});
	if (
		keys.length !== SECRET_NAMES.length ||
		SECRET_NAMES.some((name) => !keys.includes(name))
	)
		fail("secrets 映射必须恰好包含七项受支持的名称。");
	for (const name of SECRET_NAMES) {
		if (
			typeof secrets[name] !== "string" ||
			byteLength(secrets[name]) === 0 ||
			byteLength(secrets[name]) > 1024
		)
			fail(`secret ${name} 的值必须是 1–1024 UTF-8 字节。`);
	}
	if (!validateAdminPath(secrets.CLOUDBOX_R2_ADMIN_PATH))
		fail("管理入口必须是 5–12 个 ASCII 字符。");
	if (!validateUsername(secrets.ADMIN_USERNAME))
		fail("用户名不能为空且最多 256 UTF-8 字节。");
	if (!validatePassword(secrets.ADMIN_PASSWORD, secrets.ADMIN_USERNAME))
		fail("密码需 6–16 UTF-8 字节且不能等于用户名。");
	const generated = SECRET_NAMES.slice(3).map((name) => secrets[name]);
	if (generated.some((value) => byteLength(value) < 32))
		fail("会话 secrets 和 pepper 必须至少 32 UTF-8 字节。");
	if (
		new Set([secrets.ADMIN_USERNAME, secrets.ADMIN_PASSWORD, ...generated])
			.size !== 6
	)
		fail("管理员凭据与生成的 secrets 必须互不相同。");
	const input = `${JSON.stringify(secrets)}\n`;
	const result = await runner(["secret", "bulk", "--config", config], {
		input,
		capture: true,
		timeoutMs: WORKFLOW_TIMEOUT_MS,
		killProcessGroup: true,
	});
	assertCommandSafe(result, "上传 secrets");
	if (result.code !== 0)
		fail(
			`上传 secrets 失败（退出码 ${result.code ?? "unknown"}），未显示原始 Wrangler 输出。`,
		);
}

const ANSI_ESCAPE = new RegExp(
	`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
	"g",
);

function stripAnsi(value) {
	return value.replace(ANSI_ESCAPE, "");
}

function workerDeploymentOrigin(value, workerName) {
	try {
		const authority = value.slice("https://".length).split(/[/?#]/, 1)[0];
		if (authority.includes("@") || authority.includes(":")) return null;
		const parsed = new URL(value);
		const labels = parsed.hostname.split(".");
		if (
			parsed.protocol !== "https:" ||
			parsed.username ||
			parsed.password ||
			parsed.port ||
			parsed.pathname !== "/" ||
			parsed.search ||
			parsed.hash ||
			labels.length !== 4 ||
			labels[0] !== workerName ||
			!NAME.test(labels[1]) ||
			labels[2] !== "workers" ||
			labels[3] !== "dev"
		)
			return null;
		return parsed.origin;
	} catch {
		return null;
	}
}

function deploymentUrlResult(output, workerName) {
	const cleanOutput = typeof output === "string" ? stripAnsi(output) : "";
	const urls = [
		...new Set(
			[...cleanOutput.matchAll(/https:\/\/[^\s]+/gi)].map(([value]) =>
				value.replace(/[),.;]+$/, ""),
			),
		),
	];
	const candidates = [
		...new Set(
			urls
				.map((value) => workerDeploymentOrigin(value, workerName))
				.filter(Boolean),
		),
	];
	const url =
		candidates.length === 1 &&
		urls.every(
			(value) => workerDeploymentOrigin(value, workerName) === candidates[0],
		)
			? candidates[0]
			: null;
	return { urls, candidates, url };
}

export function deploymentUrl(output, workerName, options = {}) {
	const { urls, candidates, url } = deploymentUrlResult(output, workerName);
	const optional = options === true || options?.optional === true;
	if (url || optional) return url;
	fail(
		candidates.length > 1 || urls.length > 1
			? "部署输出包含多个冲突的 workers.dev 地址，已停止。"
			: urls.length
				? "部署输出中的 workers.dev 地址不是本次 Worker，已停止。"
				: "未能从受验证的部署输出提取 workers.dev 地址。",
	);
}

export function extractDeploymentUrl(output, workerName) {
	return deploymentUrl(output, workerName, { optional: true });
}

export async function checkHome(url, fetchImpl = fetch, timeoutMs = 10_000) {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let response;
		try {
			response = await fetchImpl(url, {
				redirect: "error",
				signal: controller.signal,
			});
			if (response.status === 200) {
				const body = await response.text();
				if (body.includes("cloudbox-r2") || body.includes("Cloudbox")) return;
			}
		} catch (error) {
			if (error?.name === "AbortError") fail("首页验证超时。");
			throw error;
		} finally {
			clearTimeout(timer);
		}
		if (response.status >= 500)
			fail(`首页验证失败（HTTP ${response.status}）。`);
	}
	fail("首页验证未找到预期页面标记。");
}

async function supportsDynamicDeploymentValidator(root) {
	const validator = path.join(root, "scripts/validate-deploy-config.mjs");
	const source = await readFile(validator, "utf8").catch(() => "");
	return (
		source.includes("--config") &&
		source.includes("--worker-name") &&
		source.includes("--bucket-name")
	);
}

export async function runWorkflow({
	pnpm,
	workerName,
	bucketName,
	accountId,
	apiToken,
	secrets,
	run = runCommand,
	wranglerRunner = wrangler,
	confirm = async () => false,
	fetchImpl = fetch,
	onStage = () => {},
	root = DEFAULT_ROOT ?? ROOT,
} = {}) {
	const resolvedRoot = resolveRoot(root);
	if (!validateApiToken(apiToken)) fail("Cloudflare API Token 格式无效。");
	const config = await deriveConfig(
		workerName,
		bucketName,
		accountId,
		undefined,
		{
			root: resolvedRoot,
		},
	);
	const callWrangler = async (args, options = {}) => {
		try {
			return await wranglerRunner(args, {
				...options,
				killProcessGroup: true,
				root: resolvedRoot,
				env: wranglerEnv(apiToken, accountId, options.env, resolvedRoot),
			});
		} catch {
			fail("Wrangler 阶段失败，原始错误未显示。");
		}
	};
	await validateCanonicalSourceConfig(resolvedRoot);
	const validationArgs = [
		"validate-deploy-config",
		"--",
		"--config",
		config,
		"--worker-name",
		workerName,
		"--bucket-name",
		bucketName,
	];
	if (await supportsDynamicDeploymentValidator(resolvedRoot)) {
		const validation = await runToolWith(run, pnpm, validationArgs, {
			capture: true,
			timeoutMs: WORKFLOW_TIMEOUT_MS,
			killProcessGroup: true,
			root: resolvedRoot,
		});
		assertCommandSuccess(validation, "validate-deploy-config");
		const validated = await run(
			process.execPath,
			[
				path.join(resolvedRoot, "scripts/validate-deploy-config.mjs"),
				"--config",
				config,
				"--worker-name",
				workerName,
				"--bucket-name",
				bucketName,
			],
			{
				capture: true,
				timeoutMs: WORKFLOW_TIMEOUT_MS,
				env: cleanParentEnv(),
				killProcessGroup: true,
				root: resolvedRoot,
			},
		);
		assertCommandSuccess(validated, "部署配置校验");
	}
	const build = await runToolWith(run, pnpm, ["build"], {
		capture: true,
		timeoutMs: WORKFLOW_TIMEOUT_MS,
		killProcessGroup: true,
		root: resolvedRoot,
	});
	assertCommandSuccess(build, "build");
	const dryRun = await callWrangler(
		["deploy", "--config", config, "--dry-run"],
		{ capture: true, timeoutMs: WORKFLOW_TIMEOUT_MS, killProcessGroup: true },
	);
	assertCommandSuccess(dryRun, "Wrangler dry-run");
	const preflight = async () => {
		await assertMissingResource(
			"Worker",
			[
				"deployments",
				"list",
				"--name",
				workerName,
				"--json",
				"--config",
				config,
			],
			callWrangler,
		);
		await assertMissingResource(
			"R2 bucket",
			["r2", "bucket", "info", bucketName, "--json", "--config", config],
			callWrangler,
		);
	};
	await preflight();
	if (!(await confirm({ accountId, workerName, bucketName })))
		return { config, completed: [] };
	await preflight();
	let created;
	try {
		created = await callWrangler(
			["r2", "bucket", "create", bucketName, "--config", config],
			{
				capture: true,
				timeoutMs: WORKFLOW_TIMEOUT_MS,
				killProcessGroup: true,
				env: cleanParentEnv(),
			},
		);
	} catch (error) {
		onStage(`R2 bucket ${bucketName} 可能已创建`);
		throw error;
	}
	try {
		assertCommandSuccess(created, "创建 R2 bucket");
	} catch (error) {
		onStage(`R2 bucket ${bucketName} 可能已创建`);
		throw error;
	}
	onStage(`R2 bucket ${bucketName}`);
	try {
		await secretBulk(config, secrets, callWrangler);
	} catch (error) {
		onStage("七项 secrets 可能部分写入");
		throw error;
	}
	onStage("七项 secrets");
	let deployed;
	try {
		deployed = await callWrangler(["deploy", "--config", config], {
			capture: true,
			timeoutMs: WORKFLOW_TIMEOUT_MS,
			killProcessGroup: true,
		});
	} catch (error) {
		onStage(`Worker ${workerName} 可能已部署`);
		throw error;
	}
	try {
		assertCommandSuccess(deployed, "部署 Worker");
	} catch (error) {
		onStage(`Worker ${workerName} 可能已部署`);
		throw error;
	}
	onStage(`Worker ${workerName}`);
	const url = extractDeploymentUrl(
		`${deployed.stdout ?? ""}\n${deployed.stderr ?? ""}`,
		workerName,
	);
	if (!url) return { config, url: null };
	await checkHome(`${url}/`, fetchImpl);
	return { config, url };
}

function runToolWith(run, tool, args, options) {
	return run(tool.command, [...tool.args, ...args], {
		...options,
		killProcessGroup: true,
		env: { ...cleanParentEnv(), ...tool.env, ...options?.env },
	});
}

export function validateSourceRef(value) {
	return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value)
		? value.toLowerCase()
		: null;
}

export function sourceArchiveUrl(ref = DEFAULT_SOURCE_REF) {
	const normalized = validateSourceRef(ref);
	if (!normalized) fail("源码 ref 必须是完整 40 位十六进制 commit SHA。");
	return `https://${SOURCE_ARCHIVE_HOST}/${SOURCE_REPOSITORY}/tar.gz/${normalized}`;
}

function assertSourceArchiveUrl(value, ref) {
	const normalized = validateSourceRef(ref);
	if (!normalized) fail("源码 ref 必须是完整 40 位十六进制 commit SHA。");
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		fail("源码下载地址无效。");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.hostname !== SOURCE_ARCHIVE_HOST ||
		parsed.port ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		parsed.pathname !== `/${SOURCE_REPOSITORY}/tar.gz/${normalized}`
	)
		fail("源码下载地址不是受支持的固定 GitHub codeload 地址。");
	return parsed.href;
}

class ByteLimitTransform extends Transform {
	constructor(limit) {
		super();
		this.limit = limit;
		this.bytes = 0;
	}

	_transform(chunk, encoding, callback) {
		const buffer = Buffer.isBuffer(chunk)
			? chunk
			: Buffer.from(chunk, encoding);
		const total = this.bytes + buffer.byteLength;
		if (total > this.limit) {
			callback(new Error(`源码归档下载大小超过 ${this.limit} 字节上限。`));
			return;
		}
		this.bytes = total;
		callback(null, buffer);
	}
}

async function responseReadable(response) {
	if (response?.body?.getReader) return Readable.fromWeb(response.body);
	if (
		response?.body &&
		typeof response.body[Symbol.asyncIterator] === "function"
	)
		return Readable.from(response.body);
	if (response?.body !== undefined && response?.body !== null)
		return Readable.from([response.body]);
	if (typeof response?.arrayBuffer === "function")
		return Readable.from([Buffer.from(await response.arrayBuffer())]);
	fail("源码下载响应没有可读取的响应体。");
}

export async function downloadArchive({
	ref = DEFAULT_SOURCE_REF,
	url = sourceArchiveUrl(ref),
	destination,
	fetchImpl = fetch,
	maxBytes = MAX_ARCHIVE_BYTES,
	timeoutMs = DOWNLOAD_TIMEOUT_MS,
	signal = null,
} = {}) {
	const archiveUrl = assertSourceArchiveUrl(url, ref);
	if (!destination) fail("源码归档缺少临时目标路径。");
	const controller = new AbortController();
	let externallyAborted = false;
	const onAbort = () => {
		externallyAborted = true;
		controller.abort();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	const timer =
		timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
	timer?.unref?.();
	try {
		const response = await fetchImpl(archiveUrl, {
			redirect: "error",
			signal: controller.signal,
		});
		const status = Number(response?.status);
		if (!Number.isInteger(status) || status < 200 || status >= 300)
			fail(`源码下载失败（HTTP ${response?.status ?? "unknown"}）。`);
		if (response.url && response.url !== archiveUrl)
			fail("源码下载发生了未授权的重定向。");
		const contentLength = Number(
			response.headers?.get?.("content-length") ??
				response.headers?.["content-length"] ??
				response.headers?.["Content-Length"],
		);
		if (Number.isFinite(contentLength) && contentLength > maxBytes)
			fail(`源码归档下载大小超过 ${maxBytes} 字节上限。`);
		const limited = new ByteLimitTransform(maxBytes);
		await pipeline(
			await responseReadable(response),
			limited,
			createWriteStream(destination, { flags: "wx", mode: 0o600 }),
			{ signal: controller.signal },
		);
		return limited.bytes;
	} catch (error) {
		if (externallyAborted) fail("操作已取消。");
		if (controller.signal.aborted) fail("源码下载超时。");
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (timer) clearTimeout(timer);
	}
}

function archiveLimits(limits = {}) {
	const values = {
		maxArchiveEntries: limits.maxArchiveEntries ?? MAX_ARCHIVE_ENTRIES,
		maxExtractedBytes: limits.maxExtractedBytes ?? MAX_EXTRACTED_BYTES,
	};
	for (const [name, value] of Object.entries(values)) {
		if (!Number.isSafeInteger(value) || value < 1)
			fail(`${name} 必须是正整数。`);
	}
	return values;
}

function archivePathInfo(value) {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
		fail("归档包含无效路径。");
	if (value.includes("\\")) fail("归档路径不得包含反斜杠。");
	if (/^(?:\/|[A-Za-z]:)/.test(value))
		fail("归档路径不得是绝对路径、盘符路径或 UNC 路径。");
	const trimmed = value.replace(/\/+$/, "");
	const parts = trimmed.split("/");
	if (
		!trimmed ||
		parts.some((part) => part.length === 0 || part === "." || part === "..")
	)
		fail("归档路径不得包含空段、. 或 .. 段。");
	const topLevel = parts.shift();
	const relative = parts.join("/");
	return {
		raw: value,
		topLevel,
		relative,
		key: relative ? relative.normalize("NFC").toLowerCase() : ".",
	};
}

function archiveState(limits, expectedTopLevel = null) {
	return {
		...archiveLimits(limits),
		expectedTopLevel,
		topLevel: expectedTopLevel,
		count: 0,
		bytes: 0,
		keys: new Map(),
		fileKeys: new Set(),
		entries: [],
		error: null,
	};
}

function registerArchiveEntry(entry, state) {
	const info = archivePathInfo(entry?.header?.path ?? entry?.path);
	if (state.topLevel === null) state.topLevel = info.topLevel;
	if (info.topLevel !== state.topLevel) fail("源码归档必须只有一个顶级目录。");
	const type = entry?.type;
	if (type !== "File" && type !== "Directory")
		fail(`归档包含不允许的 ${type ?? "未知"} 条目。`);
	if (
		entry?.linkpath !== undefined &&
		entry.linkpath !== null &&
		entry.linkpath !== ""
	)
		fail("归档文件和目录不得携带 linkpath。");
	const size = Number(entry?.size ?? 0);
	if (!Number.isSafeInteger(size) || size < 0) fail("归档条目大小无效。");
	if (info.relative.length === 0 && type !== "Directory")
		fail("顶级归档条目必须是目录。");
	if (state.count >= state.maxArchiveEntries)
		fail(`归档条目数超过 ${state.maxArchiveEntries} 上限。`);
	if (state.keys.has(info.key)) fail("归档包含重复或大小写冲突的路径。");
	let ancestor = info.relative;
	while (ancestor.includes("/")) {
		ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"));
		const ancestorKey = ancestor.normalize("NFC").toLowerCase();
		if (state.fileKeys.has(ancestorKey)) fail("归档路径包含文件目录冲突。");
	}
	if (type === "File") {
		for (const existingKey of state.keys.keys()) {
			if (existingKey.startsWith(`${info.key}/`))
				fail("归档路径包含文件目录冲突。");
		}
	}
	const bytes = state.bytes + size;
	if (bytes > state.maxExtractedBytes)
		fail(`归档解压大小超过 ${state.maxExtractedBytes} 字节上限。`);
	state.count += 1;
	state.bytes = bytes;
	state.keys.set(info.key, { type, raw: info.raw });
	if (type === "File") state.fileKeys.add(info.key);
	const record = { ...info, type, size };
	state.entries.push(record);
	return record;
}

function tarApiMethods(tarApi) {
	return {
		list: tarApi?.t ?? tarApi?.list,
		extract: tarApi?.x ?? tarApi?.extract,
	};
}

function rememberArchiveFailure(state, error) {
	if (!state.error)
		state.error = error instanceof Error ? error : new Error(String(error));
}

export async function inspectArchive(
	archivePath,
	{ tarApi, expectedTopLevel = null, limits = {} } = {},
) {
	if (!tarApi) fail("缺少用于归档校验的固定 tar API。");
	const { list } = tarApiMethods(tarApi);
	if (typeof list !== "function") fail("固定 tar 包缺少 list API。");
	const state = archiveState(limits, expectedTopLevel);
	try {
		await list({
			file: archivePath,
			strict: true,
			maxReadSize: 1024 * 1024,
			maxMetaEntrySize: 1024 * 1024,
			onReadEntry: (entry) => {
				if (state.error) return;
				try {
					registerArchiveEntry(entry, state);
				} catch (error) {
					rememberArchiveFailure(state, error);
				}
			},
			onwarn: (_code, message) =>
				rememberArchiveFailure(state, new Error(`归档校验警告：${message}`)),
		});
	} catch (error) {
		if (!state.error) throw error;
	}
	if (state.error) throw state.error;
	if (!state.topLevel || state.count === 0)
		fail("源码归档缺少顶级目录或条目。");
	if (expectedTopLevel && state.topLevel !== expectedTopLevel)
		fail("源码归档顶级目录与固定 ref 不匹配。");
	return state;
}

async function extractArchiveWithTar(
	archivePath,
	destination,
	{ tarApi, expectedTopLevel = null, limits = {} } = {},
) {
	const state = await inspectArchive(archivePath, {
		tarApi,
		expectedTopLevel,
		limits,
	});
	const { extract } = tarApiMethods(tarApi);
	if (typeof extract !== "function") fail("固定 tar 包缺少 extract API。");
	await mkdir(destination, { recursive: true, mode: 0o700 });
	const extracted = archiveState(limits, state.topLevel);
	try {
		await extract({
			file: archivePath,
			cwd: destination,
			strip: 1,
			strict: true,
			keep: true,
			unlink: false,
			preservePaths: false,
			preserveOwner: false,
			noMtime: true,
			maxDepth: 128,
			maxMetaEntrySize: 1024 * 1024,
			filter: (entryPath, entry) => {
				if (extracted.error) return false;
				try {
					const record = registerArchiveEntry(
						{ ...entry, path: entry?.path ?? entryPath },
						extracted,
					);
					const expected = state.keys.get(record.key);
					if (!expected || expected.type !== record.type)
						fail("归档内容在解压阶段发生变化。");
					return true;
				} catch (error) {
					rememberArchiveFailure(extracted, error);
					return false;
				}
			},
			onwarn: (_code, message) =>
				rememberArchiveFailure(
					extracted,
					new Error(`归档解压警告：${message}`),
				),
		});
	} catch (error) {
		if (!extracted.error) throw error;
	}
	if (extracted.error) throw extracted.error;
	if (extracted.count !== state.count || extracted.bytes !== state.bytes)
		fail("归档解压条目与校验结果不一致。");
	return {
		topLevel: state.topLevel,
		entries: state.entries,
		count: state.count,
		bytes: state.bytes,
	};
}

function parseTarWorkerArgs(argv) {
	if (argv[0] !== "--tar-worker") fail("无效的 tar worker 参数。");
	const values = {};
	const names = new Map([
		["--archive", "archivePath"],
		["--destination", "destination"],
		["--tar-module", "tarModulePath"],
		["--top-level", "expectedTopLevel"],
		["--max-entries", "maxArchiveEntries"],
		["--max-bytes", "maxExtractedBytes"],
	]);
	for (let index = 1; index < argv.length; index += 2) {
		const name = names.get(argv[index]);
		const value = argv[index + 1];
		if (!name || value === undefined || values[name] !== undefined)
			fail("无效的 tar worker 参数。");
		values[name] = value;
	}
	for (const name of ["archivePath", "destination", "tarModulePath"])
		if (!path.isAbsolute(values[name])) fail("tar worker 路径必须是绝对路径。");
	const maxArchiveEntries = Number(values.maxArchiveEntries);
	const maxExtractedBytes = Number(values.maxExtractedBytes);
	archiveLimits({ maxArchiveEntries, maxExtractedBytes });
	return {
		...values,
		maxArchiveEntries,
		maxExtractedBytes,
	};
}

async function extractArchiveControlled(
	archivePath,
	destination,
	{
		tarModulePath,
		expectedTopLevel = null,
		limits = {},
		workerTimeoutMs = TAR_WORKER_TIMEOUT_MS,
		workerKillGraceMs = COMMAND_TERM_GRACE_MS,
		workerMaxOutputBytes = TAR_WORKER_MAX_OUTPUT_BYTES,
		abortSignal = null,
	} = {},
) {
	if (!tarModulePath) fail("缺少 tar worker 模块路径。");
	const resolvedDestination = path.resolve(destination);
	try {
		await lstat(resolvedDestination);
		fail("归档解压目标必须不存在。");
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const { maxArchiveEntries, maxExtractedBytes } = archiveLimits(limits);
	const workerScript = await realpath(fileURLToPath(import.meta.url));
	let committed = false;
	try {
		const result = await runCommand(
			process.execPath,
			[
				`--max-old-space-size=${TAR_WORKER_MAX_OLD_SPACE_MB}`,
				workerScript,
				"--tar-worker",
				"--archive",
				path.resolve(archivePath),
				"--destination",
				resolvedDestination,
				"--tar-module",
				path.resolve(tarModulePath),
				"--top-level",
				expectedTopLevel ?? "",
				"--max-entries",
				String(maxArchiveEntries),
				"--max-bytes",
				String(maxExtractedBytes),
			],
			{
				root: path.dirname(resolvedDestination),
				env: cleanParentEnv(),
				capture: true,
				timeoutMs: workerTimeoutMs,
				killGraceMs: workerKillGraceMs,
				killProcessGroup: true,
				maxOutputBytes: workerMaxOutputBytes,
				abortSignal,
			},
		);
		if (result.aborted) fail("归档处理已取消。");
		if (result.timedOut) fail("归档处理超时。");
		if (result.stdoutTruncated || result.stderrTruncated)
			fail("归档处理输出超过上限。");
		if (result.code !== 0) fail("归档处理失败。");
		let summary;
		try {
			summary = JSON.parse(result.stdout);
		} catch {
			fail("归档处理返回无效结果。");
		}
		if (
			!summary ||
			summary.ok !== true ||
			typeof summary.topLevel !== "string" ||
			!Number.isSafeInteger(summary.count) ||
			!Number.isSafeInteger(summary.bytes) ||
			summary.count < 1 ||
			summary.count > maxArchiveEntries ||
			summary.bytes < 0 ||
			summary.bytes > maxExtractedBytes ||
			(expectedTopLevel && summary.topLevel !== expectedTopLevel)
		)
			fail("归档处理结果未通过校验。");
		committed = true;
		return {
			topLevel: summary.topLevel,
			entries: [],
			count: summary.count,
			bytes: summary.bytes,
		};
	} finally {
		if (!committed)
			await rm(resolvedDestination, { recursive: true, force: true }).catch(
				() => {},
			);
	}
}

export async function extractArchive(archivePath, destination, options = {}) {
	if (options.tarModulePath)
		return extractArchiveControlled(archivePath, destination, options);
	return extractArchiveWithTar(archivePath, destination, options);
}

async function assertGzipArchiveComplete(archivePath) {
	const sink = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});
	try {
		await pipeline(createReadStream(archivePath), createGunzip(), sink);
	} catch (error) {
		fail(`源码归档 gzip 流不完整：${error.message}`);
	}
}

async function tarWorkerMain() {
	const options = parseTarWorkerArgs(process.argv.slice(2));
	await assertTargetAbsent(options.destination);
	await assertGzipArchiveComplete(options.archivePath);
	const loaded = await import(pathToFileURL(options.tarModulePath).href);
	const methods = tarApiMethods(loaded);
	if (
		typeof methods.list !== "function" ||
		typeof methods.extract !== "function"
	)
		fail("固定 tar 包缺少 list/extract API。");
	const result = await extractArchiveWithTar(
		options.archivePath,
		options.destination,
		{
			tarApi: loaded,
			expectedTopLevel: options.expectedTopLevel || null,
			limits: {
				maxArchiveEntries: options.maxArchiveEntries,
				maxExtractedBytes: options.maxExtractedBytes,
			},
		},
	);
	process.stdout.write(
		JSON.stringify({
			ok: true,
			topLevel: result.topLevel,
			count: result.count,
			bytes: result.bytes,
		}),
	);
}

async function assertTreeSafe(current) {
	for (const entry of await readdir(current, { withFileTypes: true })) {
		const fullPath = path.join(current, entry.name);
		if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
			fail("解压目录包含链接或特殊文件。");
		if (entry.isDirectory()) await assertTreeSafe(fullPath);
	}
}

async function requireDownloadedPath(root, relative, directory = false) {
	const fullPath = path.join(root, relative);
	let info;
	try {
		info = await lstat(fullPath);
	} catch {
		fail(`下载源码缺少关键路径：${relative}`);
	}
	if (
		info.isSymbolicLink() ||
		(directory ? !info.isDirectory() : !info.isFile())
	)
		fail(`下载源码关键路径类型不正确：${relative}`);
	return fullPath;
}

export async function validateDownloadedRoot(root) {
	const resolvedRoot = resolveRoot(root);
	await assertTreeSafe(resolvedRoot);
	const files = [
		"package.json",
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
		"wrangler.toml",
		"src/index.ts",
		"scripts/validate-deploy-config.mjs",
		"packages/worker/package.json",
		"packages/worker/src/index.ts",
		"packages/worker/tsconfig.json",
		"packages/dashboard/package.json",
		"packages/dashboard/scripts/build-cloudbox-assets.mjs",
		"packages/dashboard/static/login.html",
		"template/package.json",
		"template/src/index.ts",
		"template/admin.html",
		"template/visitor.html",
		"template/wrangler.toml",
	];
	const directories = [
		"packages/worker/src",
		"packages/dashboard/client",
		"template/src",
	];
	for (const relative of files)
		await requireDownloadedPath(resolvedRoot, relative);
	for (const relative of directories)
		await requireDownloadedPath(resolvedRoot, relative, true);
	for (const relative of [
		"package.json",
		"packages/worker/package.json",
		"packages/dashboard/package.json",
		"template/package.json",
	]) {
		let manifest;
		try {
			manifest = JSON.parse(
				await readFile(path.join(resolvedRoot, relative), "utf8"),
			);
		} catch {
			fail(`下载源码 manifest 无法解析：${relative}`);
		}
		if (!manifest || typeof manifest !== "object")
			fail(`下载源码 manifest 无效：${relative}`);
	}
	const rootManifest = JSON.parse(
		await readFile(path.join(resolvedRoot, "package.json"), "utf8"),
	);
	const workerManifest = JSON.parse(
		await readFile(
			path.join(resolvedRoot, "packages/worker/package.json"),
			"utf8",
		),
	);
	if (typeof rootManifest.scripts?.build !== "string")
		fail("下载源码缺少根目录构建脚本。");
	if (typeof workerManifest.scripts?.build !== "string")
		fail("下载源码缺少 Worker 构建脚本。");
	return resolvedRoot;
}

export async function validateCanonicalSourceConfig(root) {
	const resolvedRoot = resolveRoot(root);
	const config = await readFile(
		path.join(resolvedRoot, "wrangler.toml"),
		"utf8",
	);
	const lines = config.split("\n");
	const workerNames = tomlFieldEntries(lines, "name", { topLevel: true });
	const bucketFields = tomlFieldEntries(lines, "bucket_name");
	const required = [
		'main = "src/index.ts"',
		'directory = "packages/dashboard/dist"',
		'binding = "BUCKET"',
		'tag = "v1-cloudbox-r2"',
		'class_name = "AdminLoginRateLimiter"',
		'class_name = "AdminSessionStore"',
		'class_name = "PublicAccessRateLimiter"',
		'class_name = "AdminLoginSourceRateLimiter"',
		'class_name = "TransferStore"',
		'class_name = "TransferRegistry"',
	];
	if (
		workerNames.length !== 1 ||
		!validateWorkerName(workerNames[0]?.value) ||
		bucketFields.length !== 1 ||
		!validateBucketName(bucketFields[0]?.value) ||
		required.some((value) => !config.includes(value))
	)
		fail("源码配置缺少必要的 canonical Worker 结构。");
	return resolvedRoot;
}

export async function validateDownloadedSourceSnapshot(root) {
	const resolvedRoot = await validateCanonicalSourceConfig(root);
	const config = await readFile(
		path.join(resolvedRoot, "wrangler.toml"),
		"utf8",
	);
	const lines = config.split("\n");
	const workerNames = tomlFieldEntries(lines, "name", { topLevel: true });
	const bucketFields = tomlFieldEntries(lines, "bucket_name");
	if (
		workerNames[0]?.value !== DEFAULT_SOURCE_WORKER_NAME ||
		bucketFields[0]?.value !== DEFAULT_SOURCE_BUCKET_NAME
	)
		fail("固定源码快照的 Worker 与 bucket 身份不匹配。");
	return resolvedRoot;
}

export async function assertTargetAbsent(target) {
	try {
		await lstat(target);
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	fail(`目标目录已存在，拒绝覆盖：${target}`);
}

const BOOTSTRAP_LOCK_KIND = "cloudbox-r2-bootstrap-lock-v1";
const BOOTSTRAP_LOCK_FILE = "lock.json";

async function readBootstrapLock(reservation, target) {
	const resolvedTarget = path.resolve(target);
	const expectedReservation = path.join(
		path.dirname(resolvedTarget),
		`${path.basename(resolvedTarget)}.bootstrap-lock`,
	);
	if (path.resolve(reservation) !== expectedReservation) return null;
	let directory;
	let lockFile;
	try {
		directory = await lstat(reservation);
		lockFile = await lstat(path.join(reservation, BOOTSTRAP_LOCK_FILE));
	} catch {
		return null;
	}
	if (
		!directory.isDirectory() ||
		directory.isSymbolicLink() ||
		!lockFile.isFile() ||
		lockFile.isSymbolicLink()
	)
		return null;
	let entries;
	try {
		entries = await readdir(reservation);
	} catch {
		return null;
	}
	if (entries.length !== 1 || entries[0] !== BOOTSTRAP_LOCK_FILE) return null;
	let metadata;
	try {
		metadata = JSON.parse(
			await readFile(path.join(reservation, BOOTSTRAP_LOCK_FILE), "utf8"),
		);
	} catch {
		return null;
	}
	const fields = Object.keys(metadata ?? {}).sort();
	if (
		fields.join(",") !== "kind,pid,target,timestamp" ||
		metadata?.kind !== BOOTSTRAP_LOCK_KIND ||
		metadata.target !== resolvedTarget ||
		!Number.isSafeInteger(metadata.pid) ||
		metadata.pid < 1 ||
		!Number.isSafeInteger(metadata.timestamp) ||
		metadata.timestamp < 1
	)
		return null;
	return metadata;
}

function processExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		return true;
	}
}

async function recoverStaleReservation(reservation, target) {
	const metadata = await readBootstrapLock(reservation, target);
	if (!metadata || processExists(metadata.pid)) return false;
	const current = await readBootstrapLock(reservation, target);
	if (!current || current.pid !== metadata.pid || processExists(current.pid))
		return false;
	await rm(reservation, { recursive: true, force: true });
	return true;
}

async function removeOwnedReservation(reservation, target) {
	if (!reservation || !(await readBootstrapLock(reservation, target))) return;
	await rm(reservation, { recursive: true, force: true });
}

async function reserveTarget(target) {
	const reservation = `${target}.bootstrap-lock`;
	try {
		await mkdir(reservation, { mode: 0o700 });
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		if (!(await recoverStaleReservation(reservation, target)))
			fail(`目标目录正在准备或存在锁，拒绝覆盖：${target}`);
		await mkdir(reservation, { mode: 0o700 });
	}
	try {
		await writeFile(
			path.join(reservation, BOOTSTRAP_LOCK_FILE),
			JSON.stringify({
				kind: BOOTSTRAP_LOCK_KIND,
				target: path.resolve(target),
				pid: process.pid,
				timestamp: Date.now(),
			}),
			{ flag: "wx", mode: 0o600 },
		);
	} catch (error) {
		await rm(reservation, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
	return reservation;
}

function packageNameFromLockPath(packagePath) {
	if (typeof packagePath !== "string") return null;
	const marker = packagePath.startsWith("node_modules/")
		? "node_modules/"
		: "/node_modules/";
	const markerIndex = packagePath.lastIndexOf(marker);
	if (markerIndex < 0) return null;
	const value = packagePath.slice(markerIndex + marker.length);
	if (!value) return null;
	const parts = value.split("/");
	if (parts[0].startsWith("@"))
		return parts.length === 2 ? `${parts[0]}/${parts[1]}` : null;
	return parts.length === 1 ? parts[0] : null;
}

function verifyTarDependencyTree(npmLock, installRoot, lockCwd) {
	const records = Object.entries(npmLock?.packages ?? {});
	const verifiedTree = {};
	for (const [packagePath, record] of records) {
		const name = packageNameFromLockPath(packagePath);
		const expected = name && TAR_DEPENDENCY_LOCK[name];
		const absolutePath = name
			? path.resolve(
					packagePath.startsWith("node_modules/") ? installRoot : lockCwd,
					packagePath,
				)
			: null;
		if (
			!expected ||
			absolutePath !== path.join(installRoot, "node_modules", name) ||
			record?.link ||
			record.version !== expected.version ||
			record.resolved !== expected.resolved ||
			record.integrity !== expected.integrity
		)
			fail("准备出的 tar 依赖树与固定 lock 不匹配，已停止。");
		if (verifiedTree[name]) fail("准备出的 tar 依赖树包含重复包记录。");
		verifiedTree[name] = {
			version: record.version,
			resolved: record.resolved,
			integrity: record.integrity,
		};
	}
	const expectedNames = Object.keys(TAR_DEPENDENCY_LOCK);
	if (
		Object.keys(verifiedTree).length !== expectedNames.length ||
		expectedNames.some((name) => !verifiedTree[name])
	)
		fail("准备出的 tar 依赖树不完整，已停止。");
	return Object.freeze(verifiedTree);
}

export async function installTar({
	root,
	npm,
	run = runCommand,
	abortSignal = null,
} = {}) {
	const resolvedRoot = resolveRoot(root);
	npm ??= await npmPath();
	if (!npm) fail("找不到官方 Node.js 附带的 npm，无法准备固定 tar。");
	const setupDirectory = await ensureSetupNamespace(resolvedRoot);
	const installRoot = path.join(setupDirectory, "tar");
	await rm(installRoot, { recursive: true, force: true });
	await mkdir(installRoot, { recursive: true, mode: 0o700 });
	const npmTool = typeof npm === "string" ? { command: npm, args: [] } : npm;
	const result = await run(
		npmTool.command,
		[
			...npmTool.args,
			"install",
			"--prefix",
			installRoot,
			"--package-lock=true",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--registry",
			NPM_REGISTRY,
			TAR_TARBALL_URL,
		],
		{
			capture: true,
			timeoutMs: WORKFLOW_TIMEOUT_MS,
			env: cleanParentEnv(),
			killProcessGroup: true,
			abortSignal,
			root: resolvedRoot,
		},
	);
	assertCommandSuccess(result, `准备固定 tar@${TAR_VERSION}`);
	let npmLock;
	try {
		npmLock = JSON.parse(
			await readFile(
				path.join(installRoot, "node_modules/.package-lock.json"),
				"utf8",
			),
		);
	} catch {
		fail("准备出的 tar 缺少 npm 完整性元数据。");
	}
	const packageRecords = Object.entries(npmLock.packages ?? {});
	const tarRecord = packageRecords
		.map(([packagePath, record]) => [
			packageNameFromLockPath(packagePath),
			record,
		])
		.find(([name]) => name === "tar")?.[1];
	if (
		tarRecord?.version !== TAR_VERSION ||
		tarRecord.resolved !== TAR_TARBALL_URL ||
		tarRecord.integrity !== TAR_INTEGRITY
	)
		fail("准备出的 tar 完整性校验不匹配，已停止。");
	const realInstallRoot = await realpath(installRoot);
	const realRoot = await realpath(resolvedRoot);
	const verifiedTree = verifyTarDependencyTree(
		npmLock,
		realInstallRoot,
		realRoot,
	);
	let manifest;
	try {
		manifest = JSON.parse(
			await readFile(
				path.join(installRoot, "node_modules/tar/package.json"),
				"utf8",
			),
		);
	} catch {
		fail("准备出的 tar 包 manifest 无法读取。");
	}
	if (manifest.version !== TAR_VERSION)
		fail(`准备出的 tar 版本不是 ${TAR_VERSION}，已停止。`);
	const modulePath = await realpath(
		path.join(realInstallRoot, "node_modules/tar/dist/esm/index.js"),
	);
	const relative = path.relative(realInstallRoot, modulePath);
	if (relative.startsWith("..") || path.isAbsolute(relative))
		fail("准备出的 tar 模块路径越出临时目录。");
	return { modulePath, verifiedTree };
}

export function assertSupportedBuildPlatform(
	platform = process.platform,
	ref = DEFAULT_SOURCE_REF,
) {
	if (platform === "win32")
		fail(
			`固定源码 ${ref} 的构建脚本使用 Unix rm/cp；Windows 暂不支持（本地兼容 build 版本尚未发布）。`,
		);
	return platform;
}

export function parseSetupArgs(argv = []) {
	let ref = null;
	let help = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help") {
			help = true;
			continue;
		}
		let value;
		if (argument === "--ref") {
			value = argv[++index];
		} else if (argument.startsWith("--ref=")) {
			value = argument.slice("--ref=".length);
		} else {
			fail(`不支持的参数：${argument}`);
		}
		const normalized = validateSourceRef(value);
		if (!normalized) fail("--ref 必须是完整 40 位十六进制 commit SHA。");
		if (ref) fail("--ref 只能指定一次。");
		ref = normalized;
	}
	return { help, ref };
}

async function copyStagingIntoPublish(staging, publish) {
	for (const entry of await readdir(staging, { withFileTypes: true })) {
		const source = path.join(staging, entry.name);
		const destination = path.join(publish, entry.name);
		await assertTargetAbsent(destination);
		await cp(source, destination, {
			recursive: true,
			force: false,
			errorOnExist: true,
			dereference: false,
		});
	}
}

export async function bootstrapSource({
	ref = DEFAULT_SOURCE_REF,
	cwd = process.cwd(),
	fetchImpl = fetch,
	npm,
	run = runCommand,
	tarApi,
	limits = {},
} = {}) {
	const normalizedRef = validateSourceRef(ref);
	if (!normalizedRef) fail("源码 ref 必须是完整 40 位十六进制 commit SHA。");
	const resolvedCwd = path.resolve(cwd);
	const cwdInfo = await lstat(resolvedCwd);
	if (cwdInfo.isSymbolicLink() || !cwdInfo.isDirectory())
		fail("bootstrap cwd 必须是普通目录。");
	const target = path.join(
		resolvedCwd,
		`${DEFAULT_SOURCE_WORKER_NAME}-${normalizedRef.slice(0, 12)}`,
	);
	const controller = new AbortController();
	let interrupted = false;
	let reservation = null;
	let owned = null;
	let targetCommitted = false;
	let managedTarget = null;
	let result = null;
	let primaryError = null;
	const cleanup = async () => {
		const errors = [];
		if (owned) {
			try {
				await removeOwnedBootstrapDirectory(owned, resolvedCwd, normalizedRef);
			} catch (error) {
				errors.push(error);
			}
		}
		if (reservation) {
			try {
				await removeOwnedReservation(reservation, target);
			} catch (error) {
				errors.push(error);
			}
		}
		return errors;
	};
	const onSignal = () => {
		interrupted = true;
		controller.abort();
		void cleanup().catch(() => {});
	};
	process.prependListener("SIGINT", onSignal);
	process.prependListener("SIGTERM", onSignal);
	try {
		reservation = await reserveTarget(target);
		if (interrupted) fail("操作已取消。");
		await assertTargetAbsent(target);
		owned = await mkdtemp(
			path.join(
				resolvedCwd,
				`.cloudbox-r2-bootstrap-${normalizedRef.slice(0, 12)}-`,
			),
		);
		const archivePath = path.join(owned, "source.tar.gz");
		const staging = path.join(owned, "source");
		await downloadArchive({
			ref: normalizedRef,
			destination: archivePath,
			fetchImpl,
			signal: controller.signal,
		});
		if (interrupted) fail("操作已取消。");
		const archiveTool = tarApi
			? { tarApi }
			: await installTar({
					root: owned,
					npm,
					run,
					abortSignal: controller.signal,
				});
		const expectedTopLevel = `${DEFAULT_SOURCE_WORKER_NAME}-${normalizedRef}`;
		const archive = await extractArchive(archivePath, staging, {
			tarApi: archiveTool.tarApi,
			tarModulePath: archiveTool.modulePath,
			expectedTopLevel,
			limits,
			abortSignal: controller.signal,
		});
		await validateDownloadedRoot(staging);
		await validateDownloadedSourceSnapshot(staging);
		if (interrupted) fail("操作已取消。");
		await assertTargetAbsent(target);
		const publish = path.join(owned, "publish");
		await mkdir(publish, { mode: 0o700 });
		await copyStagingIntoPublish(staging, publish);
		const marker = randomBytes(32).toString("hex");
		await writeFile(
			path.join(publish, MANAGED_TARGET_MARKER_FILE),
			JSON.stringify({
				kind: MANAGED_TARGET_MARKER_KIND,
				ref: normalizedRef,
				target,
				token: marker,
			}),
			{ flag: "wx", mode: 0o600 },
		);
		managedTarget = Object.freeze({
			cwd: resolvedCwd,
			target,
			ref: normalizedRef,
			marker,
		});
		await assertTargetAbsent(target);
		try {
			await rename(publish, target);
		} catch (error) {
			if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY")
				fail(`目标目录已存在，拒绝覆盖：${target}`);
			throw error;
		}
		targetCommitted = true;
		if (interrupted) fail("操作已取消。");
		result = {
			ref: normalizedRef,
			root: target,
			target,
			managedTarget,
			topLevel: archive.topLevel,
		};
	} catch (error) {
		primaryError = error;
	} finally {
		const cleanupErrors = await cleanup();
		if (primaryError && targetCommitted && managedTarget) {
			try {
				await cleanupManagedTarget(managedTarget);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
		if (cleanupErrors.length) {
			const detail = "bootstrap 本机生成物清理失败";
			if (primaryError instanceof Error) {
				primaryError.message += `；${detail}`;
			} else if (primaryError) {
				primaryError = new AggregateError([primaryError], detail);
			} else {
				primaryError = new Error(detail);
			}
		}
	}
	if (interrupted && !targetCommitted && !primaryError)
		primaryError = new Error("操作已取消。");
	if (primaryError) throw primaryError;
	return result;
}

async function main() {
	const { help, ref } = parseSetupArgs(process.argv.slice(2));
	if (help) {
		console.log(
			"推荐入口：sh scripts/setup-cloudflare.sh [--ref <完整40位SHA>]\n直接调用：node scripts/setup-cloudflare.mjs [--ref <完整40位SHA>]\n\n在当前 cwd 准备源码并交互式创建新的 Cloudflare Worker 与专用 R2 bucket。首次部署，不提供恢复或卸载。",
		);
		return;
	}
	if (process.versions.node.split(".").map(Number)[0] < 22)
		fail("需要 Node.js 22 或更高版本。");
	const shouldBootstrap = !DEFAULT_ROOT || ref !== null;
	if (shouldBootstrap)
		assertSupportedBuildPlatform(process.platform, ref ?? DEFAULT_SOURCE_REF);
	if (!stdin.isTTY || !stdout.isTTY)
		fail("首次部署向导需要交互式终端（TTY）；请不要通过管道运行。");
	let root = null;
	let managedTarget = null;
	let rl = null;
	let onTerminate = null;
	try {
		const source = shouldBootstrap
			? await bootstrapSource({ ref: ref ?? DEFAULT_SOURCE_REF })
			: { root: DEFAULT_ROOT, managedTarget: null };
		root = source.root;
		managedTarget = shouldBootstrap ? source.managedTarget : null;
		if (shouldBootstrap)
			console.log(
				`源码已准备到 ${source.target}（固定 commit ${source.ref}）。`,
			);
		rl = createInterface({ input: stdin, output: stdout, terminal: true });
		let cancelled = false;
		onTerminate = () => {
			cancelled = true;
			rl.close();
		};
		process.prependListener("SIGTERM", onTerminate);
		rl.on("SIGINT", onTerminate);
		const stopIfCancelled = () => {
			if (cancelled) fail("操作已取消。");
		};
		let pnpm;
		const completed = [];
		try {
			pnpm = await ensurePnpm({
				root,
				confirmDownload: async () =>
					confirm(
						await rl.question(
							`未找到 pnpm ${PNPM_VERSION}，需要下载到项目隔离目录？[y/N] `,
						),
					),
			});
			const installed = await runTool(pnpm, ["install", "--frozen-lockfile"], {
				capture: true,
				timeoutMs: WORKFLOW_TIMEOUT_MS,
				root,
			});
			stopIfCancelled();
			assertCommandSuccess(installed, "依赖安装");
			const apiToken = await askSecret(
				rl,
				"Cloudflare API Token（输入不会回显）：",
				validateApiToken,
				"API Token 格式无效。",
			);
			const accountId = await ask(
				rl,
				"账号 ID：",
				(v) => (/^[a-f0-9]{32}$/i.test(v.trim()) ? v.trim() : null),
				"账号 ID 格式无效。",
			);
			const workerName = await ask(
				rl,
				"新 Worker 名称：",
				(v) => validateWorkerName(v.trim()),
				"Worker 名称格式无效。",
			);
			const bucketName = await ask(
				rl,
				"新 R2 bucket 名称：",
				(v) => validateBucketName(v.trim()),
				"bucket 名称格式无效。",
			);
			const adminPath = await askSecret(
				rl,
				"管理入口（5–12 字符）：",
				(v) => validateAdminPath(v.trim()),
				"管理入口格式无效。",
			);
			const username = await askSecret(
				rl,
				"管理员用户名：",
				(v) => validateUsername(v),
				"用户名不能为空且最多 256 UTF-8 字节。",
			);
			const password = await askSecret(
				rl,
				"管理员密码：",
				(v) => validatePassword(v, username),
				"密码需 6–16 UTF-8 字节且不能等于用户名。",
			);
			const repeat = await askSecret(
				rl,
				"再次输入管理员密码：",
				(v) => (v === password ? v : null),
				"两次密码不一致。",
			);
			void repeat;
			const secrets = makeSecrets({ adminPath, username, password });
			const result = await runWorkflow({
				root,
				pnpm,
				workerName,
				bucketName,
				accountId,
				apiToken,
				secrets,
				confirm: async ({
					accountId: selectedAccount,
					workerName: selectedWorker,
					bucketName: selectedBucket,
				}) => {
					console.log(
						`\n目标账号：${selectedAccount}\nWorker：${selectedWorker}\nbucket：${selectedBucket}`,
					);
					console.log(
						"公开范围内未加锁对象可被访客访问；资源可能产生费用；失败后不会自动删除。",
					);
					return confirm(await rl.question("确认创建并部署？[y/N] "));
				},
				onStage: (stage) => completed.push(stage),
			});
			stopIfCancelled();
			if (result.url) {
				console.log(`部署成功：${result.url}`);
				console.log(
					"请手动访问该地址并追加你设置的管理入口（不会在输出中显示完整管理 URL）。",
				);
			} else {
				console.log(
					"Worker已部署，但未检测到workers.dev地址，请到Cloudflare Dashboard查看域名配置",
				);
			}
		} catch (error) {
			if (completed.length)
				console.error(
					`已完成阶段：${completed.join("、")}。云端资源不会自动删除，请人工检查；本机生成物将尝试清理。`,
				);
			throw error;
		}
	} finally {
		if (onTerminate) process.removeListener("SIGTERM", onTerminate);
		rl?.close();
		const warnings = await cleanupLocalState({
			managedTarget,
			root,
			scriptPath: modulePath,
		});
		if (warnings.length)
			console.error(`cleanup warning：${warnings.join("、")}。`);
	}
}

const invokedPath = process.argv[1]
	? await realpath(process.argv[1]).catch(() => null)
	: null;
const modulePath = await realpath(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
	const entrypoint = process.argv.includes("--tar-worker")
		? tarWorkerMain
		: main;
	entrypoint().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
