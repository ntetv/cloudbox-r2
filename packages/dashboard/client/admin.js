import {
	addActivity,
	beginActivityTicker,
	bytesToSize,
	closeModal,
	cloudboxR2AdminPath,
	createSvgIcon,
	decodeKey,
	encodeKey,
	formatDate,
	initResponsiveSidebar,
	openModal,
	renderActivity,
	request,
	xhrRequest,
} from "/cloudbox-r2/runtime.js";
import {
	pruneUploads,
	removeUpload,
	saveUpload,
} from "/cloudbox-r2/transfer-cache.js";

const DIRECT_UPLOAD_MAX_BYTES = 95 * 1024 * 1024;
const state = {
	bucket: "",
	prefix: "",
	search: "",
	rows: [],
	cursor: null,
	truncated: false,
	loading: false,
	searchTimer: null,
	requestId: 0,
};

const searchInput = document.getElementById("searchInput");
const exitButton = document.getElementById("exitAdminBtn");
const recentRecords = document.getElementById("recentRecordsList");
const tableBody = document.getElementById("fileListBody");
const fileContainer = document.querySelector(".file-container");
const breadcrumb = document.getElementById("breadcrumb");
const currentPathName = document.getElementById("currentPathName");
let uploadInput;
let fallbackUploadStatus;
let uploadAbortController;
let activeTransfer;
let uploadCancellationRequested = false;
let contextMenu;
let stopActivityTicker;

function installRuntimeStyles() {
	const style = document.createElement("style");
	style.textContent = `
    .cloudbox-context-menu__item { display:block; width:100%; padding:8px 10px; border:0; border-radius:4px; background:#fff; color:#0f172a; cursor:pointer; text-align:left; font-size:13px; }
    .cloudbox-context-menu__item:hover { background:#f1f5f9; }
    .cloudbox-context-menu__item:disabled { cursor:not-allowed; opacity:.5; }
    .cloudbox-upload-status { position:relative; margin:0; padding-bottom:8px; color:#64748b; font-size:12px; }
    .cloudbox-upload-status::after { content:""; position:absolute; right:0; bottom:0; left:0; height:3px; border-radius:99px; background:#e2e8f0; opacity:0; }
    .cloudbox-upload-status::before { content:""; position:absolute; bottom:0; left:0; width:var(--upload-progress, 0%); height:3px; border-radius:99px; background:#2563eb; opacity:0; transition:width .16s ease; }
    .cloudbox-upload-status.is-uploading::after,
    .cloudbox-upload-status.is-uploading::before { opacity:1; }
  `;
	document.head.append(style);
}

function setUploadStatus(status, message, progress) {
	status.textContent = message;
	if (!status.classList || !status.style) return;
	if (typeof progress === "number") {
		status.classList.add("is-uploading");
		status.style.setProperty("--upload-progress", `${progress}%`);
	} else {
		status.classList.remove("is-uploading");
		status.style.removeProperty("--upload-progress");
	}
}

function routeState() {
	const parts = location.pathname.split("/").filter(Boolean);
	const root = cloudboxR2AdminPath();
	const rootSegment = root?.slice(1);
	const bucket = parts[0] === rootSegment ? parts[1] : "";
	const folder = parts[2] === "files" && parts[3] ? parts[3] : "";
	let prefix = "";
	if (folder) {
		try {
			prefix = decodeKey(decodeURIComponent(folder));
		} catch {
			prefix = "";
		}
	}
	return { bucket: decodeURIComponent(bucket || ""), prefix };
}

function adminPath(path) {
	const root = cloudboxR2AdminPath();
	if (!root) throw new Error("管理入口配置不可用");
	return `${root}${path}`;
}

function objectPath(key) {
	return adminPath(
		`/api/buckets/${encodeURIComponent(state.bucket)}/${encodeKey(key)}`,
	);
}

function listPath(prefix, cursor, delimiter = "/") {
	const query = new URLSearchParams();
	if (delimiter !== undefined) query.set("delimiter", delimiter);
	query.append("include", "customMetadata");
	query.append("include", "httpMetadata");
	if (prefix) query.set("prefix", encodeKey(prefix));
	if (cursor) query.set("cursor", cursor);
	query.set("includeAccessLocks", "true");
	return adminPath(`/api/buckets/${encodeURIComponent(state.bucket)}?${query}`);
}

function showNotice(message, type = "info") {
	document.querySelector(".cloudbox-notice")?.remove();
	if (!message) return;
	const notice = document.createElement("div");
	notice.className = "cloudbox-notice";
	notice.style.cssText = `margin-bottom:16px;padding:12px 16px;border:1px solid ${type === "error" ? "#fecaca" : "#bfdbfe"};border-radius:8px;background:${type === "error" ? "#fef2f2" : "#eff6ff"};color:${type === "error" ? "#991b1b" : "#1d4ed8"};font-size:13px;`;
	notice.textContent = message;
	document.querySelector(".table-card")?.before(notice);
}

function displayName(key) {
	const name = key.startsWith(state.prefix)
		? key.slice(state.prefix.length)
		: key;
	return name.endsWith("/") ? name.slice(0, -1) : name;
}

function isPublicBucket(config) {
	return config?.config?.publicBucket?.binding === state.bucket;
}

function isReadonly() {
	return window.cloudboxR2Config?.config?.readonly === true;
}

function parentFolderPrefix() {
	const current = state.prefix.replace(/\/$/, "");
	const separator = current.lastIndexOf("/");
	return separator < 0 ? "" : current.slice(0, separator + 1);
}

function renderBreadcrumb() {
	if (breadcrumb) {
		breadcrumb.querySelector(".back-btn")?.remove();
		if (state.prefix) {
			const back = document.createElement("button");
			back.type = "button";
			back.className = "back-btn";
			back.setAttribute("aria-label", "返回上一级目录");
			back.textContent = "返回";
			back.addEventListener("click", () =>
				navigateFolder(parentFolderPrefix()),
			);
			breadcrumb.prepend(back);
		}
	}
	if (currentPathName)
		currentPathName.textContent = state.prefix.replace(/\/$/, "") || "首页";
}

function bindBreadcrumb() {
	const home = breadcrumb?.querySelector(".home-icon-btn");
	if (!home) return;
	home.removeAttribute("onclick");
	home.addEventListener("click", () => navigateFolder(""));
}

function createAction(label, className, handler, disabled = false) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = `btn-table-action ${className || ""}`;
	button.textContent = label;
	button.disabled = disabled;
	button.addEventListener("click", (event) => {
		event.stopPropagation();
		handler();
	});
	return button;
}

function renderRow(row) {
	const tr = document.createElement("tr");
	tr.dataset.key = row.key;
	tr.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		showContextMenu(row, event.clientX, event.clientY);
	});

	const nameCell = document.createElement("td");
	const fileCell = document.createElement("div");
	fileCell.className = "file-cell";
	fileCell.addEventListener("dblclick", () => openRow(row));
	const icon = createSvgIcon(
		row.type === "folder" ? "folder" : "file",
		`file-icon ${row.type === "folder" ? "folder-color" : "file-color"}`,
	);
	if (row.type === "folder" && row.locked) {
		const iconWrap = document.createElement("span");
		iconWrap.className = "file-icon-wrap";
		iconWrap.append(icon, createSvgIcon("lock", "folder-lock-badge"));
		fileCell.append(iconWrap);
	} else {
		fileCell.append(icon);
	}
	const name = document.createElement("span");
	name.className = "file-name";
	name.textContent = row.name;
	fileCell.append(name);
	nameCell.append(fileCell);

	const updatedCell = document.createElement("td");
	updatedCell.textContent = row.updated;
	const sizeCell = document.createElement("td");
	sizeCell.textContent = row.size;

	const accessCell = document.createElement("td");
	const status = document.createElement("span");
	status.className = `status-badge ${row.locked ? "locked" : "public"}`;
	status.append(createSvgIcon(row.locked ? "lock" : "unlock"));
	status.append(document.createTextNode(row.locked ? "加密" : "公开"));
	status.title = "点击切换访问策略";
	status.addEventListener("click", (event) => {
		event.stopPropagation();
		if (!isReadonly()) openPermissionModal(row);
	});
	accessCell.append(status);

	const actionsCell = document.createElement("td");
	const actions = document.createElement("div");
	actions.className = "table-actions";
	actions.append(
		createAction(
			row.type === "folder" ? "打开" : "下载",
			row.type === "folder" ? "open-folder" : "",
			() => openRow(row),
		),
		createAction("设密", "", () => openPermissionModal(row), isReadonly()),
		createAction("删除", "delete", () => openDeleteModal(row), isReadonly()),
	);
	actionsCell.append(actions);
	tr.append(nameCell, updatedCell, sizeCell, accessCell, actionsCell);
	return tr;
}

function renderRows() {
	tableBody.replaceChildren();
	if (state.loading && !state.rows.length) {
		const row = document.createElement("tr");
		const cell = document.createElement("td");
		cell.colSpan = 5;
		cell.textContent = "加载中...";
		row.append(cell);
		tableBody.append(row);
		return;
	}
	if (!state.loading && !state.rows.length) {
		const row = document.createElement("tr");
		const cell = document.createElement("td");
		cell.colSpan = 5;
		cell.textContent = state.search ? "没有匹配的对象" : "当前目录为空";
		row.append(cell);
		tableBody.append(row);
		return;
	}
	state.rows.forEach((row) => tableBody.append(renderRow(row)));
}

async function loadConfig() {
	try {
		const result = await request(adminPath("/api/server/config"));
		return result.data;
	} catch (error) {
		if (error.status === 401) {
			location.assign(
				adminPath(
					`?next=${encodeURIComponent(location.pathname + location.search)}`,
				),
			);
			return null;
		}
		throw error;
	}
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
	renderRows();
	showNotice("");
	try {
		const result = await request(
			listPath(`${state.prefix}${state.search}`, reset ? null : state.cursor),
		);
		if (requestId !== state.requestId) return;
		const locks = result.data?.accessLocks || {};
		const folders = (result.data?.delimitedPrefixes || []).map((key) => ({
			key,
			name: displayName(key),
			updated: "—",
			size: "—",
			type: "folder",
			locked: locks[key]?.locked === true,
			accessLock: locks[key],
		}));
		const files = (result.data?.objects || [])
			.filter((object) => !object.key.endsWith("/"))
			.map((object) => ({
				...object,
				key: object.key,
				name: displayName(object.key),
				updated: formatDate(object.uploaded),
				size: bytesToSize(object.size),
				type: "file",
				locked: locks[object.key]?.locked === true,
				accessLock: locks[object.key],
			}));
		state.rows = reset
			? [...folders, ...files]
			: [...state.rows, ...folders, ...files];
		state.cursor = result.data?.cursor || null;
		state.truncated = result.data?.truncated === true;
	} catch (error) {
		if (requestId === state.requestId) {
			if (error.status === 401)
				location.assign(
					adminPath(
						`?next=${encodeURIComponent(location.pathname + location.search)}`,
					),
				);
			else showNotice(error.message || "无法加载文件列表", "error");
		}
	} finally {
		if (requestId === state.requestId) {
			state.loading = false;
			renderRows();
		}
	}
}

function navigateFolder(key) {
	location.assign(
		adminPath(`/${encodeURIComponent(state.bucket)}/files/${encodeKey(key)}`),
	);
}

async function downloadRow(row) {
	try {
		const result = await request(adminPath("/api/transfers/download"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ bucket: state.bucket, key: encodeKey(row.key) }),
		});
		addActivity({
			kind: "download",
			key: row.key,
			name: row.name,
			scope: "admin",
			expiresAt: result.data.expiresAt,
		});
		renderActivity(recentRecords, "admin");
		location.assign(result.data.url);
	} catch (error) {
		showNotice(error.message || "下载失败", "error");
	}
}

function openDownloadConfirmation(row) {
	openModal({
		title: "下载文件",
		description: `确定要下载公开文件【${row.name}】吗？（大小：${row.size}）`,
		confirmText: "立即下载",
		onConfirm: () => downloadRow(row),
	});
}

function openRow(row) {
	if (row.type === "folder") navigateFolder(row.key);
	else openDownloadConfirmation(row);
}

function menuItem(menu, label, handler, disabled = false) {
	const item = document.createElement("button");
	item.type = "button";
	item.className = "cloudbox-context-menu__item";
	item.textContent = label;
	item.disabled = disabled;
	item.addEventListener("click", () => {
		closeContextMenu();
		handler();
	});
	menu.append(item);
}

function closeContextMenu() {
	contextMenu?.remove();
	contextMenu = null;
}

function showContextMenu(row, x, y) {
	closeContextMenu();
	contextMenu = document.createElement("div");
	contextMenu.className = "q-menu cloudbox-context-menu";
	contextMenu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:10000;min-width:150px;padding:4px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;box-shadow:0 8px 20px rgb(15 23 42 / 15%);`;
	menuItem(contextMenu, "Open", () => openRow(row));
	if (row.type === "file")
		menuItem(contextMenu, "Download", () => openDownloadConfirmation(row));
	menuItem(contextMenu, "Duplicate", () => duplicateRow(row), isReadonly());
	if (row.type === "file")
		menuItem(
			contextMenu,
			"Update Metadata",
			() => openMetadataModal(row),
			isReadonly(),
		);
	if (isPublicBucket(window.cloudboxR2Config))
		menuItem(
			contextMenu,
			"Configure Access Lock",
			() => openPermissionModal(row),
			isReadonly(),
		);
	if (isPublicBucket(window.cloudboxR2Config))
		menuItem(contextMenu, "Copy Public URL", () => copyPublicUrl(row));
	menuItem(contextMenu, "Copy Internal Link", () => copyInternalLink(row));
	menuItem(contextMenu, "Delete", () => openDeleteModal(row), isReadonly());
	document.body.append(contextMenu);
	const dismiss = (event) => {
		if (!contextMenu?.contains(event.target)) {
			closeContextMenu();
			document.removeEventListener("pointerdown", dismiss);
		}
	};
	window.setTimeout(() => document.addEventListener("pointerdown", dismiss), 0);
}

async function duplicateRow(row) {
	const destination =
		row.type === "folder"
			? `${row.key.replace(/\/$/, "")} (copy)/`
			: `${row.key.replace(/(\.[^./]+)$/, " (copy)$1")}`;
	try {
		if (row.type === "folder")
			await request(
				adminPath(`/api/buckets/${encodeURIComponent(state.bucket)}/folder`),
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ key: encodeKey(destination) }),
				},
			);
		else
			await request(
				adminPath(`/api/buckets/${encodeURIComponent(state.bucket)}/copy`),
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						sourceKey: encodeKey(row.key),
						destinationKey: encodeKey(destination),
					}),
				},
			);
		await loadFiles(true);
	} catch (error) {
		showNotice(error.message || "复制失败", "error");
	}
}

async function copyPublicUrl(row) {
	const type = row.type === "folder" ? "folder" : "file";
	const url = `${location.origin}/public/${type}/${encodeKey(row.key)}`;
	await navigator.clipboard.writeText(url);
	showNotice("公开链接已复制");
}

async function copyInternalLink() {
	await navigator.clipboard.writeText(location.href);
	showNotice("内部链接已复制");
}

function formInput(labelText, type = "text", value = "") {
	const group = document.createElement("div");
	group.className = "form-group";
	const label = document.createElement("label");
	label.className = "form-label";
	label.textContent = labelText;
	const input = document.createElement("input");
	input.className = "modal-input";
	input.type = type;
	input.value = value;
	label.append(input);
	group.append(label);
	return { group, input };
}

async function openPermissionModal(row) {
	if (!isPublicBucket(window.cloudboxR2Config)) {
		openModal({
			title: "访问策略",
			description: "当前 bucket 未配置公开访问。",
			confirmText: "关闭",
			onConfirm: () => true,
		});
		return;
	}
	let status;
	try {
		status = (
			await request(adminPath(`/api/public-access/${encodeKey(row.key)}`))
		).data;
	} catch (error) {
		showNotice(error.message || "无法读取访问策略", "error");
		return;
	}
	const inherited = status.locked && status.target !== row.key;
	let mode;
	let password;
	openModal({
		title: `访问策略 - ${row.name}`,
		renderBody: (body) => {
			const summary = document.createElement("div");
			summary.className = "form-group";
			const summaryLabel = document.createElement("label");
			summaryLabel.className = "form-label";
			summaryLabel.textContent = "访问模式";
			mode = document.createElement("select");
			mode.className = "modal-input";
			for (const [value, label] of [
				["false", "公开"],
				["true", "加密"],
			]) {
				const option = document.createElement("option");
				option.value = value;
				option.textContent = label;
				option.selected = status.locked === (value === "true");
				mode.append(option);
			}
			summaryLabel.append(mode);
			summary.append(summaryLabel);
			body.append(summary);
			if (inherited) {
				const note = document.createElement("p");
				note.textContent = `此对象继承父级锁：${status.target}`;
				body.append(note);
				return;
			}
			const passwordField = formInput("设置解密提取码", "password");
			password = passwordField.input;
			body.append(passwordField.group);
			const sync = () => {
				passwordField.group.style.display =
					mode.value === "true" ? "flex" : "none";
			};
			mode.addEventListener("change", sync);
			sync();
		},
		confirmText: inherited ? "关闭" : status.locked ? "修改密码" : "保存",
		onConfirm: async () => {
			if (inherited) return true;
			if (mode.value === "true") {
				if (!password.value) throw new Error("加密模式下提取码不可为空");
				await request(adminPath(`/api/public-access/${encodeKey(row.key)}`), {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ password: password.value }),
				});
			} else {
				await request(adminPath(`/api/public-access/${encodeKey(row.key)}`), {
					method: "DELETE",
				});
			}
			await loadFiles(true);
			showNotice("Public access lock saved");
			return true;
		},
	});
}

async function headEtag(key, knownEtag) {
	if (knownEtag) return knownEtag;
	const result = await request(
		adminPath(
			`/api/buckets/${encodeURIComponent(state.bucket)}/${encodeKey(key)}/head`,
		),
	);
	return result.data?.etag;
}

async function deleteKey(key, etag) {
	const currentEtag = await headEtag(key, etag);
	await request(
		adminPath(`/api/buckets/${encodeURIComponent(state.bucket)}/delete`),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: encodeKey(key), etag: currentEtag }),
		},
	);
}

async function listAllObjects(prefix) {
	const objects = [];
	let cursor = null;
	do {
		const result = await request(listPath(prefix, cursor, ""));
		objects.push(...(result.data?.objects || []));
		cursor = result.data?.truncated ? result.data.cursor : null;
	} while (cursor);
	return objects;
}

function openDeleteModal(row) {
	openModal({
		title: "确认删除",
		description: `确定要彻底删除【${row.name}】吗？此操作无法撤回。`,
		confirmText: "删除",
		onConfirm: async () => {
			if (row.type === "folder") {
				const objects = await listAllObjects(row.key);
				for (const object of objects) {
					if (object.key !== row.key) await deleteKey(object.key, object.etag);
				}
			}
			try {
				await deleteKey(row.key, row.etag);
			} catch (error) {
				if (row.type !== "folder" || error.status !== 404) throw error;
			}
			await loadFiles(true);
			return true;
		},
	});
}

function openMetadataModal(row) {
	const custom = formInput("Custom Metadata");
	openModal({
		title: "Update Metadata",
		renderBody: (body) => body.append(custom.group),
		confirmText: "Update Metadata",
		onConfirm: async () => {
			const customMetadata = {};
			if (custom.input.value.trim())
				customMetadata.note = custom.input.value.trim();
			await request(objectPath(row.key), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					etag: row.etag,
					customMetadata,
					httpMetadata: {},
				}),
			});
			await loadFiles(true);
			return true;
		},
	});
}

function openNewFolderModal() {
	const field = formInput("文件夹名称");
	openModal({
		title: "新建文件夹",
		renderBody: (body) => body.append(field.group),
		confirmText: "创建",
		onConfirm: async () => {
			const name = field.input.value.trim();
			if (!name || name.includes("/") || name.includes("\\"))
				throw new Error("请输入有效文件夹名称");
			const key = `${state.prefix}${name.replace(/\/$/, "")}/`;
			await request(
				adminPath(`/api/buckets/${encodeURIComponent(state.bucket)}/folder`),
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ key: encodeKey(key) }),
				},
			);
			await loadFiles(true);
			return true;
		},
	});
}

function ensureUploadInput() {
	if (uploadInput) return uploadInput;
	uploadInput = document.createElement("input");
	uploadInput.type = "file";
	uploadInput.multiple = true;
	uploadInput.name = "files[]";
	uploadInput.style.display = "none";
	uploadInput.addEventListener("change", () => {
		const files = Array.from(uploadInput.files || []);
		uploadInput.value = "";
		processUploads(files);
	});
	document.body.append(uploadInput);
	return uploadInput;
}

function createUploadDialogBody() {
	const body = document.createElement("div");
	const actionRow = document.createElement("div");
	actionRow.className = "upload-action-row";
	const choose = document.createElement("button");
	choose.className = "btn btn-primary";
	choose.type = "button";
	choose.textContent = "选择文件";
	choose.addEventListener("click", () => ensureUploadInput().click());
	const cancel = document.createElement("button");
	cancel.className = "btn btn-secondary";
	cancel.type = "button";
	cancel.textContent = "返回";
	cancel.addEventListener("click", () => {
		if (!uploadAbortController && !activeTransfer) {
			closeModal();
			return;
		}
		void cancelActiveUpload();
	});
	actionRow.append(choose, cancel);
	const dropzone = document.createElement("div");
	dropzone.className = "upload-dropzone";
	dropzone.tabIndex = 0;
	dropzone.append(
		createSvgIcon("upload"),
		document.createTextNode("拖拽文件到这里"),
	);
	dropzone.addEventListener("dragover", (event) => {
		event.preventDefault();
		dropzone.classList.add("dragover");
	});
	dropzone.addEventListener("dragleave", () =>
		dropzone.classList.remove("dragover"),
	);
	dropzone.addEventListener("drop", (event) => {
		event.preventDefault();
		dropzone.classList.remove("dragover");
		processUploads(Array.from(event.dataTransfer.files || []));
	});
	const status = document.createElement("p");
	status.className = "cloudbox-upload-status";
	setUploadStatus(status, "支持文件选择和拖拽上传");
	body.append(actionRow, dropzone, status);
	return { body, status };
}

async function createTransfer(file, key) {
	const fingerprint = `${file.name}:${file.size}:${file.lastModified || 0}`;
	const result = await request(adminPath("/api/transfers/upload"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			bucket: state.bucket,
			key: encodeKey(key),
			size: file.size,
			fileName: file.name,
			lastModified: file.lastModified || 0,
			sha256: fingerprint,
			contentType: file.type,
		}),
	});
	const expectedMode =
		file.size <= DIRECT_UPLOAD_MAX_BYTES ? "single" : "multipart";
	if (result.data.mode !== expectedMode)
		throw new Error("上传模式与服务器不一致");
	await saveUpload({
		bucket: state.bucket,
		key,
		fileName: file.name,
		size: file.size,
		lastModified: file.lastModified || 0,
		fingerprint,
		mode: result.data.mode,
		partSize: result.data.partSize,
		completedParts: {},
		expiresAt: result.data.expiresAt,
	});
	return result.data;
}

async function completeTransfer(token) {
	return request(
		`/_cloudbox-r2-transfer/${encodeURIComponent(token)}/upload/complete`,
		{ method: "POST" },
	);
}

async function cancelTransfer(token) {
	if (!token) return { outcome: "no-token" };
	try {
		const result = await request(
			`/_cloudbox-r2-transfer/${encodeURIComponent(token)}/upload`,
			{ method: "DELETE" },
		);
		return { outcome: result.data?.outcome || "unknown" };
	} catch (error) {
		return {
			outcome: error?.data?.outcome || "unknown",
			status: error?.status,
		};
	}
}

function requestTransferCancellation(transfer) {
	if (!transfer?.token) return Promise.resolve({ outcome: "no-token" });
	if (!transfer.cancelPromise)
		transfer.cancelPromise = cancelTransfer(transfer.token);
	return transfer.cancelPromise;
}

async function finishUploadCancellation(transfer, result) {
	if (result.outcome === "unknown" || result.outcome === "no-token") {
		if (result.outcome === "unknown") transfer.cancelPromise = null;
		showNotice("无法确认上传取消状态，请稍后重试", "error");
		return;
	}
	if (transfer.cancelNoticeShown) return;
	transfer.cancelNoticeShown = true;
	await removeUpload(state.bucket, transfer.key);
	if (result.outcome === "cancelled") {
		closeModal();
		showNotice("上传已取消");
		return;
	}
	if (["completed", "too_late"].includes(result.outcome)) {
		closeModal();
		await loadFiles(true);
		showNotice("上传已完成");
		return;
	}
	transfer.cancelNoticeShown = false;
	showNotice("无法确认上传取消状态，请稍后重试", "error");
}

async function cancelActiveUpload() {
	uploadCancellationRequested = true;
	const transfer = activeTransfer;
	uploadAbortController?.abort();
	if (!transfer) {
		closeModal();
		showNotice("上传已取消");
		return;
	}
	const result = await requestTransferCancellation(transfer);
	await finishUploadCancellation(transfer, result);
}

function uploadFlowError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

async function uploadFile(file, status) {
	const key = `${state.prefix}${file.name}`;
	const controller = new AbortController();
	let transfer;
	uploadAbortController = controller;
	try {
		transfer = await createTransfer(file, key);
		activeTransfer = { token: transfer.token, key };
		if (uploadCancellationRequested) {
			const result = await requestTransferCancellation(activeTransfer);
			await finishUploadCancellation(activeTransfer, result);
			throw uploadFlowError("UPLOAD_CANCELLED", "上传已取消");
		}
		if (transfer.mode === "single") {
			await xhrRequest(transfer.bodyUrl, {
				body: file,
				signal: controller.signal,
				headers: { "Content-Type": "application/octet-stream" },
				onProgress: (event) => {
					setUploadStatus(
						status,
						`上传 ${file.name} ${Math.floor((event.loaded / file.size) * 100)}%`,
						(event.loaded / file.size) * 100,
					);
				},
			});
		} else {
			const partSize = transfer.partSize;
			for (
				let start = 0, part = 1;
				start < file.size;
				start += partSize, part++
			) {
				const chunk = file.slice(start, Math.min(start + partSize, file.size));
				await xhrRequest(
					`/_cloudbox-r2-transfer/${encodeURIComponent(transfer.token)}/upload/${part}`,
					{
						body: chunk,
						signal: controller.signal,
						headers: {
							"Content-Type": "application/octet-stream",
							"X-Cloudbox-R2-Part-Size": String(chunk.size),
						},
						onProgress: (event) => {
							setUploadStatus(
								status,
								`上传 ${file.name} ${Math.floor(((start + event.loaded) / file.size) * 100)}%`,
								((start + event.loaded) / file.size) * 100,
							);
						},
					},
				);
			}
		}
		if (controller.signal.aborted || uploadCancellationRequested) {
			const result = await requestTransferCancellation(activeTransfer);
			await finishUploadCancellation(activeTransfer, result);
			throw uploadFlowError("UPLOAD_CANCELLED", "上传已取消");
		}
		await completeTransfer(transfer.token);
		await removeUpload(state.bucket, key);
		addActivity({
			kind: "upload",
			key,
			name: file.name,
			scope: "admin",
			expiresAt: transfer.expiresAt,
		});
		renderActivity(recentRecords, "admin");
	} catch (error) {
		if (transfer?.token) {
			const cancellation = activeTransfer || {
				token: transfer.token,
				key,
			};
			const result = await requestTransferCancellation(cancellation);
			if (uploadCancellationRequested) {
				await finishUploadCancellation(cancellation, result);
			} else if (result.outcome !== "cancelled") {
				showNotice("上传失败，服务器取消未确认", "error");
			}
		}
		await removeUpload(state.bucket, key);
		throw error;
	} finally {
		if (activeTransfer?.token === transfer?.token) activeTransfer = null;
		if (uploadAbortController === controller) uploadAbortController = null;
	}
}

async function processUploads(files) {
	if (!files.length) return;
	let status = document.querySelector(".cloudbox-upload-status");
	if (!status) {
		if (!fallbackUploadStatus) fallbackUploadStatus = { textContent: "" };
		status = fallbackUploadStatus;
	}
	for (const file of files) {
		try {
			if (file.size > 5 * 1024 * 1024 * 1024)
				throw new Error("文件超过 R2 单对象大小限制");
			await uploadFile(file, status);
		} catch (error) {
			if (!uploadCancellationRequested)
				setUploadStatus(status, error.message || "上传失败");
			return;
		}
	}
	uploadCancellationRequested = false;
	setUploadStatus(status, "文件上传完成");
	await loadFiles(true);
}

function openUploadModal() {
	uploadCancellationRequested = false;
	const { body, status } = createUploadDialogBody();
	openModal({
		title: "上传文件",
		hideFooter: true,
		renderBody: (target) => target.append(body),
		onConfirm: () => true,
	});
	setUploadStatus(status, "支持文件选择和拖拽上传");
}

function openExitModal() {
	openModal({
		title: "退出管理",
		description: "确定退出管理模式吗？",
		confirmText: "退出",
		onConfirm: async () => {
			await request(adminPath("/api/auth/session"), { method: "DELETE" });
			sessionStorage.removeItem("cloudbox-r2.activity.v1");
			location.assign("/");
			return true;
		},
	});
}

function updateSearchUrl(value) {
	const url = new URL(location.href);
	if (value) url.searchParams.set("q", value);
	else url.searchParams.delete("q");
	history.replaceState(null, "", url);
}

async function init() {
	installRuntimeStyles();
	initResponsiveSidebar();
	const route = routeState();
	state.bucket = route.bucket;
	state.prefix = route.prefix;
	if (!state.bucket) {
		const root = cloudboxR2AdminPath();
		if (root) location.assign(root);
		else showNotice("管理入口配置不可用", "error");
		return;
	}
	try {
		const serverConfig = await loadConfig();
		window.cloudboxR2Config = {
			...window.cloudboxR2Config,
			...(serverConfig || {}),
		};
		await pruneUploads();
		ensureUploadInput();
		state.search = new URLSearchParams(location.search).get("q")?.trim() || "";
		searchInput.value = state.search;
		bindBreadcrumb();
		renderBreadcrumb();
		renderActivity(recentRecords, "admin");
		exitButton?.addEventListener("click", openExitModal);
		document
			.querySelector('[onclick="openUploadModal()"]')
			?.removeAttribute("onclick");
		document
			.querySelector('[onclick="openNewFolderModal()"]')
			?.removeAttribute("onclick");
		const uploadButton = document.querySelector(
			'.sidebar-admin-actions button[title="上传文件"]',
		);
		const folderButton = document.querySelector(
			'.sidebar-admin-actions button[title="新建文件夹"]',
		);
		if (uploadButton) uploadButton.disabled = isReadonly();
		if (folderButton) folderButton.disabled = isReadonly();
		uploadButton?.addEventListener("click", openUploadModal);
		folderButton?.addEventListener("click", openNewFolderModal);
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
		await loadFiles(true);
		stopActivityTicker = beginActivityTicker([
			{ container: recentRecords, scope: "admin" },
		]);
	} catch (error) {
		showNotice(error.message || "管理页面初始化失败", "error");
	}
}

window.addEventListener("beforeunload", () => stopActivityTicker?.());
init();
