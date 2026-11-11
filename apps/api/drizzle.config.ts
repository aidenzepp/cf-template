import { defineConfig } from "drizzle-kit";

/**
 * The `drizzle-kit` configuration that writes `migrations/` from the app schema.
 */
export default defineConfig({
  dialect: "sqlite",
  out: "./migrations",
  schema: "./src/db/schema.ts",
});
