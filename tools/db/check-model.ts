import type { Config, Effect, FileSystem, Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";

/**
 * The databases that own migrations. Each `config` is the `drizzle-kit` configuration that writes
 * the database's `migrations/` directory from its schema.
 */
export const databases = [
  { config: "apps/api/drizzle.config.ts", name: "apps/api" },
  { config: "apps/auth/drizzle.config.ts", name: "apps/auth" },
] as const;

/**
 * One problem a check found: the file or database it concerns and the reason.
 */
export interface Finding {
  readonly reason: string;
  readonly subject: string;
}

/**
 * Where a run happens: the tree being checked and the `drizzle-kit` binary that checks it.
 * `authSchema` is the text the Better Auth CLI generates, when the caller already ran it.
 */
export interface Context {
  readonly authSchema: string | undefined;
  readonly base: string | undefined;
  readonly kit: string;
  readonly root: string;
}

/**
 * A named check over one database. P2 and P3 add checks by appending to `checks`.
 */
export interface Check {
  readonly name: string;
  readonly run: (
    context: Context,
    database: (typeof databases)[number],
  ) => Effect.Effect<
    ReadonlyArray<Finding>,
    | Config.ConfigError
    | Effect.Error<ReturnType<FileSystem.FileSystem["stat"]>>
    | Schema.SchemaError,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >;
}
