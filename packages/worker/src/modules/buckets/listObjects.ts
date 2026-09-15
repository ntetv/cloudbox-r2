import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { decodeObjectKey } from "../../foundation/key-codec";
import {
	findAccessLock,
	publicAccessBucket,
} from "../../foundation/public-access-lock";
import type { AppContext } from "../../types";

function isInternalKey(key: string) {
	return key === ".cloudbox-r2" || key.startsWith(".cloudbox-r2/");
}

export class ListObjects extends OpenAPIRoute {
	schema = {
		operationId: "get-bucket-list-objects",
		tags: ["Buckets"],
		summary: "List objects",
		request: {
			params: z.object({
				bucket: z.string(),
			}),
			query: z.object({
				limit: z.number().optional(),
				prefix: z
					.string()
					.nullable()
					.optional()
					.describe("base64 encoded prefix"),
				cursor: z.string().nullable().optional(),
				delimiter: z.string().nullable().optional(),
				startAfter: z.string().nullable().optional(),
				include: z.enum(["httpMetadata", "customMetadata"]).array().optional(),
				includeAccessLocks: z.enum(["true", "false"]).optional(),
			}),
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

		let prefix: string | undefined;
		try {
			prefix = data.query.prefix
				? decodeObjectKey(data.query.prefix)
				: undefined;
		} catch {
			throw new HTTPException(400, { message: "Invalid object prefix" });
		}

		const result = await bucket.list({
			limit: data.query.limit,
			prefix,
			cursor: data.query.cursor,
			startAfter: data.query.startAfter,
			delimiter: data.query.delimiter || "",
			// @ts-ignore
			include: data.query.include,
		});
		const visibleResult = {
			...result,
			objects: result.objects.filter((object) => !isInternalKey(object.key)),
			delimitedPrefixes: result.delimitedPrefixes.filter(
				(key) => !isInternalKey(key),
			),
		};

		if (
			data.query.includeAccessLocks !== "true" ||
			publicAccessBucket(c.env, c.get("config"))?.config.binding !== bucketName
		)
			return visibleResult;

		const keys = [
			...visibleResult.objects.map((object) => object.key),
			...visibleResult.delimitedPrefixes,
		];
		const accessLocks: Record<
			string,
			{ locked: boolean; target?: string; scope?: "file" | "folder" }
		> = {};
		await Promise.all(
			keys.map(async (key) => {
				const lock = await findAccessLock(bucket, key);
				accessLocks[key] = lock
					? {
							locked: true,
							target: lock.metadata.target,
							scope: lock.metadata.scope,
						}
					: { locked: false };
			}),
		);

		return { ...visibleResult, accessLocks };
	}
}
