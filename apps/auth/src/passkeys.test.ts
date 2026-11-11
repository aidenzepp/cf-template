import { assert, it, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { passkeyOptions } from "./passkeys.ts";
import { LocalAuthD1, asExecution, authOver, cookieOf, handle, signUp } from "./test-harness.ts";

/**
 * A public origin that differs from the dev default the options module and the harness fall back
 * to, so an instance that read the dev origin instead of the stage's setting fails.
 */
const STAGE_ORIGIN = "https://notes.example.com";

/**
 * The parts of the registration options the tests read.
 */
const RegistrationOptions = Schema.fromJsonString(
  Schema.Struct({
    authenticatorSelection: Schema.Struct({
      requireResidentKey: Schema.Boolean,
      residentKey: Schema.String,
      userVerification: Schema.String,
    }),
    rp: Schema.Struct({ id: Schema.String }),
  }),
);

it("requires a resident key and user verification", () => {
  assert.deepStrictEqual(passkeyOptions("https://notes.example.com").authenticatorSelection, {
    residentKey: "required",
    userVerification: "required",
  });
});

it("derives the relying party id and the origin from the public origin", () => {
  const options = passkeyOptions("https://notes.example.com");

  assert.strictEqual(options.rpID, "notes.example.com");
  assert.strictEqual(options.origin, "https://notes.example.com");
});

it("drops the port from the relying party id and keeps it in the origin", () => {
  const options = passkeyOptions("http://localhost:3000");

  assert.strictEqual(options.rpID, "localhost");
  assert.strictEqual(options.origin, "http://localhost:3000");
});

layer(LocalAuthD1.layer)("the instance's passkey plugin", (live) => {
  live.effect("takes its relying party id and selection from the stage's public origin", () =>
    Effect.gen(function* fromStage() {
      const binding = yield* LocalAuthD1;

      yield* Effect.gen(function* inner() {
        const cookie = cookieOf(yield* signUp("passkey@example.com"));

        const response = yield* handle("/auth/passkey/generate-register-options", {
          headers: { cookie },
          method: "GET",
        });

        const options = yield* Effect.promise(() => response.text()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(RegistrationOptions)),
        );

        assert.strictEqual(options.rp.id, "notes.example.com");
        assert.isTrue(options.authenticatorSelection.requireResidentKey);
        assert.strictEqual(options.authenticatorSelection.residentKey, "required");
        assert.strictEqual(options.authenticatorSelection.userVerification, "required");
      }).pipe(Effect.provide(authOver(binding, { PUBLIC_ORIGIN: STAGE_ORIGIN })), asExecution);
    }),
  );
});
