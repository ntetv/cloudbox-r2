import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { decodeObjectKey } from "../../foundation/key-codec";
import type { AppContext } from "../../types";

export class CopyObject extends OpenAPIRoute {
	schema = {
		operationId: "post-bucket-copy-object",
		tags: ["Buckets"],
		summary: "Copy object without overwriting an existing destination",
		request: {
			params: z.object({ bucket: z.string() }),
			body: {
				content: {
					"application/json": {
						schema: z.object({
							sourceKey: z
								.string()
								.describe("base64url encoded source file key"),
							destinationKey: z
								.string()
								.describe("base64url encoded destination file key"),
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

		let sourceKey: string;
		let destinationKey: string;
		try {
			sourceKey = decodeObjectKey(data.body.sourceKey);
			destinationKey = decodeObjectKey(data.body.destinationKey);
		} catch {
			throw new HTTPException(400, { message: "Invalid object key" });
		}
		if (sourceKey === destinationKey) {
			throw new HTTPException(400, {
				message: "Source and destination must differ",
			});
		}

		const object = await bucket.get(sourceKey);
		if (!object)
			throw new HTTPException(404, { message: "Source object not found" });

		const copied = await bucket.put(destinationKey, object.body, {
			customMetadata: object.customMetadata,
			httpMetadata: object.httpMetadata,
			onlyIf: { etagDoesNotMatch: "*" },
		});
		if (!copied)
			throw new HTTPException(409, { message: "Destination already exists" });

		return copied;
	}
}
