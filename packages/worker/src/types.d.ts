import type { Context } from "hono";

export type PublicBucketConfig = {
	binding: string;
	prefix?: string;
};

export type CloudboxR2Config = {
	readonly?: boolean;
	publicBucket?: PublicBucketConfig;
};

export type PublicAccessLockMetadata = {
	schemaVersion: 1;
	target: string;
	scope: "file" | "folder";
	password: {
		salt: string;
		hash: string;
		iterations: number;
	};
	authVersion: string;
	createdAt: number;
	updatedAt: number;
};

export type AppEnv = {
	ASSETS?: Fetcher;
	ADMIN_USERNAME?: string;
	ADMIN_PASSWORD?: string;
	ADMIN_SESSION_SECRET?: string;
	PUBLIC_ACCESS_SESSION_SECRET?: string;
	PUBLIC_ACCESS_PASSWORD_PEPPER?: string;
	TRANSFER_SESSION_SECRET?: string;
	CLOUDBOX_R2_ADMIN_PATH?: string;
	ADMIN_LOGIN_RATE_LIMITER?: DurableObjectNamespace;
	ADMIN_LOGIN_SOURCE_RATE_LIMITER?: DurableObjectNamespace;
	PUBLIC_ACCESS_RATE_LIMITER?: DurableObjectNamespace;
	ADMIN_SESSION_STORE?: DurableObjectNamespace;
	TRANSFER_STORE?: DurableObjectNamespace;
	TRANSFER_REGISTRY?: DurableObjectNamespace;
	[key: string]:
		| R2Bucket
		| Fetcher
		| DurableObjectNamespace
		| string
		| undefined;
};
export type AppVariables = {
	config: CloudboxR2Config & { adminPath: string };
	authentication_type?: "session";
	authentication_username?: string;
	authentication_session_id?: string;
	authentication_session_expires_at?: number;
};
export type AppContext = Context<{ Bindings: AppEnv; Variables: AppVariables }>;
