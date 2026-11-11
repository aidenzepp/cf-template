import { BetterAuth, Database } from "@alchemy.run/better-auth";
import { WorkerEnvironment } from "@alchemy.run/cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import type { RuntimeContext } from "alchemy";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { Config, ConfigProvider, Context, Effect, Layer, Predicate } from "effect";
import { makeDatabase } from "@workspace/db/database";
import type { RawDatabase } from "@workspace/db/database";
import { AUTH_PASSWORD_SCRYPT } from "@workspace/config/auth-password";
import type { ScryptCost } from "@workspace/config/auth-password";
import { PublicOrigin } from "@workspace/config/public-origin";
import { CookieCacheMaxAgeKnob, CookieCacheStrategyKnob } from "./config.ts";
import { AUTH_BASE_PATH } from "./contract.ts";
import * as schema from "./db/schema.ts";
import { passwordFor, rehashAfterSignIn } from "./password.ts";
import type { RunEffect } from "./password.ts";

/**
 * The email and password options and the rehash plugin for one scrypt cost: the PHC-style hasher
 * and, registered through a plugin-level `hooks.after` on `/sign-in/email`, the rehash of a stored
 * hash whose cost differs from `params`.
 *
 * @param params - The cost of every new hash.
 * @param run - Runs an effect with the services the hasher logs and traces under.
 * @returns The `emailAndPassword` and `plugins` options.
 */
const passwordOptions = (params: ScryptCost, run: RunEffect) => ({
  emailAndPassword: { enabled: true, password: passwordFor(params, run) },
  plugins: [rehashAfterSignIn(params, run)],
});

/**
 * The Better Auth options that do not depend on the deployment: the base path, email and password
 * sign-in with the scrypt hasher at its default cost, and the session cookie cache at its default.
 *
 * The Worker and `auth.config.ts` (the CLI's schema generator) share this one object. The Worker
 * overrides `session.cookieCache` with the deployed knob values; the cache never changes the
 * schema. Later issues add the hasher, the hooks and the providers here.
 */
export const authOptions = {
  basePath: AUTH_BASE_PATH,
  ...passwordOptions(AUTH_PASSWORD_SCRYPT.default, Effect.runPromise),
  session: {
    cookieCache: {
      enabled: true,
      maxAge: CookieCacheMaxAgeKnob.default,
      strategy: CookieCacheStrategyKnob.default,
    },
  },
} as const;

/**
 * The callback of `then`: settles the Promise the view hands to `await`.
 */
type Settle = (value: Settled) => Settled;

/**
 * What a settled Promise carries onward, a row, a list of rows or a count; the view never reads it.
 */
type Settled =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | readonly Settled[]
  | { readonly [column: string]: Settled };

/**
 * Runs an Effect that needs no services and settles with its value.
 */
type RunPromise = (effect: Effect.Effect<Settled, Settled>) => Promise<Settled>;

/**
 * Report whether a builder is an Effect. The view only meets Effects built over a database whose
 * client is already provided, so none has a requirement.
 *
 * @param member - The database or a builder.
 * @returns `true` for an Effect.
 */
const isRunnable = <T extends object>(member: T): member is T & Effect.Effect<Settled, Settled> =>
  Effect.isEffect(member);

/**
 * Report whether a member is a method of the database or of a builder.
 *
 * @param member - A member read by name.
 * @returns `true` for a function.
 */
const isMethod = (member: unknown): member is (...args: Settled[]) => Settled =>
  Predicate.isFunction(member);

/**
 * Report whether a member is an object whose members the view must wrap in turn.
 *
 * @param member - A member read by name.
 * @returns `true` for an object that is not a function.
 */
const isNested = (member: unknown): member is object => Predicate.isObject(member);

/**
 * Wrap a Drizzle `effect-d1` database so Better Auth can await it.
 *
 * Better Auth's Drizzle adapter awaits query builders. Each builder of the `effect-d1` database is
 * an Effect, so the view answers `then` on an Effect by running it with `runPromise`, and wraps
 * every object or method result so the next builder in a chain is intercepted the same way. The
 * view is module-private: it is the one seam where an Effect becomes a Promise, and `runPromise`
 * is `Effect.runPromiseWith` over the services captured at construction, so spans parent to the
 * request that built the view. The adapter runs with `transaction: false` and never reaches
 * `db.transaction`, which D1 cannot serve.
 *
 * @param target - The `effect-d1` database, or one of its builders.
 * @param runPromise - Runs an Effect with the captured services.
 * @returns A proxy that behaves as a Promise-returning database.
 */
const promiseView = <T extends object>(target: T, runPromise: RunPromise): T =>
  new Proxy(target, {
    get: (source, key) => {
      if (key === "then" && isRunnable(source)) {
        return (onFulfilled: Settle, onRejected: Settle) =>
          runPromise(source).then(onFulfilled, onRejected);
      }

      const member: unknown = Predicate.hasProperty(source, key) ? source[key] : undefined;

      if (isMethod(member)) {
        return (...args: Settled[]) => {
          const result = member.apply(source, args);

          return isNested(result) ? promiseView(result, runPromise) : result;
        };
      }

      return isNested(member) ? promiseView(member, runPromise) : member;
    },
  });

/**
 * The options the Drizzle adapter runs with. `transaction: false` is the adapter default, written
 * out because D1 has no interactive transactions: the adapter then issues its writes one at a time
 * and never calls `db.transaction`.
 */
export const adapterOptions = {
  provider: "sqlite",
  schema,
  transaction: false,
} as const;

/**
 * The Better Auth `database` input for one execution: the Drizzle adapter over the promise view of
 * `makeDatabase`'s `{ db }` for the raw `AuthDb` binding.
 *
 * The function is untraced on purpose: the captured services carry the current span, and a span of
 * its own would become the parent of every SQL span in place of the request's.
 *
 * `transaction: false` is the adapter default, written out because D1 has no interactive
 * transactions: the adapter then issues its writes one at a time and never calls
 * `db.transaction`.
 */
const adapterFor = Effect.fnUntraced(function* adapterFor(binding: RawDatabase) {
  const access = yield* makeDatabase(binding);
  const { db } = yield* access;
  const services = yield* Effect.context();

  return drizzleAdapter(promiseView(db, Effect.runPromiseWith(services)), adapterOptions);
});

/**
 * Provide `BetterAuth.Database` from the raw `AuthDb` binding.
 *
 * Alchemy's `BetterAuth` evaluates `runtime` once per execution on the execution scope, so the
 * `D1Client` and its prepared-statement cache close with the request. `migrate` is absent: the
 * schema is applied by the D1 resource's `migrations`, never by Better Auth.
 *
 * @param raw - The effect that reads the raw `D1Database` binding, as
 *   `Cloudflare.D1.QueryDatabase(...).raw` does.
 * @returns A layer providing `BetterAuth.Database`.
 */
export const authDatabaseLayer = (
  raw: Effect.Effect<RawDatabase, never, RuntimeContext>,
): Layer.Layer<Database> =>
  Layer.succeed(
    Database,
    Database.of({
      provider: "sqlite",
      runtime: raw.pipe(Effect.flatMap(adapterFor), Effect.orDie),
    }),
  );

/**
 * The deployment values that shape the Better Auth instance.
 *
 * They are read from the Worker's own bindings when an execution starts, never through the
 * deployer's `Config` while the stack plans: Alchemy resolves a `Config` read in Worker init
 * against the deployer's environment and binds that value over the one `infra` binds per stage. An
 * unset value therefore fails that execution's requests and nothing else.
 */
export const AuthSettings = Config.all({
  baseURL: Config.schema(PublicOrigin, "PUBLIC_ORIGIN"),
  maxAge: CookieCacheMaxAgeKnob.config,
  scrypt: AUTH_PASSWORD_SCRYPT.config,
  secret: Config.Redacted("BETTER_AUTH_SECRET"),
  strategy: CookieCacheStrategyKnob.config,
});

/**
 * Construct the Better Auth instance of one execution from the Worker's bindings.
 *
 * Both consumers read it: `fetch` for `/auth/*` and `checkSession`. `migrate: false` leaves the
 * schema to the D1 resource's `migrations`.
 */
const makeInstance = Effect.gen(function* makeInstance() {
  const env = yield* WorkerEnvironment;

  const settings = yield* AuthSettings.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

  const services = yield* Effect.context();

  return yield* BetterAuth({
    ...authOptions,
    ...passwordOptions(settings.scrypt, Effect.runPromiseWith(services)),
    baseURL: settings.baseURL,
    migrate: false,
    secret: Effect.succeed(settings.secret),
    session: {
      cookieCache: { enabled: true, maxAge: settings.maxAge, strategy: settings.strategy },
    },
  });
});

/**
 * The Better Auth instance of the `auth` Worker.
 */
export type AuthInstance = Effect.Success<typeof makeInstance>;

/**
 * The service that yields the Better Auth instance of the current execution, for the Worker's
 * `fetch` and `checkSession`.
 */
export class AuthService extends Context.Service<AuthService, Effect.Effect<AuthInstance>>()(
  "@workspace/auth/AuthService",
) {
  /**
   * Build the accessor at Worker initialization without reading any setting. The instance is built
   * on first use in an execution and shared by the rest of it; a missing or invalid binding is a
   * defect of that execution.
   */
  static readonly layer = Layer.effect(
    AuthService,
    Effect.gen(function* buildAccessor() {
      const context = yield* Effect.context<Database | WorkerEnvironment>();

      return yield* makeExecutionMemo(
        makeInstance.pipe(Effect.provideContext(context), Effect.orDie),
      );
    }),
  );
}
