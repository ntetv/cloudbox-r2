import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { decodeObjectKey } from "../../foundation/key-codec";
import {
	accessLockMetadataKey,
	publicAccessBucket,
} from "../../foundation/public-access-lock";
import type { AppContext } from "../../types";

async function removeObjectLock(
	c: AppContext,
	bucketName: string,
	key: string,
) {
	const context = publicAccessBucket(c.env, c.get("config"));
	if (context?.config.binding === bucketName)
		await context.bucket.delete(accessLockMetadataKey(key));
}

export class DeleteObject extends OpenAPIRoute {
	schema = {
		operationId: "post-bucket-delete-object",
		tags: ["Buckets"],
		summary: "Delete an object after a best-effort ETag check",
		request: {
			params: z.object({ bucket: z.string() }),
			body: {
				content: {
					"application/json": {
						schema: z.object({
							key: z.string().describe("base64url encoded file key"),
							etag: z.string(),
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
			key = decodeObjectKey(data.body.key);
		} catch {
			throw new HTTPException(400, { message: "Invalid object key" });
		}

		const object = await bucket.head(key);
		if (!object) {
			await removeObjectLock(c, data.params.bucket, key);
			throw new HTTPException(404, { message: "Object not found" });
		}
		if (object.etag !== data.body.etag) {
			throw new HTTPException(409, {
				message: "Object changed; refresh and retry",
			});
		}

		await bucket.delete(key);
		await removeObjectLock(c, data.params.bucket, key);
		return { success: true };
	}
}
