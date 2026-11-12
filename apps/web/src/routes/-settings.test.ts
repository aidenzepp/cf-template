import { passkeyClient } from "@better-auth/passkey/client";
import { describe, expect, it } from "@effect/vitest";
import { AUTH_BASE_PATH } from "@workspace/contract/domain/auth-paths";
import { createAuthClient } from "better-auth/react";
import { Effect, Option } from "effect";
import { FRESH_SESSION_CODE, betterAuthCall } from "../lib/better-auth-call.ts";
import {
  PASSKEY_FALLBACK_NAME,
  decodeAccounts,
  decodePasskeys,
  passkeyHint,
  reauthProviders,
  settingsCalls,
} from "../lib/settings-calls.ts";

/**
 * A client whose requests go to a recording stub `AUTH`: each request's path is kept, and the stub
 * answers with `answer(path)`.
 */
const recordingClient = (answer: (path: string) => Response) => {
  const paths: Array<string> = [];

  const client = createAuthClient({
    basePath: AUTH_BASE_PATH,
    baseURL: "http://web.test",
    fetchOptions: {
      customFetchImpl: (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input);

        paths.push(url.pathname);

        return Effect.runPromise(Effect.sync(() => answer(url.pathname)));
      },
    },
    plugins: [passkeyClient()],
  });

  return { calls: settingsCalls(client), paths };
};

const REGISTER_OPTIONS = {
  challenge: "AA",
  pubKeyCredParams: [{ alg: -7, type: "public-key" }],
  rp: { id: "web.test", name: "web" },
  user: { displayName: "Ada", id: "AA", name: "ada" },
};

const CREDENTIAL = {
  getClientExtensionResults: () => ({}),
  id: "AA",
  rawId: new ArrayBuffer(1),
  response: { attestationObject: new ArrayBuffer(1), clientDataJSON: new ArrayBuffer(1) },
  type: "public-key",
};

/**
 * Runs an effect with a browser whose WebAuthn step answers at once with `CREDENTIAL`, the module
 * boundary the passkey client calls through. The globals are restored afterwards.
 *
 * @param effect - The effect to run.
 * @returns The effect, run with the stub in place.
 */
const withWebAuthn = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const saved = {
        credential: Object.getOwnPropertyDescriptor(globalThis, "PublicKeyCredential"),
        navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
      };

      Object.defineProperty(globalThis, "PublicKeyCredential", {
        configurable: true,
        value: Object,
      });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { credentials: { create: () => Effect.runPromise(Effect.succeed(CREDENTIAL)) } },
      });

      return saved;
    }),
    () => effect,
    (saved) =>
      Effect.sync(() => {
        Reflect.deleteProperty(globalThis, "PublicKeyCredential");
        Reflect.deleteProperty(globalThis, "navigator");

        if (saved.credential !== undefined) {
          Object.defineProperty(globalThis, "PublicKeyCredential", saved.credential);
        }

        if (saved.navigator !== undefined) {
          Object.defineProperty(globalThis, "navigator", saved.navigator);
        }
      }),
  );

describe("settings calls", () => {
  it.effect("submits each action to its /auth path", () =>
    Effect.gen(function* submits() {
      const { calls, paths } = recordingClient(() => Response.json({}));

      yield* betterAuthCall(() => calls.updateProfile("Ada", ""));
      yield* betterAuthCall(() => calls.changePassword("old", "new", true));
      yield* betterAuthCall(() => calls.renamePasskey("p1", "phone"));
      yield* betterAuthCall(() => calls.deletePasskey("p1"));
      yield* betterAuthCall(() => calls.linkProvider("github"));
      yield* betterAuthCall(() => calls.unlinkAccount("a1"));

      expect(paths).toStrictEqual([
        "/auth/update-user",
        "/auth/change-password",
        "/auth/passkey/update-passkey",
        "/auth/passkey/delete-passkey",
        "/auth/link-social",
        "/auth/unlink-account",
      ]);
    }),
  );

  it.effect("registers a passkey: options, the browser step, then verify-registration", () =>
    Effect.gen(function* registers() {
      const { calls, paths } = recordingClient((path) =>
        Response.json(path.endsWith("generate-register-options") ? REGISTER_OPTIONS : {}),
      );

      yield* withWebAuthn(betterAuthCall(() => calls.addPasskey("laptop")));

      expect(paths).toStrictEqual([
        "/auth/passkey/generate-register-options",
        "/auth/passkey/verify-registration",
      ]);
    }),
  );

  it.effect("fails with SessionNotFresh on the server's fresh-session refusal", () =>
    Effect.gen(function* refused() {
      const { calls } = recordingClient(() =>
        Response.json(
          { code: FRESH_SESSION_CODE, message: "Session is not fresh" },
          { status: 403 },
        ),
      );

      const failure = yield* Effect.flip(
        betterAuthCall(() => calls.changePassword("old", "new", true)),
      );

      expect(failure._tag).toBe("SessionNotFresh");
    }),
  );

  it("offers providers only to an account without a password", () => {
    const github = { id: "a1", providerId: "github" };
    const password = { id: "a2", providerId: "credential" };

    expect(
      reauthProviders(decodeAccounts([github, { id: "a3", providerId: "google" }])),
    ).toStrictEqual(["github", "google"]);
    expect(reauthProviders(decodeAccounts([github, password]))).toStrictEqual([]);
    expect(reauthProviders(decodeAccounts("unreadable"))).toStrictEqual([]);
  });
});

describe("passkeys card", () => {
  it("keeps every passkey when one has a null name", () => {
    const listed = decodePasskeys([
      { id: "p1", name: null },
      { id: "p2", name: "phone" },
    ]);

    expect(Option.getOrElse(listed, () => []).map(({ id }) => id)).toStrictEqual(["p1", "p2"]);
    expect(PASSKEY_FALLBACK_NAME).toBe("Unnamed passkey");
  });

  it("shows the hint only when email is off", () => {
    expect(passkeyHint(false)).toBe(
      "Without email, a passkey is the way back in if the password is forgotten.",
    );
    expect(passkeyHint(true)).toBeNull();
  });
});
