import {
	AdminLoginRateLimiter,
	AdminLoginSourceRateLimiter,
	AdminSessionStore,
	CloudboxR2,
	PublicAccessRateLimiter,
	TransferRegistry,
	TransferStore,
} from "cloudbox-r2";

export {
	AdminLoginRateLimiter,
	AdminLoginSourceRateLimiter,
	AdminSessionStore,
	PublicAccessRateLimiter,
	TransferRegistry,
	TransferStore,
};

// Store CLOUDBOX_R2_ADMIN_PATH, ADMIN_USERNAME, ADMIN_PASSWORD,
// ADMIN_SESSION_SECRET, PUBLIC_ACCESS_SESSION_SECRET,
// PUBLIC_ACCESS_PASSWORD_PEPPER, and TRANSFER_SESSION_SECRET as Worker secrets.
// Never put credentials in this source file or in wrangler vars.
export default CloudboxR2({
	readonly: false,
	publicBucket: { binding: "BUCKET" },
});
