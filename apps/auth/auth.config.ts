import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { betterAuth } from "better-auth";
import { authOptions } from "./src/auth.ts";
import * as schema from "./src/db/schema.ts";

/**
 * The Better Auth instance the CLI reads to generate `src/db/schema.ts`.
 *
 * It shares {@link authOptions} with the Worker and uses an adapter with no live binding: the
 * generator inspects the options, plugins and schema, and never queries. The CLI loads this export
 * by name; no module imports it.
 *
 * @public
 */
export const auth = betterAuth({
  ...authOptions,
  database: drizzleAdapter({}, { provider: "sqlite", schema, transaction: false }),
});
