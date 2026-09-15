import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const dashboardDirectory = path.resolve(scriptsDirectory, "..");
const rootDirectory = path.resolve(dashboardDirectory, "../..");
const outputDirectory = path.join(dashboardDirectory, "dist");
const clientOutputDirectory = path.join(outputDirectory, "cloudbox-r2");
const clientSourceDirectory = path.join(dashboardDirectory, "client");

async function readProductionTemplate(name) {
	const file = path.join(rootDirectory, "template", `${name}.html`);
	const html = await readFile(file, "utf8");
	if (/<script(?!\s+type="module")/i.test(html))
		throw new Error(`${file} contains an inline script`);
	if (/\bon(?:click|change|dragover|dragleave|drop)\s*=/i.test(html))
		throw new Error(`${file} contains an inline event handler`);
	if (!html.includes(`/cloudbox-r2/${name}.js`))
		throw new Error(`${file} does not load the production client module`);
	if (html.includes("mockFiles")) throw new Error(`${file} contains mock data`);
	return html;
}

async function build() {
	await rm(outputDirectory, { recursive: true, force: true });
	await mkdir(clientOutputDirectory, { recursive: true });

	for (const name of ["visitor", "admin"]) {
		await writeFile(
			path.join(outputDirectory, `${name}.html`),
			await readProductionTemplate(name),
		);
	}
	await cp(
		path.join(dashboardDirectory, "static/login.html"),
		path.join(outputDirectory, "login.html"),
	);
	await cp(path.join(dashboardDirectory, "public"), outputDirectory, {
		recursive: true,
	});

	for (const name of [
		"runtime.js",
		"visitor.js",
		"admin.js",
		"login.js",
		"transfer-cache.js",
	])
		await cp(
			path.join(clientSourceDirectory, name),
			path.join(clientOutputDirectory, name),
		);
}

await build();
