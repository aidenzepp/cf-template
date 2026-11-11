import * as Cloudflare from "@alchemy.run/cloudflare";
import type { InputProps } from "alchemy/Input";
import { Context, Effect, Layer } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { AuthService, authDatabaseLayer } from "./auth.ts";
import { Auth, AUTH_BASE_PATH } from "./contract.ts";
import { CheckSession } from "./session.ts";

/**
 * What `infra` supplies to the `auth` Worker: its deploy properties and the auth D1 resource it
 * binds. The Worker module never declares either, so the stage, the name and the bindings have one
 * owner, `infra/src/auth.ts`.
 */
export class AuthDeployment extends Context.Service<
  AuthDeployment,
  {
    readonly database: Cloudflare.D1.Database;
    readonly props: InputProps<Cloudflare.WorkerProps>;
  }
>()("@workspace/auth/AuthDeployment") {}

/**
 * The `auth` Worker: Better Auth under `/auth` over the shared Effect D1 client, and
 * `checkSession` on the default entrypoint for `api`. It has no public address.
 */
export default Auth.make<AuthDeployment, AuthDeployment | Cloudflare.WorkerServices>(
  AuthDeployment.pipe(Effect.map(({ props }) => props)),
  Effect.gen(function* buildAuth() {
    const { database } = yield* AuthDeployment;

    const binding = yield* Cloudflare.D1.QueryDatabase(database).pipe(
      Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
    );

    const services = CheckSession.layer.pipe(
      Layer.provideMerge(AuthService.layer),
      Layer.provide(authDatabaseLayer(binding.raw)),
    );

    const { auth, checkSession } = yield* Effect.all({
      auth: AuthService,
      checkSession: CheckSession,
    }).pipe(Effect.provide(services));

    return {
      checkSession,
      // `web` forwards `/auth/*` wholesale, so the Worker serves nothing else over HTTP.
      fetch: Effect.gen(function* routeFetch() {
        const request = yield* HttpServerRequest.HttpServerRequest;

        return request.url.startsWith(AUTH_BASE_PATH)
          ? yield* (yield* auth).fetch
          : HttpServerResponse.empty({ status: 404 });
      }),
    };
  }),
);
