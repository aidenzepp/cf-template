import { passkeyClient } from "@better-auth/passkey/client";
import { describe, expect, it } from "@effect/vitest";
import { AUTH_BASE_PATH } from "@workspace/contract/domain/auth-paths";
import { createAuthClient } from "better-auth/react";
import { FRESH_SESSION_CODE } from "../components/auth/reauthenticate.tsx";
import { settingsCalls } from "./settings.tsx";

/**
 * A client whose requests go to a recording stub `AUTH`: each request's method and path are kept,
 * and the stub answers `200` with `{}`.
 */
const recordingClient = () => {
  const paths: string[] = [];

  const client = createAuthClient({
    basePath: AUTH_BASE_PATH,
    baseURL: "http://web.test",
    fetchOptions: {
      customFetchImpl: (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input);

        paths.push(url.pathname);

        return Promise.resolve(Response.json({}));
      },
    },
    plugins: [passkeyClient()],
  });

  return { calls: settingsCalls(client), paths };
};

describe("settings calls", () => {
  it("submits each action to its /auth path", async () => {
    const { calls, paths } = recordingClient();

    await calls.updateProfile("Ada", "");
    await calls.changePassword("old", "new", true);

    expect(paths).toEqual(["/auth/update-user", "/auth/change-password"]);
  });

  it("opens the re-authentication prompt on the server's fresh-session refusal code", () => {
    expect(FRESH_SESSION_CODE).toBe("SESSION_NOT_FRESH");
  });
});
