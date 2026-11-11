import * as Cloudflare from "@alchemy.run/cloudflare";
import { RemovalPolicy } from "alchemy";
import type { Effect } from "effect";
import { Option } from "effect";

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
 * The properties of the app D1 database for a stage.
 *
 * A non-prod stage names the database `<stack>-app-<stage>` explicitly, so a rewrite is a
 * create-first replacement. `prod` omits the name (Alchemy generates it), never sets
 * `jurisdiction`, and sets `primaryLocationHint` only from the knob.
 *
 * Changing `name`, `jurisdiction` or `primaryLocationHint` on `prod` replaces the database, which
 * is why the `prod` props are pinned by the tests. `migrations` is added by a later block.
 * Removal is not a prop: {@link retainsD1} feeds `RemovalPolicy.retain` at the declaration.
 *
 * @param stack - The stack name from `resolveStackName`.
 * @param stage - The decoded stage name.
 * @param locationHint - The `D1_PROD_LOCATION_HINT` knob value.
 * @returns The D1 properties.
 */
export const d1Props = (
  stack: string,
  stage: string,
  locationHint: Option.Option<Cloudflare.D1.PrimaryLocationHint>,
): Cloudflare.D1.DatabaseProps =>
  stage === "prod"
    ? Option.match(locationHint, {
        onNone: () => ({}),
        onSome: (primaryLocationHint) => ({ primaryLocationHint }),
      })
    : { name: `${stack}-app-${stage}` };

/**
 * Declare the api D1 database with the given resource constructor, retained on `prod` only.
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
  database("AppDb", d1Props(stack, stage, locationHint)).pipe(
    RemovalPolicy.retain(retainsD1(stage)),
  );

/**
 * Declare the api D1 database, retained on `prod` only.
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
