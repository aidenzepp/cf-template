import { AUTH_BASE_PATH } from "@workspace/contract/domain/auth-paths";
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

/**
 * The one browser auth client. Every call resolves against the page's own origin and goes through
 * the `/auth/*` forward of `web`. The passkey plugin adds `signIn.passkey`.
 */
export const authClient = createAuthClient({
  basePath: AUTH_BASE_PATH,
  plugins: [passkeyClient()],
});
