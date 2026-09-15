import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { decodeObjectKey } from "../../foundation/key-codec";
import type { AppContext } from "../../types";

export class CreateFolder extends OpenAPIRoute {
	schema = {
		operationId: "post-bucket-create-folder",
		tags: ["Buckets"],
		summary: "Create folder",
		request: {
			params: z.object({ bucket: z.string() }),
			body: {
				content: {
					"application/json": {
						schema: z.object({
							key: z.string().describe("base64url encoded folder key"),
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
			throw new HTTPException(400, { message: "Invalid folder key" });
		}
		const folderKey = key.endsWith("/") ? key : `${key}/`;
		if (!folderKey || folderKey.startsWith(".cloudbox-r2/")) {
			throw new HTTPException(400, { message: "Reserved folder key" });
		}

		const created = await bucket.put(folderKey, "", {
			onlyIf: { etagDoesNotMatch: "*" },
		});
		if (!created)
			throw new HTTPException(409, { message: "Folder already exists" });
		return created;
	}
}
