import assert from "node:assert/strict";
import test from "node:test";
import { makeSecrets, runWorkflow } from "../scripts/install_cloudbox.mjs";

const secrets = makeSecrets({
	adminPath: "admin",
	username: "user",
	password: "password",
});
for (const failedStage of ["create", "secret", "deploy"]) {
	test(`mock ${failedStage} failure stops without retry or deletion`, async () => {
		const writes = [];
		await assert.rejects(() =>
			runWorkflow({
				apiToken: "test-token",
				pnpm: { command: "pnpm", args: [] },
				workerName: `fail-${failedStage}`,
				bucketName: `fail-${failedStage}`,
				accountId: "0123456789abcdef0123456789abcdef",
				secrets,
				run: async () => ({ code: 0, stdout: "", stderr: "" }),
				wranglerRunner: async (args, options) => {
					if (args[0] === "deploy" && args.includes("--dry-run"))
						return { code: 0, stdout: "", stderr: "" };
					if (args[0] === "deployments")
						return {
							code: 1,
							stdout: JSON.stringify({ code: 10007 }),
							stderr: "",
						};
					if (args[0] === "r2" && args[2] === "info")
						return { code: 1, stdout: "", stderr: "API error code: 10006" };
					writes.push({ args, input: options?.input });
					if (failedStage === "create" && args[0] === "r2")
						return { code: 1, stdout: "", stderr: "failed" };
					if (failedStage === "secret" && args[0] === "secret")
						return { code: 1, stdout: "", stderr: "failed" };
					if (failedStage === "deploy" && args[0] === "deploy")
						return { code: 1, stdout: "", stderr: "failed" };
					return {
						code: 0,
						stdout: args[0] === "deploy" ? "https://fail.workers.dev" : "",
						stderr: "",
					};
				},
				confirm: async () => true,
			}),
		);
		assert.equal(
			writes.some(({ args }) => args[0] === "delete"),
			false,
		);
	});
}
