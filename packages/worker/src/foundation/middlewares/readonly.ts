import type { Next } from "hono";
import type { AppContext } from "../../types";

export async function readOnlyMiddleware(c: AppContext, next: Next) {
	const config = c.get("config");

	const createsReadOnlyDownloadToken =
		c.req.method === "POST" && c.req.path.endsWith("/transfers/download");
	if (
		config.readonly === true &&
		!["GET", "HEAD"].includes(c.req.method) &&
		!createsReadOnlyDownloadToken
	) {
		return Response.json(
			{
				success: false,
				errors: [
					{
						code: 10005,
						message:
							"This instance is in ReadOnly Mode, no changes are allowed!",
					},
				],
			},
			{ status: 401 },
		);
	}

	await next();
}
