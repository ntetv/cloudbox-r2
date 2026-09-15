import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { decodeObjectKey } from "../foundation/key-codec";
import {
	getAccessLockStatus,
	isValidAccessTarget,
	publicAccessBucket,
	publicTargetExists,
	removeAccessLock,
	setAccessLock,
} from "../foundation/public-access-lock";
import type { AppContext } from "../types";

function getPublicAccessContext(c: AppContext) {
	const context = publicAccessBucket(c.env, c.get("config"));
	if (!context)
		throw new HTTPException(404, { message: "Public access unavailable" });
	return context;
}

function decodeTarget(encoded: string) {
	try {
		return decodeObjectKey(encoded);
	} catch {
		throw new HTTPException(400, { message: "Invalid public access target" });
	}
}

export class GetPublicAccessLock extends OpenAPIRoute {
	schema = {
		operationId: "get-public-access-lock",
		tags: ["Public access"],
		summary: "Get public access lock status",
		request: { params: z.object({ key: z.string() }) },
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const context = getPublicAccessContext(c);
		const target = decodeTarget(data.params.key);
		if (
			!target ||
			!isValidAccessTarget(target, context.config) ||
			!(await publicTargetExists(context.bucket, target))
		)
			throw new HTTPException(404, { message: "Public access unavailable" });
		return getAccessLockStatus(context.bucket, target);
	}
}

export class PutPublicAccessLock extends OpenAPIRoute {
	schema = {
		operationId: "put-public-access-lock",
		tags: ["Public access"],
		summary: "Set public access lock",
		request: {
			params: z.object({ key: z.string() }),
			body: {
				content: {
					"application/json": {
						schema: z.object({ password: z.string() }),
					},
				},
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const context = getPublicAccessContext(c);
		const target = decodeTarget(data.params.key);
		try {
			return await setAccessLock(
				context.bucket,
				target,
				data.body.password,
				context.config,
				c.env,
			);
		} catch (error) {
			if (error instanceof Error && error.message.includes("not found"))
				throw new HTTPException(404, {
					message: "Public access target not found",
				});
			if (error instanceof Error && error.message.includes("Overlapping"))
				throw new HTTPException(409, {
					message: "Overlapping public access lock",
				});
			if (error instanceof Error && error.message.includes("Invalid"))
				throw new HTTPException(400, { message: error.message });
			throw error;
		}
	}
}

export class DeletePublicAccessLock extends OpenAPIRoute {
	schema = {
		operationId: "delete-public-access-lock",
		tags: ["Public access"],
		summary: "Remove public access lock",
		request: { params: z.object({ key: z.string() }) },
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const context = getPublicAccessContext(c);
		const target = decodeTarget(data.params.key);
		try {
			return await removeAccessLock(context.bucket, target, context.config);
		} catch (error) {
			if (error instanceof Error && error.message.includes("Invalid"))
				throw new HTTPException(400, { message: error.message });
			throw error;
		}
	}
}
