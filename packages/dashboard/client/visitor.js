import {
	addActivity,
	beginActivityTicker,
	bytesToSize,
	cloudboxR2AdminPath,
	createSvgIcon,
	decodeKey,
	encodeKey,
	formatDate,
	initResponsiveSidebar,
	openModal,
	renderActivity,
	request,
	sameOriginPath,
} from "/cloudbox-r2/runtime.js";

const state = {
	prefix: "",
	publicPrefix: "",
	search: "",
	rows: [],
	cursor: null,
	truncated: false,
	loading: false,
	requestId: 0,
	searchTimer: null,
};

const searchInput = document.getElementById("searchInput");
const adminEntryButton = document.getElementById("adminEntryBtn");
const recentRecords = document.getElementById("recentRecordsList");
const tableBody = document.getElementById("fileListBody");
const fileContainer = document.querySelector(".file-container");
const breadcrumb = document.getElementById("breadcrumb");

function folderFromLocation() {
	const match = location.pathname.match(/^\/public\/folder\/([^/]+)\/?$/);
	if (!match) return "";
	try {
		return decodeKey(decodeURIComponent(match[1]));
	} catch {
		return "";
	}
}

function searchFromLocation() {
	return new URLSearchParams(location.search).get("q")?.trim() || "";
}

function relativeFolderPrefix() {
	return state.publicPrefix && state.prefix.startsWith(state.publicPrefix)
		? state.prefix.slice(state.publicPrefix.length)
		: state.prefix;
}

function effectiveFolderPrefix() {
	return state.publicPrefix && state.prefix.startsWith(state.publicPrefix)
		? state.prefix
		: `${state.publicPrefix}${state.prefix}`;
}

function requestPrefix() {
	return `${relativeFolderPrefix()}${state.search}`;
}

function displayName(key) {
	const prefix = effectiveFolderPrefix();
	const name = key.startsWith(prefix) ? key.slice(prefix.length) : key;
	return name.endsWith("/") ? name.slice(0, -1) : name;
}

function setPageError(message) {
	document.querySelector(".cloudbox-page-error")?.remove();
	if (!message) return;
	const error = document.createElement("div");
	error.className = "cloudbox-page-error";
	error.setAttribute("role", "alert");
	error.style.cssText =
		"margin-bottom:16px;padding:12px 16px;border:1px solid #fecaca;border-radius:8px;background:#fef2f2;color:#991b1b;font-size:13px;";
	error.textContent = message;
	fileContainer?.prepend(error);
}

function parentFolderPrefix() {
	const current = relativeFolderPrefix().replace(/\/$/, "");
	const separator = current.lastIndexOf("/");
	return separator < 0
		? ""
		: `${state.publicPrefix}${current.slice(0, separator + 1)}`;
}

function renderBreadcrumb() {
	if (!breadcrumb) return;
	const home =
		breadcrumb.querySelector(".home-icon-btn")?.cloneNode(true) ||
		document.createElement("span");
	home.className = "home-icon-btn";
	home.title = "根目录";
	home.addEventListener("click", () => navigateFolder(""));
	const rootSeparator = document.createElement("span");
	rootSeparator.textContent = "/";
	const root = document.createElement("span");
	root.className = "breadcrumb-item current";
	root.textContent = "首页";
	breadcrumb.replaceChildren();
	if (relativeFolderPrefix()) {
		const back = document.createElement("button");
		back.type = "button";
		back.className = "back-btn";
		back.setAttribute("aria-label", "返回上一级目录");
		back.textContent = "返回";
		back.addEventListener("click", () => navigateFolder(parentFolderPrefix()));
		breadcrumb.append(back);
	}
	breadcrumb.append(home, rootSeparator, root);

	const parts = relativeFolderPrefix().split("/").filter(Boolean);
	parts.forEach((part, index) => {
		const separator = document.createElement("span");
		separator.textContent = "/";
		const item = document.createElement("span");
		item.className = "breadcrumb-item";
		item.textContent = part;
		const prefix = `${state.publicPrefix}${parts.slice(0, index + 1).join("/")}/`;
		item.addEventListener("click", () => navigateFolder(prefix));
		breadcrumb.append(separator, item);
	});
}

function renderRow(row) {
	const tr = document.createElement("tr");
	tr.dataset.key = row.key;
	tr.dataset.type = row.type;
	tr.addEventListener("click", () => openRow(row));

	const nameCell = document.createElement("td");
	const fileCell = document.createElement("div");
	fileCell.className = "file-cell";
	const icon = createSvgIcon(
		row.type === "folder" ? "folder" : "file",
		`file-icon ${row.type === "folder" ? "folder-color" : "file-color"}`,
	);
	const name = document.createElement("span");
	name.className = "file-name";
	if (row.type === "folder" && row.locked) {
		const iconWrap = document.createElement("span");
		iconWrap.className = "file-icon-wrap";
		const lockBadge = createSvgIcon("lock", "folder-lock-badge");
		lockBadge.setAttribute("aria-label", "已加密");
		iconWrap.append(icon, lockBadge);
		fileCell.append(iconWrap);
	} else {
		if (row.locked) {
			const lock = createSvgIcon("lock", "lock-inline-icon");
			lock.setAttribute("aria-label", "已加密");
			fileCell.append(lock);
		}
		fileCell.append(icon);
	}
	name.textContent = row.name;
	fileCell.append(name);
	nameCell.append(fileCell);

	const updated = document.createElement("td");
	updated.textContent = row.updated;
	const size = document.createElement("td");
	size.textContent = row.size;
	const statusCell = document.createElement("td");
	const status = document.createElement("span");
	status.className = `lock-badge ${row.locked ? "" : "cloudbox-public-status"}`;
	if (row.locked) status.append(createSvgIcon("lock"));
	status.append(document.createTextNode(row.locked ? "已加密" : "公开"));
	statusCell.append(status);
	tr.append(nameCell, updated, size, statusCell);
	return tr;
}

function renderRows() {
	tableBody.replaceChildren();
	if (state.loading && !state.rows.length) {
		const row = document.createElement("tr");
		const cell = document.createElement("td");
		cell.colSpan = 4;
		cell.className = "cloudbox-table-state";
		cell.textContent = "加载中...";
		row.append(cell);
		tableBody.append(row);
		return;
	}
	if (!state.loading && !state.rows.length) {
		const row = document.createElement("tr");
		const cell = document.createElement("td");
		cell.colSpan = 4;
		cell.className = "cloudbox-table-state";
		cell.textContent = state.search ? "没有匹配的公开资源" : "当前目录为空";
		row.append(cell);
		tableBody.append(row);
		return;
	}
	state.rows.forEach((row) => tableBody.append(renderRow(row)));
}

async function loadFiles(reset = true) {
	if (state.loading) return;
	if (reset) {
		state.rows = [];
		state.cursor = null;
		state.truncated = false;
	}
	state.loading = true;
	const requestId = ++state.requestId;
	setPageError("");
	renderRows();
	try {
		const query = new URLSearchParams();
		const prefix = requestPrefix();
		if (prefix) query.set("prefix", encodeKey(prefix));
		if (!reset && state.cursor) query.set("cursor", state.cursor);
		const result = await request(
			`/api/public/files${query.toString() ? `?${query}` : ""}`,
		);
		if (requestId !== state.requestId) return;
		if (typeof result.data?.publicPrefix === "string") {
			state.publicPrefix = result.data.publicPrefix;
			renderBreadcrumb();
		}
		const objects = Array.isArray(result.data?.objects)
			? result.data.objects
			: [];
		const folders = Array.isArray(result.data?.delimitedPrefixes)
			? result.data.delimitedPrefixes
			: [];
		const folderRows = folders.map((folder) => ({
			key: folder.key,
			name: displayName(folder.key),
			updated: "-",
			size: "-",
			type: "folder",
			locked: folder.locked === true,
		}));
		const fileRows = objects
			.filter((object) => !object.key.endsWith("/"))
			.map((object) => ({
				key: object.key,
				name: displayName(object.key),
				updated: formatDate(object.uploaded),
				size: bytesToSize(object.size),
				type: "file",
				locked: object.locked === true,
			}));
		state.rows = reset
			? [...folderRows, ...fileRows]
			: [...state.rows, ...folderRows, ...fileRows];
		state.cursor = result.data?.cursor || null;
		state.truncated = result.data?.truncated === true;
	} catch (error) {
		if (requestId === state.requestId)
			setPageError(
				error.status === 401
					? "当前目录受保护，请使用安全解锁入口。"
					: "无法加载公开资源",
			);
	} finally {
		if (requestId === state.requestId) {
			state.loading = false;
			renderRows();
		}
	}
}

function navigateFolder(prefix) {
	const target = prefix ? `/public/folder/${encodeKey(prefix)}` : "/";
	location.assign(target);
}

function publicTargetUrl(row) {
	return row.type === "folder"
		? `/public/folder/${encodeKey(row.key)}`
		: `/public/file/${encodeKey(row.key)}`;
}

function openLockedRow(row) {
	openModal({
		title: "受保护的资源",
		description: `【${row.name}】处于加密保护状态，请输入访问提取码：`,
		showInput: true,
		inputType: "password",
		inputPlaceholder: "请输入解锁密码",
		confirmText: "验证解锁",
		onConfirm: async (password) => {
			if (!password) throw new Error("请输入解锁密码");
			try {
				await request(`${publicTargetUrl(row)}/unlock`, {
					method: "POST",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
					},
					body: new URLSearchParams({ password }),
				});
				if (row.type === "file") {
					addActivity({
						kind: "download",
						key: row.key,
						name: row.name,
						scope: "public",
					});
					renderActivity(recentRecords, "public");
				}
				location.assign(publicTargetUrl(row));
			} catch (error) {
				throw new Error(
					error.status === 404 ? "解锁失败或资源不可用" : "解锁服务暂时不可用",
				);
			}
		},
	});
}

function openDownload(row) {
	openModal({
		title: "下载文件",
		description: `确定要下载公开文件【${row.name}】吗？（大小：${row.size}）`,
		confirmText: "立即下载",
		onConfirm: () => {
			addActivity({
				kind: "download",
				key: row.key,
				name: row.name,
				scope: "public",
			});
			renderActivity(recentRecords, "public");
			location.assign(publicTargetUrl(row));
		},
	});
}

function openRow(row) {
	if (row.type === "folder") {
		if (row.locked) openLockedRow(row);
		else navigateFolder(row.key);
		return;
	}
	if (row.locked) openLockedRow(row);
	else openDownload(row);
}

function openAdminEntry() {
	openModal({
		title: "进入管理后台",
		description: "请输入管理后台登录入口地址：",
		showInput: true,
		inputType: "text",
		confirmText: "前往登录",
		onConfirm: (value) => {
			const path = sameOriginPath(value, cloudboxR2AdminPath());
			if (!path) throw new Error("请输入当前站点的有效管理入口");
			location.assign(path);
		},
	});
}

function updateSearchUrl(value) {
	const url = new URL(location.href);
	if (value) url.searchParams.set("q", value);
	else url.searchParams.delete("q");
	history.replaceState(null, "", url);
}

function init() {
	state.prefix = folderFromLocation();
	state.search = searchFromLocation();
	searchInput.value = state.search;
	renderBreadcrumb();
	renderActivity(recentRecords, "public");
	initResponsiveSidebar();
	adminEntryButton?.addEventListener("click", openAdminEntry);
	searchInput?.addEventListener("input", () => {
		state.search = searchInput.value.trim();
		updateSearchUrl(state.search);
		clearTimeout(state.searchTimer);
		state.searchTimer = window.setTimeout(() => loadFiles(true), 220);
	});
	fileContainer?.addEventListener("scroll", () => {
		if (
			fileContainer.scrollTop + fileContainer.clientHeight >=
				fileContainer.scrollHeight - 160 &&
			state.truncated
		)
			loadFiles(false);
	});
	loadFiles(true);
	beginActivityTicker([{ container: recentRecords, scope: "public" }]);
}

init();
