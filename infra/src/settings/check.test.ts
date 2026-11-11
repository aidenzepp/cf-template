import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Schema } from "effect";
import { applySettings } from "./apply.ts";
import { DriftError, checkSettings, readDrift } from "./check.ts";
import { PRO, base, harness } from "./fake-github.ts";
import type { Reply } from "./fake-github.ts";

/**
 * The configuration every run needs: the repository, and the dispatch event that makes the stack
 * name derive from it without reading `git`.
 */
const environment = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "acme/widget",
};

/**
 * A reply with a 200 body.
 *
 * @param body - The JSON body.
 * @returns The reply.
 */
const ok = (body: Schema.Json): Reply => ({ body, status: 200 });

/**
 * The live state of a private Pro repository that matches the declaration, with overrides per
 * `METHOD path`. Writes and unlisted reads answer 204; the code-scanning analyses read answers 404.
 *
 * @param overrides - Replies that replace the clean ones.
 * @returns The `answer` function for `harness`.
 */
const state = (overrides: Record<string, Reply> = {}) => {
  const clean = {
    [`GET ${base}`]: ok({
      allow_auto_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_squash_merge: true,
      delete_branch_on_merge: true,
      owner: { login: "acme", type: "User" },
      permissions: { admin: true },
      private: true,
    }),
    [`GET ${base}/actions/secrets`]: ok({ secrets: [] }),
    [`GET ${base}/actions/variables`]: ok({
      variables: [
        { name: "BRANCH_PROTECTION", value: "ruleset" },
        { name: "ENVIRONMENTS", value: "true" },
        { name: "PREVIEW_ON", value: "merge-ready" },
        { name: "RELEASE_ON", value: "false" },
      ],
    }),
    [`GET ${base}/code-scanning/analyses`]: { status: 404 },
    [`GET ${base}/environments`]: ok({
      environments: [{ name: "prod" }, { name: "prod-destructive" }],
    }),
    [`GET ${base}/labels`]: ok(
      ["convention", "dependencies", "bug", "enhancement", "documentation", "merge-ready"].map(
        (name) => ({ name }),
      ),
    ),
    [`GET ${base}/rulesets`]: ok([{ id: 7, name: "main" }]),
    [`GET ${base}/rulesets/7`]: ok({
      rules: [
        { parameters: { allowed_merge_methods: ["squash"] }, type: "pull_request" },
        {
          parameters: {
            required_status_checks: [
              "checks",
              "pr-title",
              "pr-body",
              "convention-guard",
              "merge-gate",
            ].map((context) => ({ context })),
          },
          type: "required_status_checks",
        },
      ],
    }),
    "GET /user": ok({ login: "acme", plan: { name: "pro" } }),
  };

  const replies = new Map(Object.entries({ ...clean, ...overrides }));

  return (call: string) => replies.get(call);
};

/**
 * The clean variables plus a `STACK_NAME`.
 *
 * @param value - The live `STACK_NAME`.
 * @returns The variables reply.
 */
const pinned = (value: string) =>
  ok({
    variables: [
      { name: "BRANCH_PROTECTION", value: "ruleset" },
      { name: "ENVIRONMENTS", value: "true" },
      { name: "PREVIEW_ON", value: "merge-ready" },
      { name: "RELEASE_ON", value: "false" },
      { name: "STACK_NAME", value },
    ],
  });

/**
 * Read the differences of a fake repository whose live state is `state(overrides)`.
 *
 * @param overrides - Replies that replace the clean ones.
 * @returns The difference lines.
 */
const drift = (overrides: Record<string, Reply> = {}) =>
  harness((target) => readDrift(target), PRO, state(overrides), environment).run;

describe("readDrift", () => {
  it.effect("is empty when live state matches the declaration", () =>
    Effect.gen(function* clean() {
      assert.deepStrictEqual(yield* drift(), []);
    }),
  );

  it.effect("lists a hand-created label, ruleset and environment as UNDECLARED", () =>
    Effect.gen(function* undeclared() {
      const lines = yield* drift({
        [`GET ${base}/environments`]: ok({
          environments: [{ name: "prod" }, { name: "prod-destructive" }, { name: "qa" }],
        }),
        [`GET ${base}/labels`]: ok(
          [
            "convention",
            "dependencies",
            "bug",
            "enhancement",
            "documentation",
            "merge-ready",
            "sprint",
          ].map((name) => ({ name })),
        ),
        [`GET ${base}/rulesets`]: ok([
          { id: 7, name: "main" },
          { id: 8, name: "code-scanning" },
          { id: 9, name: "legacy" },
        ]),
      });

      assert.deepStrictEqual(lines, [
        "UNDECLARED ruleset legacy",
        "UNDECLARED environment qa",
        "UNDECLARED label sprint",
      ]);
    }),
  );

  it.effect("reports declared resources that do not exist", () =>
    Effect.gen(function* missing() {
      const lines = yield* drift({
        [`GET ${base}/labels`]: ok([{ name: "bug" }]),
        [`GET ${base}/rulesets`]: ok([]),
      });

      assert.include(lines, "MISSING ruleset main");
      assert.include(lines, "MISSING label convention");
      assert.notInclude(lines, "MISSING label bug");
    }),
  );

  it.effect("reports PREVIEW_ON every-push on a private repository as a MISMATCH", () =>
    Effect.gen(function* preview() {
      const lines = yield* drift({
        [`GET ${base}/actions/variables`]: ok({
          variables: [
            { name: "BRANCH_PROTECTION", value: "ruleset" },
            { name: "ENVIRONMENTS", value: "true" },
            { name: "PREVIEW_ON", value: "every-push" },
            { name: "RELEASE_ON", value: "false" },
          ],
        }),
      });

      assert.deepStrictEqual(lines, ["MISMATCH PREVIEW_ON: live every-push, detected merge-ready"]);
    }),
  );

  it.effect("compares RELEASE_ON to the secrets that exist", () =>
    Effect.gen(function* release() {
      const lines = yield* drift({
        [`GET ${base}/actions/secrets`]: ok({
          secrets: [{ name: "APP_ID" }, { name: "APP_PRIVATE_KEY" }],
        }),
      });

      assert.deepStrictEqual(lines, ["MISMATCH RELEASE_ON: live false, detected true"]);
    }),
  );

  it.effect("accepts CLOUDFLARE_DEPLOYS only with both Cloudflare secrets", () =>
    Effect.gen(function* deploys() {
      const variables = ok({
        variables: [
          { name: "BRANCH_PROTECTION", value: "ruleset" },
          { name: "CLOUDFLARE_DEPLOYS", value: "true" },
          { name: "ENVIRONMENTS", value: "true" },
          { name: "PREVIEW_ON", value: "merge-ready" },
          { name: "RELEASE_ON", value: "false" },
        ],
      });

      const without = yield* drift({ [`GET ${base}/actions/variables`]: variables });

      const withBoth = yield* drift({
        [`GET ${base}/actions/secrets`]: ok({
          secrets: [{ name: "CLOUDFLARE_API_TOKEN" }, { name: "CLOUDFLARE_ACCOUNT_ID" }],
        }),
        [`GET ${base}/actions/variables`]: variables,
      });

      assert.deepStrictEqual(without, ["MISMATCH CLOUDFLARE_DEPLOYS: live true, detected false"]);
      assert.deepStrictEqual(withBoth, []);
    }),
  );

  it.effect("compares the live STACK_NAME to the derivation", () =>
    Effect.gen(function* stack() {
      const wrong = yield* drift({ [`GET ${base}/actions/variables`]: pinned("gadget") });
      const right = yield* drift({ [`GET ${base}/actions/variables`]: pinned("widget") });

      assert.deepStrictEqual(wrong, ["MISMATCH STACK_NAME: live gadget, detected widget"]);
      assert.deepStrictEqual(right, []);
    }),
  );

  it.effect("reports a widened merge method and a changed merge setting", () =>
    Effect.gen(function* widened() {
      const lines = yield* drift({
        [`GET ${base}`]: ok({
          allow_auto_merge: true,
          allow_merge_commit: true,
          allow_rebase_merge: false,
          allow_squash_merge: true,
          delete_branch_on_merge: true,
          owner: { login: "acme", type: "User" },
          permissions: { admin: true },
          private: true,
        }),
        [`GET ${base}/rulesets/7`]: ok({
          rules: [
            { parameters: { allowed_merge_methods: ["merge", "squash"] }, type: "pull_request" },
          ],
        }),
      });

      assert.include(lines, "MISMATCH allow_merge_commit: live true, declared false");
      assert.include(
        lines,
        "MISMATCH main ruleset merge methods: live merge,squash, declared squash",
      );
      assert.include(
        lines,
        "MISMATCH main ruleset required checks: live , declared checks,convention-guard,merge-gate,pr-body,pr-title",
      );
    }),
  );
});

describe("checkSettings", () => {
  it.effect("exits clean and sends only GET requests", () =>
    Effect.gen(function* clean() {
      const { lines, requests, run } = harness(() => checkSettings, PRO, state(), environment);

      yield* run;

      assert.deepStrictEqual(lines, ["check: clean"]);
      assert.isTrue(requests.every(({ call }) => call.startsWith("GET ")));
    }),
  );

  it.effect("prints each difference and fails with the count", () =>
    Effect.gen(function* drifted() {
      const { lines, requests, run } = harness(
        () => checkSettings,
        PRO,
        state({ [`GET ${base}/labels`]: ok([{ name: "bug" }, { name: "sprint" }]) }),
        environment,
      );

      const failure = yield* Effect.flip(run);

      assert.instanceOf(failure, DriftError);
      assert.include(lines, "UNDECLARED label sprint");
      assert.strictEqual(lines.at(-1), `check: ${lines.length - 1} difference(s)`);
      assert.isTrue(requests.every(({ call }) => call.startsWith("GET ")));
    }),
  );
});

/**
 * Run `applySettings` on a fake whose labels include `sprint` until `declare` has run, and, when
 * `stays` is set, afterwards too.
 *
 * @param stays - Whether the stray label survives the apply.
 * @returns The harness and a record of whether `declare` ran.
 */
const applying = (stays: boolean) => {
  const declared = { ran: false };
  const answer = state();

  const labels = (call: string) =>
    call === `GET ${base}/labels` && (stays || !declared.ran)
      ? ok(
          [
            "convention",
            "dependencies",
            "bug",
            "enhancement",
            "documentation",
            "merge-ready",
            "sprint",
          ].map((name) => ({ name })),
        )
      : answer(call);

  return {
    declared,
    ...harness(
      () =>
        applySettings(() =>
          Effect.sync(() => {
            declared.ran = true;

            return 0;
          }),
        ),
      PRO,
      labels,
      { ...environment, GITHUB_TOKEN: "ghp_guarded" },
    ),
  };
};

describe("applySettings check gate", () => {
  it.effect("prints the diff before apply, ignores it, and ends clean after apply", () =>
    Effect.gen(function* converged() {
      const { declared, lines, run } = applying(false);

      yield* run;

      assert.isTrue(declared.ran);
      assert.include(lines, "UNDECLARED label sprint");
      assert.include(lines, "check before apply: 1 difference(s)");
      assert.strictEqual(lines.at(-1), "check after apply: clean");
    }),
  );

  it.effect("fails the run when the check after apply is not clean", () =>
    Effect.gen(function* stillDrifted() {
      const { declared, lines, run } = applying(true);

      const failure = yield* Effect.flip(run);

      assert.isTrue(declared.ran);
      assert.instanceOf(failure, DriftError);
      assert.strictEqual(lines.at(-1), "check after apply: 1 difference(s)");
    }),
  );
});
