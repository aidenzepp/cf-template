import { RuntimeContext } from "alchemy";
import type { BaseRuntimeContext } from "alchemy";
import { WorkerEnvironment } from "@alchemy.run/cloudflare";
import { BunServices } from "@effect/platform-bun";
import { Array as Arr, Context, Effect, FileSystem, Layer, Order, Path } from "effect";
import { Miniflare } from "miniflare";
import { Mailer } from "@workspace/config/mailer";
import type { RawDatabase } from "@workspace/db/database";
import { AuthService, authDatabaseLayer } from "./auth.ts";
import { CheckSession } from "./session.ts";

/**
 * The public origin the test instance signs cookies for.
 */
const ORIGIN = "http://localhost:3000";

/**
 * The `EMAIL_KEY_SECRET` the test instance binds.
 */
export const TEST_EMAIL_KEY_SECRET = "test-email-key-secret-0123456789abcdef";

/**
 * The marker `drizzle-kit` writes between the statements of one migration file.
 */
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/**
 * The Worker's bindings as `infra` binds them for a stage, supplied as the `WorkerEnvironment` so
 * the tests never touch the host environment.
 *
 * @param overrides - Bindings that replace the defaults.
 * @returns A layer that provides the bindings.
 */
const settings = (overrides: Readonly<Record<string, string | undefined>> = {}) =>
  Layer.succeed(WorkerEnvironment, {
    AUTH_METHODS: '{"email":false,"providers":[]}',
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
    EMAIL_KEY_SECRET: TEST_EMAIL_KEY_SECRET,
    PUBLIC_ORIGIN: ORIGIN,
    ...overrides,
  });

/**
 * A stand-in for the host's per-call context, which Alchemy's bridge provides on a deployed Worker.
 * Better Auth only captures it, so no field is read.
 */
const runtimeContext: BaseRuntimeContext = {
  Type: "Test",
  env: {},
  get: () => Effect.succeed(undefined),
  id: "test",
  set: (id) => Effect.succeed(id),
};

/**
 * Provide the stand-in `RuntimeContext` and an execution scope to an effect that runs Better Auth.
 *
 * @param effect - The effect to run.
 * @returns The effect with its host requirements met.
 */
export const asExecution = <A, E, R>(effect: Effect.Effect<A, E, R | RuntimeContext>) =>
  effect.pipe(Effect.provideService(RuntimeContext, runtimeContext), Effect.scoped);

/**
 * The local D1 binding the auth tests run against, with every committed migration applied.
 */
export class LocalAuthD1 extends Context.Service<LocalAuthD1, RawDatabase>()(
  "@workspace/auth/LocalAuthD1",
) {
  /**
   * Starts a Miniflare D1, applies `apps/auth/migrations/`, and disposes the instance when the
   * layer's scope closes.
   */
  static readonly layer = Layer.effect(
    LocalAuthD1,
    Effect.gen(function* startLocalD1() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* path.fromFileUrl(new URL("../migrations", import.meta.url));

      const miniflare = yield* Effect.acquireRelease(
        Effect.sync(() => new Miniflare({ d1Databases: ["DB"], modules: true, script: "" })),
        (instance) => Effect.promise(() => instance.dispose()),
      );

      const binding = yield* Effect.promise(() => miniflare.getD1Database("DB"));
      const files = Arr.sort(yield* fs.readDirectory(directory, { recursive: true }), Order.String);

      for (const file of files.filter((name) => name.endsWith(".sql"))) {
        const sql = yield* fs.readFileString(path.join(directory, file));

        for (const statement of sql.split(STATEMENT_BREAKPOINT)) {
          yield* Effect.promise(() => binding.prepare(statement.trim()).run());
        }
      }

      return binding;
    }).pipe(Effect.provide(BunServices.layer)),
  );
}

/**
 * A D1 binding whose database is already gone, so every query rejects: the store fault the
 * session check must report as unavailable.
 */
export const disposedD1 = Effect.gen(function* startDisposedD1() {
  const miniflare = new Miniflare({ d1Databases: ["DB"], modules: true, script: "" });
  const binding = yield* Effect.promise(() => miniflare.getD1Database("DB"));

  yield* Effect.promise(() => miniflare.dispose());

  return binding;
});

/**
 * The Better Auth instance and `checkSession` over a D1 binding, built the way the Worker builds
 * them.
 *
 * @param binding - The raw D1 binding.
 * @param overrides - Deployment settings that replace the defaults.
 * @param mailer - The mail port the instance sends through; `Mailer.None` by default.
 * @returns A layer providing `AuthService` and `CheckSession`.
 */
export const authOver = (
  binding: RawDatabase,
  overrides?: Readonly<Record<string, string | undefined>>,
  mailer: typeof Mailer.None = Mailer.None,
) =>
  CheckSession.layer.pipe(
    Layer.provideMerge(AuthService.layer),
    Layer.provide(authDatabaseLayer(Effect.succeed(binding))),
    Layer.provide(settings(overrides)),
    Layer.provide(Layer.succeed(Mailer, mailer)),
  );

/**
 * Send a request to the Better Auth handler.
 *
 * @param path - The path under `ORIGIN`, such as `/auth/sign-in/email`.
 * @param init - The request options.
 * @returns The handler's response.
 */
export const handle = Effect.fn("handle")(function* handle(path: string, init: RequestInit) {
  const instance = yield* (yield* yield* AuthService).auth;

  const headers = new Headers(init.headers);

  headers.set("content-type", "application/json");
  headers.set("origin", ORIGIN);

  return yield* Effect.promise(() =>
    instance.handler(new Request(`${ORIGIN}${path}`, { ...init, headers })),
  );
});

/**
 * Reduce a response's `Set-Cookie` headers to the `Cookie` header a browser would send back.
 *
 * @param response - A response that sets cookies.
 * @returns The `name=value` pairs joined for a `Cookie` header.
 */
export const cookieOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .join("; ");

/**
 * Drop the signed `session_data` cookie so a check cannot answer from the cookie cache and must
 * read the session row.
 *
 * @param cookie - A `Cookie` header from a sign-in.
 * @returns The header with only the other cookies.
 */
export const tokenOnly = (cookie: string): string =>
  cookie
    .split("; ")
    .filter((pair) => !pair.includes("session_data"))
    .join("; ");

/**
 * Sign up a user with an email and password and return the response.
 *
 * @param email - The new user's email.
 * @returns The sign-up response.
 */
export const signUp = (email: string) =>
  handle("/auth/sign-up/email", {
    body: JSON.stringify({ email, name: "Ada Lovelace", password: "correct horse battery" }),
    method: "POST",
  });

/**
 * Sign in a user with an email and password and return the response.
 *
 * @param email - The user's email.
 * @returns The sign-in response, whose cookies carry the session.
 */
export const signIn = (email: string) =>
  handle("/auth/sign-in/email", {
    body: JSON.stringify({ email, password: "correct horse battery" }),
    method: "POST",
  });
