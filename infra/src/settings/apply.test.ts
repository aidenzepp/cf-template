import { Credentials, fromToken } from "@alchemy.run/github";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Console, Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { applySettings } from "./apply.ts";
import { AdminGuardError, AmbientCredentialsError } from "./repository.ts";
import { withToken } from "./stack.ts";

/**
 * Run `applySettings` against a fake GitHub with a recording `declare`.
 *
 * @param environment - The configuration entries; `GITHUB_TOKEN` and the repository are preset.
 * @param admin - The `permissions.admin` value the repository read returns.
 * @returns The run, the `METHOD path` of every request and the tokens `declare` received.
 */
const harness = (environment: Record<string, string>, admin: boolean) => {
  const calls: Array<string> = [];
  const tokens: Array<string> = [];

  const client = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        calls.push(`${request.method} ${url.pathname}`);

        const body =
          url.pathname === "/repos/acme/widget"
            ? { owner: { login: "acme", type: "User" }, permissions: { admin }, private: true }
            : { login: "acme", secrets: [] };

        return HttpClientResponse.fromWeb(request, Response.json(body));
      }),
    ),
  );

  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      GITHUB_REPOSITORY: "acme/widget",
      GITHUB_TOKEN: "ghp_guarded",
      ...environment,
    }),
  );

  const run = applySettings((_plan, token) =>
    Effect.sync(() => {
      tokens.push(Redacted.value(token));

      return 0;
    }),
  ).pipe(
    Effect.provide([client, config]),
    Effect.provideService(Console.Console, { ...globalThis.console, log: () => {} }),
  );

  return { calls, run, tokens };
};

describe("applySettings", () => {
  it.effect("stops at a failed guard before any provider or write call", () =>
    Effect.gen(function* guardFails() {
      const { calls, run, tokens } = harness({}, false);
      const failure = yield* Effect.flip(run);

      assert.instanceOf(failure, AdminGuardError);
      assert.deepStrictEqual(calls, ["GET /repos/acme/widget"]);
      assert.deepStrictEqual(tokens, []);
    }),
  );

  it.effect("hands the provider the token the guard checked", () =>
    Effect.gen(function* guarded() {
      const { calls, run, tokens } = harness({}, true);

      // This fake answers every read with the same body, so the after-apply check cannot decode
      // live state and ends the run; check.test.ts covers that outcome with real-shaped state.
      yield* Effect.ignore(run);

      assert.deepStrictEqual(tokens, ["ghp_guarded"]);
      assert.deepStrictEqual(calls.slice(0, 2), [
        "GET /repos/acme/widget",
        "GET /repos/acme/widget/actions/secrets",
      ]);
    }),
  );

  for (const name of ["GITHUB_ACCESS_TOKEN", "GH_HOST", "GITHUB_BASE_URL", "GITHUB_API_URL"]) {
    it.effect(`refuses to start when ${name} is set, before any network call`, () =>
      Effect.gen(function* refused() {
        const { calls, run, tokens } = harness({ [name]: "ghp_other" }, true);
        const failure = yield* Effect.flip(run);

        assert.instanceOf(failure, AmbientCredentialsError);
        assert.include(failure.message, name);
        assert.notInclude(failure.message, "ghp_other");
        assert.deepStrictEqual(calls, []);
        assert.deepStrictEqual(tokens, []);
      }),
    );
  }
});

describe("withToken", () => {
  it.effect("replaces the credentials the provider layer resolved", () =>
    Effect.gen(function* pinned() {
      const resolve = yield* Credentials;
      const resolved = yield* resolve;

      assert.strictEqual(Redacted.value(resolved.token), "ghp_guarded");
    }).pipe(Effect.provide(withToken(fromToken("ghp_profile"), Redacted.make("ghp_guarded")))),
  );
});
