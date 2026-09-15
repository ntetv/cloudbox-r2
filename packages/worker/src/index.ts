import {
	type OpenAPIObjectConfigV31,
	extendZodWithOpenApi,
	fromHono,
} from "chanfana";
import { type ExecutionContext, Hono } from "hono";
import { z } from "zod";
import { readOnlyMiddleware } from "./foundation/middlewares/readonly";
import {
	normalizeAdminPath,
	normalizePublicBucket,
} from "./foundation/public-access";
import { login, logout, requireAdminSession } from "./foundation/session";
import { settings } from "./foundation/settings";
import { CopyObject } from "./modules/buckets/copyObject";
import { CreateFolder } from "./modules/buckets/createFolder";
import { DeleteObject } from "./modules/buckets/deleteObject";
import { GetObject } from "./modules/buckets/getObject";
import { HeadObject } from "./modules/buckets/headObject";
import { ListObjects } from "./modules/buckets/listObjects";
import { PutMetadata } from "./modules/buckets/putMetadata";
import { dashboardIndex, dashboardRedirect } from "./modules/dashboard";
import {
	getPublicFile,
	getPublicFolder,
	unlockPublicFile,
	unlockPublicFolder,
} from "./modules/public-access";
import {
	DeletePublicAccessLock,
	GetPublicAccessLock,
	PutPublicAccessLock,
} from "./modules/public-access-lock";
import {
	downloadPublicFile as downloadPublicFileApi,
	listPublicFiles,
} from "./modules/public-files";
import { GetInfo } from "./modules/server/getInfo";
import {
	cancelUploadTransfer,
	cleanupTransferCache,
	completeUploadTransfer,
	createDownloadTransfer,
	createUploadTransfer,
	downloadTransfer,
	getTransferCache,
	getTransferStatus,
	resumeUploadTransfer,
	transferPath,
	uploadTransferBody,
	uploadTransferPart,
} from "./modules/transfers";
import type { AppEnv, AppVariables, CloudboxR2Config } from "./types";

export { AdminSessionStore } from "./foundation/admin-session-store";
export { AdminLoginRateLimiter } from "./foundation/admin-login-rate-limiter";
export { AdminLoginSourceRateLimiter } from "./foundation/admin-login-source-rate-limiter";
export { PublicAccessRateLimiter } from "./foundation/public-access-rate-limiter";
export { TransferStore } from "./foundation/transfer-store";
export { TransferRegistry } from "./foundation/transfer-registry";
export type { CloudboxR2Config } from "./types";

function createApp(config: CloudboxR2Config, adminPath: string) {
	const runtimeConfig = { ...config, adminPath };
	const adminApiPath = `${adminPath}/api`;

	const openapiSchema: OpenAPIObjectConfigV31 = {
		openapi: "3.1.0",
		info: {
			title: "cloudbox-r2 API",
			version: settings.version,
		},
	};

	const app = new Hono<{ Bindings: AppEnv; Variables: AppVariables }>();
	app.use("*", async (c, next) => {
		c.set("config", runtimeConfig);
		await next();
	});

	const openapi = fromHono(app, {
		schema: openapiSchema,
		docs_url: null,
		redoc_url: null,
		openapi_url: null,
		raiseUnknownParameters: true,
		generateOperationIds: false,
	});

	app.use(`${adminApiPath}/*`, async (c, next) => {
		if (
			c.req.path === `${adminApiPath}/auth/session` &&
			c.req.method === "POST"
		)
			return next();
		return requireAdminSession(c, next);
	});

	if (config.readonly === true) {
		app.use(`${adminApiPath}/*`, async (c, next) => {
			if (c.req.path === `${adminApiPath}/auth/session`) return next();
			return readOnlyMiddleware(c, next);
		});
	}

	app.get("/api/public/files", listPublicFiles);
	app.get("/api/public/files/:key", downloadPublicFileApi);

	app.post(`${adminApiPath}/auth/session`, login);
	app.delete(`${adminApiPath}/auth/session`, logout);
	app.post(`${adminApiPath}/transfers/download`, createDownloadTransfer);
	app.post(`${adminApiPath}/transfers/upload`, createUploadTransfer);
	app.post(`${adminApiPath}/transfers/upload/resume`, resumeUploadTransfer);
	app.get(`${adminApiPath}/transfers/cache`, getTransferCache);
	app.post(`${adminApiPath}/transfers/cache/cleanup`, cleanupTransferCache);

	openapi.get(`${adminApiPath}/server/config`, GetInfo);

	openapi.get(`${adminApiPath}/buckets/:bucket`, ListObjects);
	openapi.post(`${adminApiPath}/buckets/:bucket/copy`, CopyObject);
	openapi.post(`${adminApiPath}/buckets/:bucket/folder`, CreateFolder);
	openapi.post(`${adminApiPath}/buckets/:bucket/delete`, DeleteObject);
	openapi.on("head", `${adminApiPath}/buckets/:bucket/:key`, HeadObject);
	openapi.get(`${adminApiPath}/buckets/:bucket/:key/head`, HeadObject);

	openapi.get(`${adminApiPath}/public-access/:key`, GetPublicAccessLock);
	openapi.put(`${adminApiPath}/public-access/:key`, PutPublicAccessLock);
	openapi.delete(`${adminApiPath}/public-access/:key`, DeletePublicAccessLock);

	app.on(["GET", "HEAD"], transferPath("download"), downloadTransfer);
	app.get(transferPath("upload"), getTransferStatus);
	app.put(transferPath("upload/body"), uploadTransferBody);
	app.put(transferPath("upload/:partNumber"), uploadTransferPart);
	app.post(transferPath("upload/complete"), completeUploadTransfer);
	app.delete(transferPath("upload"), cancelUploadTransfer);

	openapi.get(`${adminApiPath}/buckets/:bucket/:key`, GetObject);
	openapi.post(`${adminApiPath}/buckets/:bucket/:key`, PutMetadata);

	app.get("/public/file/:key", getPublicFile);
	app.post("/public/file/:key/unlock", unlockPublicFile);
	app.get("/public/folder/:key", getPublicFolder);
	app.post("/public/folder/:key/unlock", unlockPublicFolder);

	app.get("/", dashboardIndex);
	app.get("*", dashboardRedirect);
	app.all("*", () =>
		Response.json({ msg: "404, not found!" }, { status: 404 }),
	);

	return app;
}

export function CloudboxR2(config?: CloudboxR2Config) {
	extendZodWithOpenApi(z);
	const normalizedConfig = { ...(config || {}) };
	let configuredAdminPath: string | undefined;
	let app: ReturnType<typeof createApp> | undefined;
	if (normalizedConfig.readonly !== false) normalizedConfig.readonly = true;
	normalizedConfig.publicBucket = normalizePublicBucket(
		normalizedConfig.publicBucket,
	);

	return {
		async fetch(request: Request, env: unknown, context: ExecutionContext) {
			let adminPath: string;
			try {
				adminPath = normalizeAdminPath((env as AppEnv).CLOUDBOX_R2_ADMIN_PATH);
			} catch {
				return new Response("Cloudbox R2 configuration unavailable", {
					status: 503,
					headers: { "Cache-Control": "no-store" },
				});
			}
			if (!app || configuredAdminPath !== adminPath) {
				app = createApp(normalizedConfig, adminPath);
				configuredAdminPath = adminPath;
			}
			return app.fetch(request, env as AppEnv, context);
		},
	};
}
