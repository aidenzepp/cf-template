import { passkeyClient } from "@better-auth/passkey/client";
import { describe, expect, it } from "@effect/vitest";
import { AUTH_BASE_PATH } from "@workspace/contract/domain/auth-paths";
import { createAuthClient } from "better-auth/react";
import { Effect } from "effect";
import {
  FRESH_SESSION_CODE,
  decodeAccounts,
  needsFreshSession,
  reauthProviders,
  settingsCalls,
  settle,
} from "../lib/settings-calls.ts";

/**
 * A client whose requests go to a recording stub `AUTH`: each request's path is kept, and the stub
 * answers with `answer()`.
 */
const recordingClient = (answer: () => Response) => {
  const paths: string[] = [];

  const client = createAuthClient({
    basePath: AUTH_BASE_PATH,
    baseURL: "http://web.test",
    fetchOptions: {
      customFetchImpl: (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input);

        paths.push(url.pathname);

        return Effect.runPromise(Effect.sync(answer));
      },
    },
    plugins: [passkeyClient()],
  });

  return { calls: settingsCalls(client), paths };
};

describe("settings calls", () => {
  it.effect("submits each action to its /auth path", () =>
    Effect.gen(function* submits() {
      const { calls, paths } = recordingClient(() => Response.json({}));

      yield* settle(() => calls.updateProfile("Ada", ""));
      yield* settle(() => calls.changePassword("old", "new", true));

      expect(paths).toEqual(["/auth/update-user", "/auth/change-password"]);
    }),
  );

  it.effect("opens the re-authentication prompt on the server's fresh-session refusal", () =>
    Effect.gen(function* refused() {
      const { calls } = recordingClient(() =>
        Response.json(
          { code: FRESH_SESSION_CODE, message: "Session is not fresh" },
          { status: 403 },
        ),
      );

      const { error } = yield* settle(() => calls.changePassword("old", "new", true));

      expect(needsFreshSession(error)).toBe(true);
      expect(needsFreshSession({ code: "INVALID_PASSWORD", status: 400 })).toBe(false);
    }),
  );

  it("offers providers only to an account without a password", () => {
    const github = { providerId: "github" };
    const password = { providerId: "credential" };

    expect(reauthProviders(decodeAccounts([github, { providerId: "google" }]))).toEqual([
      "github",
      "google",
    ]);
    expect(reauthProviders(decodeAccounts([github, password]))).toEqual([]);
    expect(reauthProviders(decodeAccounts("unreadable"))).toEqual([]);
  });
});
