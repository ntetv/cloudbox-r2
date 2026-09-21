import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
	DEFAULT_SOURCE_REF,
	MAX_ARCHIVE_BYTES,
	MAX_ARCHIVE_ENTRIES,
	MAX_EXTRACTED_BYTES,
	TAR_DEPENDENCY_LOCK,
	TAR_TARBALL_URL,
	TAR_VERSION,
	assertSupportedBuildPlatform,
	bootstrapSource,
	cleanupManagedTarget,
	createSetupContext,
	deriveConfig,
	downloadArchive,
	extractArchive,
	inspectArchive,
	installTar,
	parseSetupArgs,
	runCommand,
	sourceArchiveUrl,
	validateSourceRef,
} from "../scripts/install_cloudbox.mjs";

function fakeTar(entries, { write = false } = {}) {
	return {
		t: async ({ onReadEntry }) => {
			for (const entry of entries) onReadEntry(entry);
		},
		x: async (options) => {
			for (const entry of entries) {
				if (!options.filter(entry.path, entry)) continue;
				if (!write || entry.type !== "File") continue;
				const relative = entry.path.split("/").slice(1).join("/");
				const fullPath = path.join(options.cwd, relative);
				await mkdir(path.dirname(fullPath), { recursive: true });
				await writeFile(fullPath, entry.contents ?? "fixture");
			}
		},
	};
}

function entriesFor(paths, topLevel = `cloudbox-r2-${DEFAULT_SOURCE_REF}`) {
	return [
		{ path: `${topLevel}/`, type: "Directory", size: 0 },
		...paths.map(({ path: relative, type = "File", size = 1, contents }) => ({
			path: `${topLevel}/${relative}`,
			type,
			size,
			...(contents === undefined ? {} : { contents }),
		})),
	];
}

const REAL_TAR_MODULE =
	process.env.CLOUDBOX_TAR_MODULE ??
	(() => {
		const candidate = path.join(
			process.cwd(),
			".wrangler/setup/tar/node_modules/tar/dist/esm/index.js",
		);
		return existsSync(candidate) ? candidate : null;
	})();

const requiredFixtureFiles = {
	"package.json": JSON.stringify({ scripts: { build: "build" } }),
	"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
	"pnpm-workspace.yaml": "packages:\n  - packages/*\n",
	"wrangler.toml": `name = "cloudbox-r2"
compatibility_date = "2024-11-06"
main = "src/index.ts"
assets = { directory = "packages/dashboard/dist", binding = "ASSETS" }
[[durable_objects.bindings]]
class_name = "AdminLoginRateLimiter"
class_name = "AdminSessionStore"
class_name = "PublicAccessRateLimiter"
class_name = "AdminLoginSourceRateLimiter"
class_name = "TransferStore"
class_name = "TransferRegistry"
[[migrations]]
tag = "v1-cloudbox-r2"
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "cloudbox-r2"
`,
	"src/index.ts": "export {};\n",
	"scripts/validate-deploy-config.mjs": "console.log('ok');\n",
	"packages/worker/package.json": JSON.stringify({
		scripts: { build: "build" },
	}),
	"packages/worker/src/index.ts": "export {};\n",
	"packages/worker/tsconfig.json": "{}\n",
	"packages/dashboard/package.json": "{}\n",
	"packages/dashboard/scripts/build-cloudbox-assets.mjs":
		"console.log('ok');\n",
	"packages/dashboard/static/login.html": "<!doctype html>\n",
	"packages/dashboard/client/runtime.js": "console.log('ok');\n",
	"template/package.json": "{}\n",
	"template/src/index.ts": "export {};\n",
	"template/admin.html": "<!doctype html>\n",
	"template/visitor.html": "<!doctype html>\n",
	"template/wrangler.toml": 'name = "template"\n',
};

function validSourceEntries() {
	return entriesFor(
		Object.entries(requiredFixtureFiles).map(([relative, contents]) => ({
			path: relative,
			contents,
			size: Buffer.byteLength(contents),
		})),
	);
}

test("validates fixed refs and rejects arbitrary source URLs", () => {
	assert.equal(validateSourceRef(DEFAULT_SOURCE_REF), DEFAULT_SOURCE_REF);
	assert.equal(
		validateSourceRef(DEFAULT_SOURCE_REF.toUpperCase()),
		DEFAULT_SOURCE_REF,
	);
	assert.equal(validateSourceRef("b168"), null);
	assert.equal(validateSourceRef("https://evil.invalid/source"), null);
	assert.equal(
		sourceArchiveUrl(DEFAULT_SOURCE_REF),
		`https://codeload.github.com/ntetv/cloudbox-r2/tar.gz/${DEFAULT_SOURCE_REF}`,
	);
	assert.deepEqual(parseSetupArgs([]), { help: false, ref: null });
	assert.deepEqual(parseSetupArgs(["--ref", DEFAULT_SOURCE_REF]), {
		help: false,
		ref: DEFAULT_SOURCE_REF,
	});
	assert.throws(
		() => parseSetupArgs(["--ref", "https://evil.invalid/archive"]),
		/完整 40 位十六进制/,
	);
	assert.throws(() => parseSetupArgs(["--ref", "abc"]), /完整 40 位十六进制/);
});

test("injects a downloaded root into derived config paths", async () => {
	const root = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-root-context-test-"),
	);
	try {
		await writeFile(
			path.join(root, "wrangler.toml"),
			requiredFixtureFiles["wrangler.toml"],
		);
		const context = createSetupContext(root);
		const config = await deriveConfig(
			"context-worker",
			"context-bucket",
			"0123456789abcdef0123456789abcdef",
			"root-context",
			{ root: context.root },
		);
		const derived = await readFile(config, "utf8");
		assert.equal(config.startsWith(context.setupRoot), true);
		assert.match(derived, /name = "context-worker"/);
		assert.match(derived, /bucket_name = "context-bucket"/);
		assert.match(derived, new RegExp(`${context.root}/src/index\\.ts`));
		assert.match(
			derived,
			new RegExp(`${context.root}/packages/dashboard/dist`),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("runs build and tool commands with the injected root as cwd", async () => {
	const root = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-command-root-test-"),
	);
	try {
		const result = await runCommand(
			process.execPath,
			["-e", "process.stdout.write(process.cwd())"],
			{ root, capture: true },
		);
		assert.equal(result.code, 0);
		assert.equal(await realpath(result.stdout), await realpath(root));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("downloads only from fixed codeload HTTPS host and enforces byte limit", async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-download-test-"),
	);
	try {
		const destination = path.join(directory, "source.tar.gz");
		const calls = [];
		const bytes = await downloadArchive({
			ref: DEFAULT_SOURCE_REF,
			destination,
			fetchImpl: async (url, options) => {
				calls.push({ url, options });
				return new Response("archive", {
					status: 200,
					headers: { "content-length": "7" },
				});
			},
		});
		assert.equal(bytes, 7);
		assert.equal(await readFile(destination, "utf8"), "archive");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, sourceArchiveUrl(DEFAULT_SOURCE_REF));
		assert.equal(calls[0].options.redirect, "error");
		assert.ok(calls[0].options.signal instanceof AbortSignal);
		await assert.rejects(
			() =>
				downloadArchive({
					ref: DEFAULT_SOURCE_REF,
					url: "https://evil.invalid/ntetv/cloudbox-r2.tar.gz",
					destination: path.join(directory, "evil.tar.gz"),
				}),
			/固定 GitHub codeload/,
		);
		await assert.rejects(
			() =>
				downloadArchive({
					ref: DEFAULT_SOURCE_REF,
					destination: path.join(directory, "large.tar.gz"),
					maxBytes: 3,
					fetchImpl: async () =>
						new Response("archive", {
							status: 200,
							headers: { "content-length": "7" },
						}),
				}),
			/下载大小超过/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("aborts a stalled source download and allows cleanup", async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-download-timeout-test-"),
	);
	try {
		await assert.rejects(
			() =>
				downloadArchive({
					ref: DEFAULT_SOURCE_REF,
					destination: path.join(directory, "stalled.tar.gz"),
					timeoutMs: 20,
					fetchImpl: async (_url, { signal }) =>
						new Promise((_, reject) => {
							signal.addEventListener(
								"abort",
								() => reject(new Error("aborted")),
								{ once: true },
							);
						}),
				}),
			/下载超时/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects unsafe archive paths, entry types, duplicates, and top levels", async () => {
	const unsafeEntries = [
		{ path: "root/../escape", type: "File", size: 1 },
		{ path: "/root/file", type: "File", size: 1 },
		{ path: "C:/root/file", type: "File", size: 1 },
		{ path: "//server/file", type: "File", size: 1 },
		{ path: "root\\file", type: "File", size: 1 },
		{ path: "root/file", type: "SymbolicLink", size: 0, linkpath: "target" },
		{ path: "root/file", type: "Link", size: 0, linkpath: "target" },
		{ path: "root/file", type: "CharacterDevice", size: 0 },
		{ path: "root/file", type: "BlockDevice", size: 0 },
		{ path: "root/file", type: "FIFO", size: 0 },
	];
	for (const unsafe of unsafeEntries) {
		await assert.rejects(
			() => inspectArchive("fixture.tar.gz", { tarApi: fakeTar([unsafe]) }),
			/归档/,
		);
	}
	await assert.rejects(
		() =>
			inspectArchive("fixture.tar.gz", {
				tarApi: fakeTar(
					entriesFor([
						{ path: "README.md", size: 1 },
						{ path: "readme.md", size: 1 },
					]),
				),
			}),
		/重复或大小写冲突/,
	);
	await assert.rejects(
		() =>
			inspectArchive("fixture.tar.gz", {
				tarApi: fakeTar([
					{ path: "one/", type: "Directory", size: 0 },
					{ path: "two/file", type: "File", size: 1 },
				]),
			}),
		/一个顶级目录/,
	);
});

test("enforces archive entry and decompressed byte limits", async () => {
	const entries = entriesFor([
		{ path: "a", size: 4 },
		{ path: "b", size: 4 },
	]);
	await assert.rejects(
		() =>
			inspectArchive("fixture.tar.gz", {
				tarApi: fakeTar(entries),
				limits: { maxExtractedBytes: 7 },
			}),
		/解压大小/,
	);
	await assert.rejects(
		() =>
			inspectArchive("fixture.tar.gz", {
				tarApi: fakeTar(entries),
				limits: { maxArchiveEntries: 2 },
			}),
		/条目数/,
	);
	assert.ok(MAX_ARCHIVE_BYTES > 0);
	assert.ok(MAX_EXTRACTED_BYTES > 0);
	assert.ok(MAX_ARCHIVE_ENTRIES > 0);
});

test("rejects a tampered pinned tar integrity record before import", async () => {
	const root = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-tar-integrity-test-"),
	);
	try {
		await assert.rejects(
			() =>
				installTar({
					root,
					npm: { command: "npm", args: [] },
					run: async (_command, args) => {
						const installRoot = args[args.indexOf("--prefix") + 1];
						await mkdir(path.join(installRoot, "node_modules/tar"), {
							recursive: true,
						});
						await writeFile(
							path.join(installRoot, "node_modules/tar/package.json"),
							JSON.stringify({ version: TAR_VERSION }),
						);
						await writeFile(
							path.join(installRoot, "node_modules/.package-lock.json"),
							JSON.stringify({
								packages: {
									"node_modules/tar": {
										version: TAR_VERSION,
										resolved: TAR_TARBALL_URL,
										integrity: "sha512-tampered",
									},
								},
							}),
						);
						return { code: 0, stdout: "", stderr: "" };
					},
				}),
			/完整性校验不匹配/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("installTar verifies the complete tree without importing tar in the parent", async () => {
	const root = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-tar-parent-test-"),
	);
	try {
		const result = await installTar({
			root,
			npm: { command: "npm", args: [] },
			run: async (_command, args) => {
				const installRoot = args[args.indexOf("--prefix") + 1];
				const packages = {};
				for (const [name, record] of Object.entries(TAR_DEPENDENCY_LOCK)) {
					const packageRoot = path.join(
						installRoot,
						"node_modules",
						...name.split("/"),
					);
					await mkdir(packageRoot, { recursive: true });
					packages[`node_modules/${name}`] = record;
					if (name === "tar") {
						await mkdir(path.join(packageRoot, "dist", "esm"), {
							recursive: true,
						});
						await writeFile(
							path.join(packageRoot, "package.json"),
							JSON.stringify({ version: TAR_VERSION }),
						);
						await writeFile(
							path.join(packageRoot, "dist", "esm", "index.js"),
							"throw new Error('parent import forbidden');\n",
						);
					}
				}
				await writeFile(
					path.join(installRoot, "node_modules", ".package-lock.json"),
					JSON.stringify({ packages }),
				);
				return { code: 0, stdout: "", stderr: "" };
			},
		});
		assert.deepEqual(Object.keys(result).sort(), [
			"modulePath",
			"verifiedTree",
		]);
		assert.deepEqual(result.verifiedTree, TAR_DEPENDENCY_LOCK);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("safe extraction strips exactly one top-level directory", async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-extract-test-"),
	);
	try {
		const destination = path.join(directory, "out");
		const entries = entriesFor([
			{ path: "README.md", contents: "hello", size: 5 },
		]);
		const result = await extractArchive("fixture.tar.gz", destination, {
			tarApi: fakeTar(entries, { write: true }),
		});
		assert.equal(result.topLevel, `cloudbox-r2-${DEFAULT_SOURCE_REF}`);
		assert.equal(
			await readFile(path.join(destination, "README.md"), "utf8"),
			"hello",
		);
		assert.equal(
			await readdir(destination).then((names) =>
				names.includes("cloudbox-r2-b168"),
			),
			false,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("controlled tar worker has a hard deadline and no outside write", async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-tar-worker-timeout-test-"),
	);
	try {
		const modulePath = path.join(directory, "hanging-tar.mjs");
		await writeFile(
			modulePath,
			"export async function t() { process.on('SIGTERM', () => {}); while (true) {} }\nexport async function x() {}\n",
		);
		await writeFile(
			path.join(directory, "fixture.tgz"),
			gzipSync(Buffer.alloc(1024)),
		);
		const destination = path.join(directory, "out");
		await assert.rejects(
			() =>
				extractArchive(path.join(directory, "fixture.tgz"), destination, {
					tarModulePath: modulePath,
					workerTimeoutMs: 20,
					workerKillGraceMs: 20,
				}),
			/归档处理超时/,
		);
		assert.equal((await readdir(directory)).includes("out"), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("controlled tar worker hard-stops output floods and cleans output", async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-tar-worker-output-test-"),
	);
	try {
		const modulePath = path.join(directory, "flood-tar.mjs");
		await writeFile(
			modulePath,
			"export async function t() { process.stdout.write('x'.repeat(100000)); }\nexport async function x() {}\n",
		);
		await writeFile(
			path.join(directory, "fixture.tgz"),
			gzipSync(Buffer.alloc(1024)),
		);
		const destination = path.join(directory, "out");
		await assert.rejects(
			() =>
				extractArchive(path.join(directory, "fixture.tgz"), destination, {
					tarModulePath: modulePath,
					workerMaxOutputBytes: 1024,
					workerKillGraceMs: 20,
				}),
			/输出超过上限/,
		);
		assert.equal(
			await access(destination).then(
				() => true,
				() => false,
			),
			false,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("real pinned tar rejects links and oversized output in the controlled worker", async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-real-tar-safety-test-"),
	);
	let installRoot = null;
	try {
		let tarModulePath = REAL_TAR_MODULE;
		if (!tarModulePath) {
			installRoot = await mkdtemp(
				path.join(os.tmpdir(), "cloudbox-real-tar-install-"),
			);
			tarModulePath = (await installTar({ root: installRoot })).modulePath;
		}
		const tar = await import(pathToFileURL(tarModulePath).href);
		const outside = path.join(directory, "outside.txt");
		await writeFile(outside, "preserve");
		const source = path.join(directory, "source");
		await mkdir(path.join(source, "root"), { recursive: true });
		await symlink(outside, path.join(source, "root", "link"));
		const linkArchive = path.join(directory, "links.tgz");
		await tar.c({ file: linkArchive, cwd: source }, ["root"]);
		await assert.rejects(
			() =>
				extractArchive(linkArchive, path.join(directory, "link-out"), {
					tarModulePath,
				}),
			/归档处理失败/,
		);
		assert.equal(await readFile(outside, "utf8"), "preserve");
		assert.equal((await readdir(directory)).includes("link-out"), false);

		const largeSource = path.join(directory, "large-source");
		await mkdir(path.join(largeSource, "root"), { recursive: true });
		await writeFile(path.join(largeSource, "root", "file"), "123456");
		const largeArchive = path.join(directory, "large.tgz");
		await tar.c({ file: largeArchive, cwd: largeSource }, ["root"]);
		const tailArchive = path.join(directory, "tail.tgz");
		await writeFile(
			tailArchive,
			Buffer.concat([await readFile(largeArchive), Buffer.from("tail")]),
		);
		await assert.rejects(
			() =>
				extractArchive(tailArchive, path.join(directory, "tail-out"), {
					tarModulePath,
				}),
			/归档处理失败/,
		);
		assert.equal((await readdir(directory)).includes("tail-out"), false);
		await assert.rejects(
			() =>
				extractArchive(largeArchive, path.join(directory, "large-out"), {
					tarModulePath,
					limits: { maxExtractedBytes: 1 },
				}),
			/归档处理失败/,
		);
		assert.equal((await readdir(directory)).includes("large-out"), false);

		const eofArchive = path.join(directory, "eof.tgz");
		const archiveBytes = await readFile(largeArchive);
		await writeFile(
			eofArchive,
			archiveBytes.subarray(0, Math.floor(archiveBytes.length / 2)),
		);
		await assert.rejects(
			() =>
				extractArchive(eofArchive, path.join(directory, "eof-out"), {
					tarModulePath,
				}),
			/归档处理失败/,
		);
		assert.equal((await readdir(directory)).includes("eof-out"), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
		if (installRoot) await rm(installRoot, { recursive: true, force: true });
	}
});

test("bootstrap refuses an existing target before HTTP and preserves it", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "cloudbox-target-test-"));
	const target = path.join(
		cwd,
		`cloudbox-r2-${DEFAULT_SOURCE_REF.slice(0, 12)}`,
	);
	let fetches = 0;
	try {
		await mkdir(target);
		await writeFile(path.join(target, "keep.txt"), "keep");
		await assert.rejects(
			() =>
				bootstrapSource({
					cwd,
					fetchImpl: async () => {
						fetches += 1;
						return new Response("never");
					},
					tarApi: fakeTar([]),
				}),
			/拒绝覆盖/,
		);
		assert.equal(fetches, 0);
		assert.equal(await readFile(path.join(target, "keep.txt"), "utf8"), "keep");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("bootstrap refuses a concurrent target reservation", async () => {
	const cwd = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-target-lock-test-"),
	);
	const target = path.join(
		cwd,
		`cloudbox-r2-${DEFAULT_SOURCE_REF.slice(0, 12)}`,
	);
	const reservation = `${target}.bootstrap-lock`;
	let fetches = 0;
	try {
		await mkdir(reservation);
		await writeFile(
			path.join(reservation, "lock.json"),
			JSON.stringify({
				kind: "cloudbox-r2-bootstrap-lock-v1",
				target,
				pid: process.pid,
				timestamp: Date.now(),
			}),
		);
		await assert.rejects(
			() =>
				bootstrapSource({
					cwd,
					fetchImpl: async () => {
						fetches += 1;
						return new Response("never", { status: 200 });
					},
					tarApi: fakeTar([]),
				}),
			/存在锁/,
		);
		assert.equal(fetches, 0);
		await readdir(reservation);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("bootstrap removes only a stale lock owned by this wizard", async () => {
	const cwd = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-stale-lock-test-"),
	);
	const target = path.join(
		cwd,
		`cloudbox-r2-${DEFAULT_SOURCE_REF.slice(0, 12)}`,
	);
	const reservation = `${target}.bootstrap-lock`;
	try {
		await mkdir(reservation);
		await writeFile(
			path.join(reservation, "lock.json"),
			JSON.stringify({
				kind: "cloudbox-r2-bootstrap-lock-v1",
				target,
				pid: process.pid + 100000,
				timestamp: Date.now(),
			}),
		);
		const result = await bootstrapSource({
			cwd,
			fetchImpl: async () => new Response("mock archive", { status: 200 }),
			tarApi: fakeTar(validSourceEntries(), { write: true }),
		});
		assert.equal(result.target, target);
		assert.equal(
			(await readdir(cwd)).includes(`${path.basename(target)}.bootstrap-lock`),
			false,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("bootstrap recovers a SIGKILL-stalled child lock on rerun", async () => {
	const cwd = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-sigkill-lock-test-"),
	);
	const target = path.join(
		cwd,
		`cloudbox-r2-${DEFAULT_SOURCE_REF.slice(0, 12)}`,
	);
	const reservation = `${target}.bootstrap-lock`;
	const scriptUrl = pathToFileURL(
		path.resolve(process.cwd(), "scripts/install_cloudbox.mjs"),
	).href;
	const childCode = `
		import { bootstrapSource } from ${JSON.stringify(scriptUrl)};
		setInterval(() => {}, 1000);
		await bootstrapSource({
			cwd: ${JSON.stringify(cwd)},
			fetchImpl: () => new Promise(() => {}),
			tarApi: { t: async () => {}, x: async () => {} },
		});
	`;
	let child;
	try {
		child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
			stdio: "ignore",
		});
		let found = false;
		for (let attempt = 0; attempt < 200 && !found; attempt += 1) {
			found = await access(path.join(reservation, "lock.json"))
				.then(() => true)
				.catch(() => false);
			if (!found) await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(found, true);
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await new Promise((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			});
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(
			await access(path.join(reservation, "lock.json")).then(
				() => true,
				() => false,
			),
			true,
		);
		const result = await bootstrapSource({
			cwd,
			fetchImpl: async () => new Response("mock archive", { status: 200 }),
			tarApi: fakeTar(validSourceEntries(), { write: true }),
		});
		assert.equal(result.target, target);
	} finally {
		if (child?.exitCode === null) child.kill("SIGKILL");
		await rm(cwd, { recursive: true, force: true });
	}
});

test("bootstrap does not remove a non-wizard lock", async () => {
	const cwd = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-foreign-lock-test-"),
	);
	const target = path.join(
		cwd,
		`cloudbox-r2-${DEFAULT_SOURCE_REF.slice(0, 12)}`,
	);
	const reservation = `${target}.bootstrap-lock`;
	try {
		await mkdir(reservation);
		await writeFile(
			path.join(reservation, "lock.json"),
			JSON.stringify({ kind: "other-tool", target, pid: process.pid + 100000 }),
		);
		await assert.rejects(
			() => bootstrapSource({ cwd, tarApi: fakeTar([]) }),
			/存在锁/,
		);
		assert.equal((await readdir(reservation)).includes("lock.json"), true);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("bootstrap signal cleanup removes owned state and permits a rerun", async () => {
	const cwd = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-signal-cleanup-test-"),
	);
	let signalled = false;
	try {
		await assert.rejects(
			() =>
				bootstrapSource({
					cwd,
					fetchImpl: async (_url, { signal }) => {
						queueMicrotask(() => {
							if (!signalled) {
								signalled = true;
								process.emit("SIGINT");
							}
						});
						return new Promise((_, reject) =>
							signal.addEventListener(
								"abort",
								() => reject(new Error("aborted")),
								{ once: true },
							),
						);
					},
					tarApi: fakeTar([]),
				}),
			/取消|aborted/,
		);
		assert.deepEqual(await readdir(cwd), []);
		const result = await bootstrapSource({
			cwd,
			fetchImpl: async () => new Response("mock archive", { status: 200 }),
			tarApi: fakeTar(validSourceEntries(), { write: true }),
		});
		assert.equal(
			result.root,
			path.join(cwd, `cloudbox-r2-${DEFAULT_SOURCE_REF.slice(0, 12)}`),
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("bootstrap preserves a target created during download", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "cloudbox-toctou-test-"));
	const target = path.join(
		cwd,
		`cloudbox-r2-${DEFAULT_SOURCE_REF.slice(0, 12)}`,
	);
	try {
		await assert.rejects(
			() =>
				bootstrapSource({
					cwd,
					fetchImpl: async () => {
						await mkdir(target);
						await writeFile(path.join(target, "keep.txt"), "keep");
						return new Response("mock archive", { status: 200 });
					},
					tarApi: fakeTar(validSourceEntries(), { write: true }),
				}),
			/拒绝覆盖/,
		);
		assert.equal(await readFile(path.join(target, "keep.txt"), "utf8"), "keep");
		assert.equal(
			(await readdir(cwd)).includes(`${path.basename(target)}.bootstrap-lock`),
			false,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("bootstrap cleans only its owned temp directory after archive failure", async () => {
	const cwd = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-bootstrap-failure-test-"),
	);
	try {
		await assert.rejects(
			() =>
				bootstrapSource({
					cwd,
					fetchImpl: async () => new Response("mock archive", { status: 200 }),
					tarApi: fakeTar([
						{
							path: `cloudbox-r2-${DEFAULT_SOURCE_REF}/../escape`,
							type: "File",
							size: 1,
						},
					]),
				}),
			/归档路径/,
		);
		assert.deepEqual(await readdir(cwd), []);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("bootstrap validates a mock archive, atomically moves the target, and cleans temp state", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "cloudbox-bootstrap-test-"));
	try {
		const result = await bootstrapSource({
			cwd,
			fetchImpl: async (url) => {
				assert.equal(url, sourceArchiveUrl(DEFAULT_SOURCE_REF));
				return new Response("mock archive", { status: 200 });
			},
			tarApi: fakeTar(validSourceEntries(), { write: true }),
		});
		assert.equal(
			result.target,
			path.join(cwd, `cloudbox-r2-${DEFAULT_SOURCE_REF.slice(0, 12)}`),
		);
		assert.equal(
			await readFile(path.join(result.root, "package.json"), "utf8"),
			requiredFixtureFiles["package.json"],
		);
		const names = await readdir(cwd);
		assert.deepEqual(names, [`cloudbox-r2-${DEFAULT_SOURCE_REF.slice(0, 12)}`]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("bootstrap returns an owned target that the main cleanup can remove", async () => {
	const cwd = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-managed-target-test-"),
	);
	try {
		const result = await bootstrapSource({
			cwd,
			fetchImpl: async () => new Response("mock archive", { status: 200 }),
			tarApi: fakeTar(validSourceEntries(), { write: true }),
		});
		assert.equal(result.managedTarget.target, result.target);
		assert.equal(
			await access(
				path.join(result.target, ".cloudbox-r2-bootstrap-managed.json"),
			).then(
				() => true,
				() => false,
			),
			true,
		);
		assert.equal(await cleanupManagedTarget(result.managedTarget), true);
		assert.equal(
			await access(result.target).then(
				() => true,
				() => false,
			),
			false,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("rejects Windows before using the Unix build script", () => {
	assert.throws(
		() => assertSupportedBuildPlatform("win32"),
		/Windows 暂不支持/,
	);
	assert.doesNotThrow(() => assertSupportedBuildPlatform("darwin"));
	assert.doesNotThrow(() => assertSupportedBuildPlatform("linux"));
});

test(
	"real fixed public archive can be downloaded without Cloudflare API",
	{ skip: !process.env.CLOUDBOX_BOOTSTRAP_NETWORK_TEST },
	async () => {
		const directory = await mkdtemp(
			path.join(os.tmpdir(), "cloudbox-real-bootstrap-test-"),
		);
		try {
			const result = await bootstrapSource({ cwd: directory });
			assert.equal(result.ref, DEFAULT_SOURCE_REF);
			assert.equal(
				result.root,
				path.join(directory, `cloudbox-r2-${DEFAULT_SOURCE_REF.slice(0, 12)}`),
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
