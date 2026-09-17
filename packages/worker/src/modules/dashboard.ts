import type { AppContext } from "../types";

export async function dashboardAssetRequest(
	c: AppContext,
	assetPath = "/visitor.html",
) {
	if (c.env.ASSETS === undefined) {
		return c.text("ASSETS binding is not defined", 500);
	}
	if (typeof c.env.ASSETS.fetch !== "function") {
		return c.text("ASSETS binding is not pointing to a valid dashboard", 500);
	}

	const url = new URL(c.req.url);
	const response = await c.env.ASSETS.fetch(
		new Request(`${url.origin}${assetPath}`),
	);
	if (!assetPath.endsWith(".html")) return response;

	const body = await response.text();
	const includeAdminPath =
		assetPath === "/admin.html" || assetPath === "/login.html";
	const runtimeConfig = includeAdminPath
		? JSON.stringify({ adminPath: c.get("config").adminPath })
		: "{}";
	const injectedBody =
		includeAdminPath && body.includes("</head>")
			? body.replace(
					"</head>",
					`<script>window.cloudboxR2Config=${runtimeConfig};</script></head>`,
				)
			: body;
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "no-store, max-age=0");
	if (injectedBody !== body) headers.delete("Content-Length");
	return new Response(injectedBody, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export function dashboardIndex(c: AppContext) {
	return dashboardAssetRequest(c, "/visitor.html");
}

function isAdminPage(pathname: string, adminPath: string) {
	return (
		pathname.startsWith(`${adminPath}/`) &&
		/^\/[^/]+\/files(?:\/.*)?\/?$/.test(pathname.slice(adminPath.length))
	);
}

export async function dashboardRedirect(c: AppContext, next) {
	const url = new URL(c.req.url);
	const adminPath = c.get("config").adminPath;
	if (url.pathname === adminPath || url.pathname === `${adminPath}/`)
		return dashboardAssetRequest(c, "/login.html");
	if (isAdminPage(url.pathname, adminPath))
		return dashboardAssetRequest(c, "/admin.html");
	if (
		url.pathname.startsWith("/api/") ||
		url.pathname.startsWith(`${adminPath}/api/`) ||
		url.pathname.startsWith("/public/")
	) {
		await next();
		return;
	}
	if (url.pathname.startsWith("/public/folder/"))
		return dashboardAssetRequest(c, "/visitor.html");
	if (url.pathname === "/visitor.html")
		return dashboardAssetRequest(c, url.pathname);
	if (url.pathname === "/admin.html" || url.pathname === "/login.html")
		return c.text("Not found", 404);
	if (url.pathname.includes(".")) {
		if (
			c.env.ASSETS === undefined ||
			typeof c.env.ASSETS.fetch !== "function"
		) {
			await next();
			return;
		}
		return c.env.ASSETS.fetch(c.req.raw);
	}
	return c.text("Not found", 404);
}
