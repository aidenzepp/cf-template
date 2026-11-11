import { BunHttpClient, BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import type { HttpClient } from "effect/http";
import { applySettings } from "../src/settings/apply.ts";
import { applyDeclaration } from "../src/settings/stack.ts";

/**
 * Print the `--check` stub: the drift detector arrives in part 4 of #19.
 */
const check = Console.log("check: not implemented until part 4");

const selected: Effect.Effect<void, { readonly message: string }, HttpClient.HttpClient> =
  process.argv.includes("--check") ? check : applySettings(applyDeclaration);

const program = selected.pipe(
  Effect.tapError((failure) => Console.error(failure.message)),
  Effect.provide(BunHttpClient.layer),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
