import { AUTH_BASE_PATH } from "@workspace/contract/domain/auth-paths";
import { createAuthClient } from "better-auth/react";

/**
 * The one browser auth client. Every call resolves against the page's own origin and goes through
 * the `/auth/*` forward of `web`.
 */
export const authClient = createAuthClient({ basePath: AUTH_BASE_PATH });
