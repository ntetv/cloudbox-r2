const ACTIVITY_STORAGE_KEY = "cloudbox-r2.activity.v1";
const ACTIVITY_TTL = 24 * 60 * 60 * 1000;
const MAX_ACTIVITY_RECORDS = 50;

export function encodeKey(value) {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

export function decodeKey(value) {
	if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
		throw new Error("Invalid object key encoding");
	const padded =
		value.replaceAll("-", "+").replaceAll("_", "/") +
		"=".repeat((4 - (value.length % 4)) % 4);
	let decoded;
	try {
		decoded = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true,
		}).decode(
			Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
		);
	} catch {
		throw new Error("Invalid object key encoding");
	}
	if (encodeKey(decoded) !== value)
		throw new Error("Invalid object key encoding");
	return decoded;
}

export function bytesToSize(bytes) {
	if (!bytes) return "0 Byte";
	const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
	const index = Math.min(
		sizes.length - 1,
		Math.floor(Math.log(bytes) / Math.log(1024)),
	);
	return `${Math.round(bytes / 1024 ** index)} ${sizes[index]}`;
}

export function formatDate(value) {
	if (!value) return "-";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

export function cloudboxR2AdminPath() {
	const path = window.cloudboxR2Config?.adminPath;
	return typeof path === "string" && /^\/[A-Za-z0-9_-]{5,12}$/.test(path)
		? path
		: null;
}

export function sameOriginPath(value, expectedPath = cloudboxR2AdminPath()) {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > 512
	)
		return null;
	let url;
	try {
		url = new URL(value.trim(), window.location.origin);
	} catch {
		return null;
	}
	if (url.origin !== window.location.origin) return null;
	if (
		expectedPath
			? url.pathname !== expectedPath
			: !/^\/[A-Za-z0-9_-]{5,12}$/.test(url.pathname)
	)
		return null;
	if (url.search || url.hash) return null;
	return url.pathname;
}

export function initResponsiveSidebar({
	sidebar = document.getElementById("sidebar"),
	toggleButton = document.getElementById("toggleBtn"),
	backdrop = document.getElementById("sidebarBackdrop"),
	content = document.querySelector(".main-content"),
} = {}) {
	if (!sidebar || !toggleButton) return () => {};
	const mediaQuery = window.matchMedia("(max-width: 800px)");
	let isMobile = mediaQuery.matches;

	const syncState = (collapsed) => {
		const overlayOpen = isMobile && !collapsed;
		sidebar.classList.toggle("collapsed", collapsed);
		sidebar.classList.toggle("sidebar-overlay-open", overlayOpen);
		backdrop?.classList.toggle("active", overlayOpen);
		backdrop?.setAttribute("aria-hidden", String(!overlayOpen));
		if (content) {
			if (overlayOpen) content.setAttribute("inert", "");
			else content.removeAttribute("inert");
		}
		const expanded = !collapsed;
		toggleButton.setAttribute("aria-expanded", String(expanded));
		toggleButton.setAttribute("aria-label", expanded ? "收起侧栏" : "展开侧栏");
		toggleButton.title = expanded ? "收起侧栏" : "展开侧栏";
	};

	const setDefaultState = () => syncState(isMobile);
	const closeOverlay = () => {
		if (!isMobile || sidebar.classList.contains("collapsed")) return;
		syncState(true);
		toggleButton.focus();
	};
	const toggle = () => syncState(!sidebar.classList.contains("collapsed"));
	const handleMediaChange = (event) => {
		isMobile = event.matches;
		setDefaultState();
	};
	const handleKeydown = (event) => {
		if (
			event.key === "Escape" &&
			isMobile &&
			!sidebar.classList.contains("collapsed") &&
			!document.getElementById("appModal")?.classList.contains("active")
		)
			closeOverlay();
	};

	setDefaultState();
	toggleButton.addEventListener("click", toggle);
	backdrop?.addEventListener("click", closeOverlay);
	window.addEventListener("keydown", handleKeydown);
	if (mediaQuery.addEventListener)
		mediaQuery.addEventListener("change", handleMediaChange);
	else mediaQuery.addListener(handleMediaChange);

	return () => {
		toggleButton.removeEventListener("click", toggle);
		backdrop?.removeEventListener("click", closeOverlay);
		window.removeEventListener("keydown", handleKeydown);
		if (mediaQuery.removeEventListener)
			mediaQuery.removeEventListener("change", handleMediaChange);
		else mediaQuery.removeListener(handleMediaChange);
	};
}

export async function request(path, options = {}) {
	const headers = new Headers(options.headers || {});
	if (!headers.has("Accept")) headers.set("Accept", "application/json");
	const response = await fetch(path, {
		...options,
		credentials: "same-origin",
		headers,
	});
	const contentType = response.headers.get("content-type") || "";
	let data = null;
	if (contentType.includes("application/json")) {
		try {
			data = await response.json();
		} catch {
			data = null;
		}
	} else {
		data = await response.text();
	}
	if (!response.ok) {
		const message =
			typeof data === "object" && data?.message
				? data.message
				: typeof data === "string" && data
					? data
					: `Request failed (${response.status})`;
		const error = new Error(message);
		error.status = response.status;
		error.data = data;
		throw error;
	}
	return { response, data };
}

export function xhrRequest(
	url,
	{ method = "PUT", body, headers = {}, onProgress, signal } = {},
) {
	return new Promise((resolve, reject) => {
		const target = new URL(url, window.location.origin);
		if (target.origin !== window.location.origin) {
			reject(new Error("Cross-origin transfer is not allowed"));
			return;
		}
		const xhr = new XMLHttpRequest();
		let settled = false;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			callback(value);
		};
		const abort = () => {
			xhr.abort();
			finish(reject, new Error("Transfer cancelled"));
		};
		xhr.open(method, target.href);
		xhr.withCredentials = true;
		for (const [name, value] of Object.entries(headers))
			xhr.setRequestHeader(name, value);
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable) onProgress?.(event);
		};
		xhr.onload = () => {
			let data = null;
			try {
				data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
			} catch {
				data = xhr.responseText;
			}
			if (xhr.status >= 200 && xhr.status < 300)
				finish(resolve, { data, status: xhr.status });
			else {
				const error = new Error(
					typeof data === "object" && data?.message
						? data.message
						: `Transfer failed (${xhr.status})`,
				);
				error.status = xhr.status;
				error.data = data;
				finish(reject, error);
			}
		};
		xhr.onerror = () => finish(reject, new Error("Transfer network error"));
		xhr.onabort = () => finish(reject, new Error("Transfer cancelled"));
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) {
			abort();
			return;
		}
		xhr.send(body);
	});
}

function readActivity() {
	try {
		const records = JSON.parse(
			sessionStorage.getItem(ACTIVITY_STORAGE_KEY) || "[]",
		);
		return Array.isArray(records) ? records : [];
	} catch {
		return [];
	}
}

function writeActivity(records) {
	try {
		sessionStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(records));
	} catch {
		// Activity history is optional and must never block file operations.
	}
}

export function pruneActivity() {
	const now = Date.now();
	const records = readActivity().filter(
		(record) => typeof record.expiresAt === "number" && record.expiresAt > now,
	);
	writeActivity(records.slice(0, MAX_ACTIVITY_RECORDS));
	return records;
}

export function getActivity(scope) {
	return pruneActivity()
		.filter((record) => !scope || record.scope === scope)
		.slice(0, 10);
}

export function addActivity({ kind, key, name, scope, expiresAt }) {
	const records = pruneActivity();
	records.unshift({
		id: `${kind}:${key}:${Date.now()}`,
		kind,
		key,
		name,
		scope,
		createdAt: Date.now(),
		expiresAt: expiresAt || Date.now() + ACTIVITY_TTL,
	});
	writeActivity(records.slice(0, MAX_ACTIVITY_RECORDS));
}

export function clearActivity(scope) {
	const records = scope
		? pruneActivity().filter((record) => record.scope !== scope)
		: [];
	writeActivity(records);
}

export function createSvgIcon(kind, className = "") {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	if (className) svg.setAttribute("class", className);
	const add = (tag, attributes) => {
		const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
		for (const [name, value] of Object.entries(attributes))
			node.setAttribute(name, value);
		svg.append(node);
	};
	if (kind === "folder") {
		add("path", {
			d: "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
			fill: "currentColor",
		});
	} else if (kind === "file") {
		add("path", {
			d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "2",
		});
		add("polyline", {
			points: "14 2 14 8 20 8",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "2",
		});
	} else if (kind === "lock") {
		add("rect", {
			width: "18",
			height: "11",
			x: "3",
			y: "11",
			rx: "2",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "2",
		});
		add("path", {
			d: "M7 11V7a5 5 0 0 1 10 0v4",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "2",
		});
	} else if (kind === "unlock") {
		add("circle", {
			cx: "12",
			cy: "12",
			r: "10",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "2",
		});
		add("path", {
			d: "M8 12h8",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "2",
		});
	} else if (kind === "download") {
		add("path", {
			d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "2",
		});
		add("polyline", {
			points: "7 10 12 15 17 10",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "2",
		});
		add("line", {
			x1: "12",
			y1: "15",
			x2: "12",
			y2: "3",
			stroke: "currentColor",
			"stroke-width": "2",
		});
	} else if (kind === "upload") {
		add("path", {
			d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "2",
		});
		add("polyline", {
			points: "17 8 12 3 7 8",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "2",
		});
		add("line", {
			x1: "12",
			y1: "3",
			x2: "12",
			y2: "15",
			stroke: "currentColor",
			"stroke-width": "2",
		});
	}
	return svg;
}

export function renderActivity(container, scope) {
	if (!container) return;
	container.replaceChildren();
	const records = getActivity(scope);
	if (!records.length) {
		const empty = document.createElement("div");
		empty.className = "record-empty";
		empty.textContent = "暂无相关记录";
		container.append(empty);
		return;
	}
	for (const record of records) {
		const item = document.createElement("div");
		item.className = "record-item";
		item.title = `${record.kind === "upload" ? "上传" : "下载"}: ${record.name}`;
		const info = document.createElement("div");
		info.className = "record-info";
		info.append(createSvgIcon(record.kind, `record-icon ${record.kind}`));
		const name = document.createElement("span");
		name.className = "record-name";
		name.textContent = record.name;
		info.append(name);
		item.append(info);
		container.append(item);
	}
}

let modalState = null;

function modalParts() {
	const overlay = document.getElementById("appModal");
	if (!overlay) return null;
	return {
		overlay,
		title: document.getElementById("modalTitle"),
		description: document.getElementById("modalDesc"),
		input: document.getElementById("modalInput"),
		body: document.getElementById("modalBody"),
		footer:
			document.getElementById("modalFooter") ||
			overlay.querySelector(".modal-footer"),
		cancel: document.getElementById("modalCancelBtn"),
		confirm: document.getElementById("modalConfirmBtn"),
	};
}

function currentModalInput(parts) {
	if (parts.input && parts.input.style.display !== "none") return parts.input;
	return parts.body?.querySelector("input, select, textarea") || null;
}

function modalError(parts) {
	const parent = parts.body || parts.description?.parentElement;
	if (!parent) return null;
	let error = parent.querySelector(".cloudbox-modal-error");
	if (!error) {
		error = document.createElement("p");
		error.className = "cloudbox-modal-error";
		error.style.cssText = "margin: 12px 0 0; color: #b91c1c; font-size: 12px;";
		parent.append(error);
	}
	return error;
}

export function closeModal() {
	const parts = modalParts();
	if (!parts) return;
	parts.overlay.classList.remove("active");
	if (parts.confirm) parts.confirm.disabled = false;
	if (parts.cancel) parts.cancel.disabled = false;
	if (parts.input) {
		parts.input.value = "";
		parts.input.style.display = "none";
	}
	if (parts.body) parts.body.replaceChildren();
	modalState = null;
}

export function openModal({
	title,
	description = "",
	showInput = false,
	inputType = "text",
	inputPlaceholder = "",
	confirmText = "确定",
	cancelText = "取消",
	hideFooter = false,
	renderBody,
	onConfirm,
}) {
	const parts = modalParts();
	if (!parts) return;
	if (!parts.confirm.dataset.cloudboxBound) {
		parts.confirm.addEventListener("click", async () => {
			if (!modalState?.onConfirm) return;
			const state = modalState;
			const input = currentModalInput(parts);
			parts.confirm.disabled = true;
			if (parts.cancel) parts.cancel.disabled = true;
			const error = modalError(parts);
			if (error) error.textContent = "";
			try {
				const shouldClose = await state.onConfirm(input?.value || "");
				if (shouldClose !== false) closeModal();
			} catch (caught) {
				const message = caught?.message || "操作失败，请稍后重试";
				const target = modalError(parts);
				if (target) target.textContent = message;
			} finally {
				if (modalState === state) {
					parts.confirm.disabled = false;
					if (parts.cancel) parts.cancel.disabled = false;
				}
			}
		});
		parts.confirm.dataset.cloudboxBound = "true";
		parts.cancel?.addEventListener("click", closeModal);
		window.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && parts.overlay.classList.contains("active"))
				closeModal();
		});
	}

	parts.title.textContent = title;
	parts.confirm.textContent = confirmText;
	if (parts.cancel) parts.cancel.textContent = cancelText;
	if (parts.footer) parts.footer.style.display = hideFooter ? "none" : "flex";
	if (parts.description) {
		parts.description.textContent = description;
		parts.description.style.display = description ? "block" : "none";
	}
	if (parts.input) {
		parts.input.style.display = showInput ? "block" : "none";
		parts.input.type = inputType;
		parts.input.placeholder = inputPlaceholder;
		parts.input.value = "";
	}
	if (parts.body) {
		parts.body.replaceChildren();
		if (description) {
			const paragraph = document.createElement("p");
			paragraph.textContent = description;
			parts.body.append(paragraph);
		}
		renderBody?.(parts.body);
	}
	modalState = { onConfirm };
	parts.overlay.classList.add("active");
	if (showInput) (parts.input || parts.body?.querySelector("input"))?.focus();
}

export function beginActivityTicker(renderers) {
	const refresh = () =>
		renderers.forEach(({ container, scope }) =>
			renderActivity(container, scope),
		);
	const timer = window.setInterval(refresh, 60_000);
	return () => window.clearInterval(timer);
}
