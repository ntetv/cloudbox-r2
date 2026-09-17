async function readResponse(response) {
	const contentType = response.headers.get("content-type") || "";
	if (contentType.includes("application/json")) {
		try {
			return await response.json();
		} catch {
			return null;
		}
	}
	return response.text();
}

function adminPath() {
	const path = window.cloudboxR2Config?.adminPath;
	return typeof path === "string" && /^\/[A-Za-z0-9_-]{5,12}$/.test(path)
		? path
		: null;
}

function nextPath() {
	const value = new URLSearchParams(location.search).get("next");
	const root = adminPath();
	if (!value || !root) return null;
	try {
		const url = new URL(value, location.origin);
		if (url.origin === location.origin && url.pathname.startsWith(`${root}/`))
			return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return null;
	}
	return null;
}

const form = document.getElementById("loginForm");
const username = document.getElementById("username");
const password = document.getElementById("password");
const button = document.getElementById("loginButton");
const error = document.getElementById("loginError");

function showError(message) {
	error.textContent = message;
	error.hidden = !message;
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	showError("");
	button.disabled = true;
	try {
		const root = adminPath();
		if (!root) {
			showError("管理入口配置不可用");
			return;
		}
		const response = await fetch(`${root}/api/auth/session`, {
			method: "POST",
			credentials: "same-origin",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				username: username.value,
				password: password.value,
			}),
		});
		await readResponse(response);
		password.value = "";
		if (!response.ok) {
			showError(
				response.status === 429
					? "登录尝试过于频繁，请稍后再试"
					: "用户名或密码错误",
			);
			return;
		}

		const configResponse = await fetch(`${root}/api/server/config`, {
			credentials: "same-origin",
			headers: { Accept: "application/json" },
		});
		const config = await readResponse(configResponse);
		if (!configResponse.ok || !config?.buckets?.length) {
			showError("无法读取服务器配置");
			return;
		}
		const destination =
			nextPath() ||
			`${root}/${encodeURIComponent(config.buckets[0].name)}/files`;
		location.assign(destination);
	} catch {
		showError("登录服务暂时不可用");
	} finally {
		button.disabled = false;
	}
});
