import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { decodeObjectKey } from "../../foundation/key-codec";
import { serveR2Object } from "../../foundation/range";
import type { AppContext } from "../../types";

export class GetObject extends OpenAPIRoute {
	schema = {
		operationId: "get-bucket-object",
		tags: ["Buckets"],
		summary: "Get Object",
		request: {
			params: z.object({
				bucket: z.string(),
				key: z.string().describe("base64 encoded file key"),
			}),
		},
		responses: {
			"200": {
				description: "File binary",
				schema: z.string().openapi({ format: "binary" }),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();

		const bucketName = data.params.bucket;
		const bucket = c.env[bucketName] as R2Bucket | undefined;

		if (!bucket) {
			throw new HTTPException(500, {
				message: `Bucket binding not found: ${bucketName}`,
			});
		}

		let filePath: string;
		try {
			filePath = decodeObjectKey(data.params.key);
		} catch {
			throw new HTTPException(400, { message: "Invalid object key" });
		}

		if (!c.req.header("Range") && c.req.method === "GET") {
			const object = await bucket.get(filePath);
			if (!object)
				return Response.json({ msg: "Object Not Found" }, { status: 404 });
			const headers = new Headers();
			object.writeHttpMetadata(headers);
			headers.set("etag", object.httpEtag);
			headers.set("content-length", object.size.toString());
			headers.set("Content-Type", "application/octet-stream");
			headers.set("Cache-Control", "private, no-store, max-age=0");
			headers.set("X-Content-Type-Options", "nosniff");
			const fileName = filePath.split("/").pop() || "download";
			const asciiFileName = fileName
				.replace(/[^\x20-\x7E]/g, "_")
				.replace(/"/g, "'");
			headers.set(
				"Content-Disposition",
				`attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
			);
			return new Response(object.body, { headers });
		}

		return serveR2Object(bucket, filePath, c.req.raw, {
			fileName: filePath.split("/").pop() || "download",
		});
	}
}
