export type ByteRange = {
	start: number;
	end: number;
};

export type RangeParseResult = { range: ByteRange | null } | { invalid: true };

export function parseByteRange(
	value: string | null,
	size: number,
): RangeParseResult {
	if (!value) return { range: null };
	if (!value.startsWith("bytes=") || value.slice(6).includes(","))
		return { invalid: true };

	const [startValue, endValue] = value.slice(6).split("-");
	if (startValue === undefined || endValue === undefined)
		return { invalid: true };

	let start: number;
	let end: number;
	if (startValue === "") {
		const suffixLength = Number(endValue);
		if (!Number.isInteger(suffixLength) || suffixLength <= 0 || size === 0)
			return { invalid: true };
		start = Math.max(size - suffixLength, 0);
		end = size - 1;
	} else {
		start = Number(startValue);
		end = endValue === "" ? size - 1 : Number(endValue);
		if (
			!Number.isInteger(start) ||
			!Number.isInteger(end) ||
			start < 0 ||
			end < start ||
			start >= size
		)
			return { invalid: true };
		end = Math.min(end, size - 1);
	}

	return { range: { start, end } };
}

function commonHeaders(object: R2Object, fileName?: string) {
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("ETag", object.httpEtag);
	headers.set("Accept-Ranges", "bytes");
	headers.set("Cache-Control", "private, no-store, max-age=0");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Referrer-Policy", "no-referrer");
	if (fileName) {
		const safeName = fileName
			.replace(/[^\x20-\x7E]/g, "_")
			.replaceAll('"', "'")
			.replaceAll(/[\r\n]/g, "");
		headers.set(
			"Content-Disposition",
			`attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
		);
	}
	return headers;
}

export async function serveR2Object(
	bucket: R2Bucket,
	key: string,
	request: Request,
	options: { fileName?: string; expectedEtag?: string; public?: boolean } = {},
) {
	const rangeHeader = request.headers.get("Range");
	if (!rangeHeader && !options.expectedEtag && request.method === "GET") {
		const object = await bucket.get(key);
		if (!object) return new Response("Not found", { status: 404 });
		const headers = commonHeaders(object, options.fileName);
		headers.set("Content-Length", object.size.toString());
		if (options.public) headers.set("Cache-Control", "no-store, max-age=0");
		return new Response(object.body, { status: 200, headers });
	}

	const metadata = await bucket.head(key);
	if (!metadata) return new Response("Not found", { status: 404 });
	if (options.expectedEtag && metadata.httpEtag !== options.expectedEtag)
		return new Response("Object changed; create a new transfer", {
			status: 409,
		});

	const parsed = parseByteRange(rangeHeader, metadata.size);
	if ("invalid" in parsed) {
		return new Response(null, {
			status: 416,
			headers: {
				"Content-Range": `bytes */${metadata.size}`,
				"Accept-Ranges": "bytes",
			},
		});
	}

	let range = parsed.range;
	const ifRange = request.headers.get("If-Range");
	if (range && ifRange && ifRange !== metadata.httpEtag) range = null;

	const headers = commonHeaders(metadata, options.fileName);
	const status = range ? 206 : 200;
	const length = range ? range.end - range.start + 1 : metadata.size;
	headers.set("Content-Length", String(length));
	if (range)
		headers.set(
			"Content-Range",
			`bytes ${range.start}-${range.end}/${metadata.size}`,
		);
	if (options.public) headers.set("Cache-Control", "no-store, max-age=0");
	if (request.method === "HEAD") return new Response(null, { status, headers });

	const object = range
		? await bucket.get(key, {
				// @ts-ignore R2 range overload is provided by Workers runtime types.
				range: { offset: range.start, length },
			})
		: await bucket.get(key);
	if (!object) return new Response("Not found", { status: 404 });
	return new Response(object.body, { status, headers });
}
