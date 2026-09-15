import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { decodeObjectKey } from "../../foundation/key-codec";
import type { AppContext } from "../../types";

export class PutMetadata extends OpenAPIRoute {
	schema = {
		operationId: "post-bucket-put-object-metadata",
		tags: ["Buckets"],
		summary: "Update object metadata without replacing a newer object version",
		request: {
			params: z.object({
				bucket: z.string(),
				key: z.string().describe("base64url encoded file key"),
			}),
			body: {
				content: {
					"application/json": {
						schema: z.object({
							etag: z.string(),
							customMetadata: z.record(z.string(), z.any()),
							httpMetadata: z.record(z.string(), z.any()),
						}),
					},
				},
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const bucket = c.env[data.params.bucket] as R2Bucket | undefined;
		if (!bucket)
			throw new HTTPException(500, { message: "Bucket binding not found" });

		let key: string;
		try {
			key = decodeObjectKey(data.params.key);
		} catch {
			throw new HTTPException(400, { message: "Invalid object key" });
		}

		const object = await bucket.get(key);
		if (!object) throw new HTTPException(404, { message: "Object not found" });
		if (object.etag !== data.body.etag) {
			await object.body.cancel();
			throw new HTTPException(409, {
				message: "Object changed; refresh and retry",
			});
		}

		const updated = await bucket.put(key, object.body, {
			customMetadata: data.body.customMetadata,
			httpMetadata: data.body.httpMetadata,
			onlyIf: { etagMatches: object.etag },
		});
		if (!updated)
			throw new HTTPException(409, {
				message: "Object changed; refresh and retry",
			});
		return updated;
	}
}
