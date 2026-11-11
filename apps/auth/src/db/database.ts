import * as Cloudflare from "@alchemy.run/cloudflare";
import { RemovalPolicy } from "alchemy";
import { Effect, Option, Path } from "effect";
import { AUTH_MIGRATIONS_DIGEST } from "./migrations-digest.ts";

/**
 * The logical name of the auth D1 resource, the key of its Alchemy state.
 */
export const AUTH_DB_ID = "AuthDb";

/**
 * The file URL of the committed `drizzle-kit` migrations directory.
 */
export const MIGRATIONS_URL = new URL("../../migrations", import.meta.url);

/**
 * The absolute path of the migrations directory, which the D1 resource applies on every deploy.
 * It is absolute because Alchemy resolves a relative path against the process directory, not
 * against this module. The `Path` service decodes the file URL, so a checkout path with a space
 * or another percent-encoded character stays correct.
 */
export const migrationsDir = Path.Path.use((path) => path.fromFileUrl(MIGRATIONS_URL));

/**
 * Report whether the stage keeps its D1 database when the resource is deleted.
 *
 * Only `prod` retains; every other stage removes the database with its resource.
 *
 * @param stage - The decoded stage name.
 * @returns `true` for `prod`.
 */
export const retainsD1 = (stage: string): boolean => stage === "prod";

/**
 * The properties of the auth D1 database for a stage.
 *
 * A non-prod stage names the database `<stack>-auth-db-<stage>-<digest>` explicitly, where
 * `digest` is {@link AUTH_MIGRATIONS_DIGEST}, so a rewritten migrations directory is a
 * create-first replacement. `prod` omits the name (Alchemy generates it), never sets
 * `jurisdiction`, and sets `primaryLocationHint` only from the knob. Every stage applies the
 * `migrations` directory.
 *
 * Changing `name`, `jurisdiction` or `primaryLocationHint` on `prod` replaces the database, which
 * is why the `prod` props are pinned by the tests.
 * Removal is not a prop: {@link retainsD1} feeds `RemovalPolicy.retain` at the declaration.
 *
 * @param stack - The stack name from `resolveStackName`.
 * @param stage - The decoded stage name.
 * @param locationHint - The `D1_PROD_LOCATION_HINT` knob value.
 * @param migrations - The absolute migrations directory from {@link migrationsDir}.
 * @returns The D1 properties.
 */
export const d1Props = (
  stack: string,
  stage: string,
  locationHint: Option.Option<Cloudflare.D1.PrimaryLocationHint>,
  migrations: string,
): Cloudflare.D1.DatabaseProps =>
  stage === "prod"
    ? Option.match(locationHint, {
        onNone: () => ({ migrations }),
        onSome: (primaryLocationHint) => ({ migrations, primaryLocationHint }),
      })
    : { migrations, name: `${stack}-auth-db-${stage}-${AUTH_MIGRATIONS_DIGEST}` };

/**
 * Declare the auth D1 database with the given resource constructor, retained on `prod` only.
 *
 * @param database - The D1 resource constructor; tests substitute one that reports the removal
 *   policy it runs under.
 * @param stack - The stack name from `resolveStackName`.
 * @param stage - The decoded stage name.
 * @param locationHint - The `D1_PROD_LOCATION_HINT` knob value.
 * @returns The database resource effect.
 */
export const declareWith = <A, R>(
  database: (id: string, props: Cloudflare.D1.DatabaseProps) => Effect.Effect<A, never, R>,
  stack: string,
  stage: string,
  locationHint: Option.Option<Cloudflare.D1.PrimaryLocationHint>,
) =>
  migrationsDir.pipe(
    Effect.flatMap((migrations) =>
      database(AUTH_DB_ID, d1Props(stack, stage, locationHint, migrations)).pipe(
        RemovalPolicy.retain(retainsD1(stage)),
      ),
    ),
  );

/**
 * Declare the auth D1 database, retained on `prod` only.
 *
 * @param stack - The stack name from `resolveStackName`.
 * @param stage - The decoded stage name.
 * @param locationHint - The `D1_PROD_LOCATION_HINT` knob value.
 * @returns The database resource effect.
 */
export const declareDatabase = (
  stack: string,
  stage: string,
  locationHint: Option.Option<Cloudflare.D1.PrimaryLocationHint>,
) =>
  declareWith<Cloudflare.D1.Database, Cloudflare.Providers>(
    Cloudflare.D1.Database,
    stack,
    stage,
    locationHint,
  );
