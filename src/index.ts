import {
	AdminLoginRateLimiter,
	AdminLoginSourceRateLimiter,
	AdminSessionStore,
	CloudboxR2,
	PublicAccessRateLimiter,
	TransferRegistry,
	TransferStore,
} from "../packages/worker/src/index";

export {
	AdminLoginRateLimiter,
	AdminLoginSourceRateLimiter,
	AdminSessionStore,
	PublicAccessRateLimiter,
	TransferRegistry,
	TransferStore,
};

export default CloudboxR2({
	readonly: false,
	publicBucket: { binding: "BUCKET" },
});
