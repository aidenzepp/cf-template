import { BunHttpClient, BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import type { HttpClient } from "effect/http";
import { applySettings } from "../src/settings/apply.ts";
import { checkSettings } from "../src/settings/check.ts";
import { applyDeclaration } from "../src/settings/stack.ts";

const selected: Effect.Effect<void, { readonly message: string }, HttpClient.HttpClient> =
  process.argv.includes("--check") ? checkSettings : applySettings(applyDeclaration);

const program = selected.pipe(
  Effect.tapError((failure) => Console.error(failure.message)),
  Effect.provide(BunHttpClient.layer),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
