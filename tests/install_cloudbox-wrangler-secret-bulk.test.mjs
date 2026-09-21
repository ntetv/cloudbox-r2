import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand } from "../scripts/install_cloudbox.mjs";

const WRANGLER = path.join(
	process.cwd(),
	"node_modules/.pnpm/wrangler@4.51.0_@cloudflare+workers-types@4.20251128.0/node_modules/wrangler/bin/wrangler.js",
);
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SCRIPT = "local-secret-test";
const secrets = {
	CLOUDBOX_R2_ADMIN_PATH: "admin",
	ADMIN_USERNAME: "user",
	ADMIN_PASSWORD: "password",
	ADMIN_SESSION_SECRET: "secret-one-pty-canary-should-not-leak-123456",
	PUBLIC_ACCESS_SESSION_SECRET: "secret-two-pty-canary-should-not-leak-123456",
	PUBLIC_ACCESS_PASSWORD_PEPPER:
		"secret-three-pty-canary-should-not-leak-123456",
	TRANSFER_SESSION_SECRET: "secret-four-pty-canary-should-not-leak-123456",
};

test("Wrangler 4.51 secret bulk uses only local mock API", async () => {
	const requests = [];
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString();
			requests.push({ method: request.method, url: request.url, body });
			if (request.method === "GET") {
				response.writeHead(404, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						errors: [{ code: 10007, message: "missing" }],
						messages: [],
						success: false,
					}),
				);
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({ errors: [], messages: [], result: {}, success: true }),
			);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	const home = await mkdtemp(path.join(os.tmpdir(), "cloudbox-wrangler-home-"));
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "cloudbox-wrangler-config-"),
	);
	const config = path.join(directory, "wrangler.toml");
	const input = path.join(directory, "secrets.json");
	await writeFile(
		config,
		`name = "${SCRIPT}"\naccount_id = "${ACCOUNT}"\nsend_metrics = false\n`,
	);
	await writeFile(input, JSON.stringify(secrets));
	try {
		const result = await runCommand(
			process.execPath,
			[WRANGLER, "secret", "bulk", input, "--config", config],
			{
				capture: true,
				timeoutMs: 30_000,
				env: {
					HOME: home,
					CLOUDFLARE_API_TOKEN: "fake-local-token",
					CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${port}`,
					WRANGLER_SEND_METRICS: "false",
				},
			},
		);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		assert.deepEqual(
			requests.map(({ method }) => method),
			["GET", "PUT", "PATCH"],
		);
		const patch = requests[2];
		const settings = JSON.parse(
			patch.body.match(/\r?\n\r?\n([\s\S]*)\r?\n--/)[1],
		);
		assert.equal(settings.bindings.length, 7);
		assert.ok(
			settings.bindings.every((binding) => binding.type === "secret_text"),
		);
		assert.deepEqual(
			settings.bindings.map(({ name }) => name),
			Object.keys(secrets),
		);
		assert.deepEqual(
			settings.bindings.map(({ text }) => text),
			Object.values(secrets),
		);
		assert.equal(
			`${result.stdout}\n${result.stderr}`.includes("local-token"),
			false,
		);
		for (const value of Object.values(secrets))
			assert.equal(`${result.stdout}\n${result.stderr}`.includes(value), false);
		const derived = await readFile(config, "utf8");
		for (const value of Object.values(secrets))
			assert.equal(derived.includes(value), false);
		for (const entry of await readdir(home, {
			recursive: true,
			withFileTypes: true,
		})) {
			if (!entry.isFile()) continue;
			const file = path.join(entry.parentPath, entry.name);
			const contents = await readFile(file, "utf8").catch(() => "");
			for (const value of Object.values(secrets))
				assert.equal(contents.includes(value), false, file);
		}
	} finally {
		server.close();
		await rm(home, { recursive: true, force: true });
		await rm(directory, { recursive: true, force: true });
	}
});
