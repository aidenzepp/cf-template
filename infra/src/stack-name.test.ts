import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { Digest } from "effect/crypto";
import { STACK_NAME_MAX, base32Sha256 } from "../stages.ts";
import { StackNameError, requiresStackNamePin, resolveStackName } from "./stack-name.ts";

/**
 * Run the derivation against a config provider built from `values`, with the origin command
 * printing `origin` (or failing when it is absent).
 *
 * @param values - The `STACK_NAME`, `GITHUB_REPOSITORY` and `GITHUB_EVENT_NAME` variables.
 * @param origin - The URL the origin command prints.
 * @returns The derived name.
 */
const derive = (values: Record<string, string>, origin?: string) =>
  resolveStackName().pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ...values,
          STACK_NAME_ORIGIN_COMMAND: origin === undefined ? "false" : `echo ${origin}`,
        }),
      ),
    ),
  );

describe("resolveStackName sources", () => {
  it.effect("prefers STACK_NAME over every other source", () =>
    Effect.gen(function* override() {
      const name = yield* derive(
        {
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REPOSITORY: "acme/from-github",
          STACK_NAME: "example-stack",
        },
        "https://github.com/acme/from-origin.git",
      );

      assert.strictEqual(name, "example-stack");
    }),
  );

  it.effect("reads GITHUB_REPOSITORY in a workflow_dispatch bootstrap", () =>
    Effect.gen(function* dispatch() {
      const name = yield* derive(
        { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "acme/from-github" },
        "https://github.com/acme/from-origin.git",
      );

      assert.strictEqual(name, "from-github");
    }),
  );

  it.effect("ignores GITHUB_REPOSITORY outside workflow_dispatch", () =>
    Effect.gen(function* push() {
      const name = yield* derive(
        { GITHUB_EVENT_NAME: "push", GITHUB_REPOSITORY: "acme/from-github" },
        "https://github.com/acme/from-origin.git",
      );

      assert.strictEqual(name, "from-origin");
    }),
  );

  it.effect.each([
    "https://github.com/acme/My_Repo.git",
    "git@github.com:acme/My_Repo.git",
    "work-alias:acme/My_Repo.git",
    "ssh://git@github.com/acme/My_Repo",
  ])("parses the origin URL %s and normalizes it", (url) =>
    Effect.gen(function* forms() {
      assert.strictEqual(yield* derive({}, url), "my-repo");
    }),
  );

  it.effect("names the three sources when every source is absent", () =>
    Effect.gen(function* absent() {
      const error = yield* derive({}).pipe(Effect.flip);

      assert.instanceOf(error, StackNameError);
      assert.include(error.message, "STACK_NAME");
      assert.include(error.message, "GITHUB_REPOSITORY");
      assert.include(error.message, "origin");
    }),
  );
});

describe("resolveStackName normalization", () => {
  it.effect("truncates a long name and appends the owner/repo hash", () =>
    Effect.gen(function* truncates() {
      const repo = "a-very-long-repository-name-that-overflows";
      const name = yield* derive({}, `https://github.com/acme/${repo}.git`);

      assert.strictEqual(name.length, STACK_NAME_MAX);
      assert.strictEqual(
        name,
        `${repo.slice(0, STACK_NAME_MAX - 6)}${yield* base32Sha256(`acme/${repo}`, 6).pipe(Effect.provide(Digest.layerWebCrypto))}`,
      );
    }),
  );

  it.effect("adds no hash when the name fits", () =>
    Effect.gen(function* fits() {
      assert.strictEqual(
        yield* derive({}, "https://github.com/acme/cf-template.git"),
        "cf-template",
      );
    }),
  );
});

describe("requiresStackNamePin", () => {
  it("requires the pin for prod, staging and test-ci only", () => {
    assert.isTrue(requiresStackNamePin("prod"));
    assert.isTrue(requiresStackNamePin("staging-3"));
    assert.isTrue(requiresStackNamePin("test-ci"));
    assert.isFalse(requiresStackNamePin("test-abc"));
    assert.isFalse(requiresStackNamePin("dev"));
  });
});
