/**
 * Setup for the `local` project.
 *
 * `alchemy@2.0.0-beta.85` ships no Vitest harness module (no `Test.make`, no `dev` option to pass
 * through), so this file cannot pass `dev: true` to one. It guards the one thing the harness would
 * read: `ALCHEMY_TEST_DEV`, which `vite.config.ts` sets on the root `test` block. A project that
 * lost the variable fails here, before any test can reach a live stage.
 */
import { beforeAll } from "@effect/vitest";
import { Config, Effect } from "effect";

beforeAll(() =>
  Config.String("ALCHEMY_TEST_DEV").pipe(
    Config.withDefault(""),
    Effect.filterOrFail(
      (value) => value === "1",
      () =>
        "ALCHEMY_TEST_DEV is not 1 in the local project. Set it on the root test block of vite.config.ts.",
    ),
  ),
);
