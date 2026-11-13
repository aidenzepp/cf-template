import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Schema, Stdio, Stream } from "effect";

/**
 * The linter ran but its output was not the JSON it documents, or it reported an `error` or a
 * `warning`. The message lists every blocking finding.
 */
export class DesignMdLintError extends Schema.TaggedError<DesignMdLintError>()(
  "DesignMdLintError",
  { message: Schema.String },
) {}

/**
 * The part of `lint --format json` the check reads: each finding's severity, rule, path and
 * message.
 */
const LintOutput = Schema.Struct({
  findings: Schema.Array(
    Schema.Struct({
      message: Schema.String,
      path: Schema.optional(Schema.String),
      rule: Schema.String,
      severity: Schema.Literals(["error", "warning", "info"]),
    }),
  ),
});

/**
 * Decodes the linter's JSON output.
 */
const decodeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(LintOutput));

/**
 * Fails when `output` holds a finding of severity `error` or `warning`; `info` findings pass.
 * Nothing is filtered: a finding the generator cannot avoid is fixed in the generator.
 *
 * @param file - The linted file, named in each line of the failure.
 * @param output - The JSON the linter printed.
 * @returns Nothing on success.
 */
export const checkFindings = Effect.fn("designMd.checkFindings")(function* checkFindings(
  file: string,
  output: string,
) {
  const decoded = yield* decodeOutput(output).pipe(
    Effect.mapError(
      () =>
        new DesignMdLintError({
          message: `${file}: the design.md linter did not print the JSON it documents`,
        }),
    ),
  );

  const blocking = decoded.findings.filter(({ severity }) => severity !== "info");

  if (blocking.length > 0) {
    yield* new DesignMdLintError({
      message: blocking
        .map(
          ({ message, path, rule, severity }) =>
            `${file}: ${severity} ${rule}${path === undefined ? "" : ` at ${path}`}: ${message}`,
        )
        .join("\n"),
    });
  }
});

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const file = process.argv.at(2) ?? "DESIGN.md";
      const stdin = yield* Stdio.Stdio;

      yield* checkFindings(file, yield* Stream.mkString(Stream.decodeText(stdin.stdin)));
    }).pipe(
      Effect.catchTag("DesignMdLintError", ({ message }) =>
        Console.error(message).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      ),
      Effect.provide(BunServices.layer),
    ),
  );
}
