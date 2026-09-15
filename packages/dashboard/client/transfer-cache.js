const DATABASE_NAME = "cloudbox-r2-transfers";
const STORE_NAME = "uploads";

function transferId(bucket, key) {
	return `${bucket}\0${key}`;
}

function openDatabase() {
	if (typeof indexedDB === "undefined") return null;
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, 1);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE_NAME))
				request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function getDatabase() {
	try {
		return await openDatabase();
	} catch {
		return null;
	}
}

export async function saveUpload(record) {
	const database = await getDatabase();
	if (!database) return;
	try {
		await new Promise((resolve, reject) => {
			const request = database
				.transaction(STORE_NAME, "readwrite")
				.objectStore(STORE_NAME)
				.put({
					id: transferId(record.bucket, record.key),
					bucket: record.bucket,
					key: record.key,
					fileName: record.fileName,
					size: record.size,
					lastModified: record.lastModified,
					fingerprint: record.fingerprint,
					mode: record.mode,
					partSize: record.partSize,
					completedParts: record.completedParts || {},
					expiresAt: record.expiresAt,
				});
			request.onsuccess = resolve;
			request.onerror = () => reject(request.error);
		});
	} catch {
		// Transfer recovery is optional and must not block an upload.
	} finally {
		database.close();
	}
}

export async function removeUpload(bucket, key) {
	const database = await getDatabase();
	if (!database) return;
	try {
		await new Promise((resolve, reject) => {
			const request = database
				.transaction(STORE_NAME, "readwrite")
				.objectStore(STORE_NAME)
				.delete(transferId(bucket, key));
			request.onsuccess = resolve;
			request.onerror = () => reject(request.error);
		});
	} catch {
		// Transfer recovery is optional and must not block an upload.
	} finally {
		database.close();
	}
}

export async function listUploads() {
	const database = await getDatabase();
	if (!database) return [];
	try {
		return await new Promise((resolve, reject) => {
			const request = database
				.transaction(STORE_NAME, "readonly")
				.objectStore(STORE_NAME)
				.getAll();
			request.onsuccess = () => resolve(request.result || []);
			request.onerror = () => reject(request.error);
		});
	} catch {
		return [];
	} finally {
		database.close();
	}
}

export async function pruneUploads() {
	const records = await listUploads();
	const now = Date.now();
	await Promise.all(
		records
			.filter((record) => !record.expiresAt || record.expiresAt <= now)
			.map((record) => removeUpload(record.bucket, record.key)),
	);
	return records.filter((record) => record.expiresAt > now);
}
