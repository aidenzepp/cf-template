import { BunServices } from "@effect/platform-bun";
import { assert, describe, it, vi } from "@effect/vitest";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Alchemist from "alchemy/Alchemist";
import {
  Array as Arr,
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Option,
  Order,
  Path,
  Redacted,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { readDrift } from "./check.ts";
import { declarationPlan, LABELS } from "./declare.ts";
import type { DeclarationPlan } from "./declare.ts";
import { PRO } from "./fake-github.ts";
import { createFakeGitHub } from "./fake-state.ts";
import type { Call, FakeRuleset, RulesetInput, Seed } from "./fake-state.ts";
import { OWNER, REPO, REPO_PATH } from "./github-defaults.ts";
import type { JsonRecord } from "./github-defaults.ts";
import type { GuardedRepository } from "./repository.ts";
import { applyDeclaration } from "./stack.ts";
import type { Tier } from "./tier.ts";

const repository: GuardedRepository = {
  name: REPO,
  owner: OWNER,
  ownerType: "User",
  visibility: "private",
};

const tier: Tier = {
  branchProtection: "ruleset",
  capabilities: new Set(PRO),
  environments: true,
  plan: "pro",
  previewOn: "merge-ready",
  releaseOn: false,
  visibility: "private",
};

const plan: DeclarationPlan = declarationPlan(repository, tier, Option.none());

const token = Redacted.make("ghp_fake");

/**
 * The method and path of each call, e.g. `POST /repos/acme/widget/labels`.
 */
const lines = (calls: ReadonlyArray<Call>) => calls.map(({ method, path }) => `${method} ${path}`);

/**
 * The calls with the given method whose path matches.
 */
const where = (calls: ReadonlyArray<Call>, method: string, path: RegExp) =>
  calls.filter((call) => call.method === method && path.test(call.path));

/**
 * The calls made after the first `since` entries of the log.
 */
const after = (calls: ReadonlyArray<Call>, since: number) => calls.slice(since);

/**
 * Point alchemy's user-level home and its project-level `.alchemy` directory at an empty scratch
 * directory under `work/`, removed when the scope ends.
 *
 * `applyDeclaration` provides `Alchemist.layer()` itself, and that layer builds the profile and
 * credential stores over the real file system, rooted at `ALCHEMY_HOME` or `~/.alchemy`. Rooting
 * both in an empty directory means no run reads or creates anything under `~/.alchemy`.
 *
 * @returns The scratch directory and the `AlchemyContext` that names its `.alchemy` directory.
 */
const hermetic = Effect.fn("converge.test.hermetic")(function* hermetic() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const work = yield* path.fromFileUrl(new URL("../../../work", import.meta.url));

  yield* fs.makeDirectory(work, { recursive: true });

  const home = yield* fs.makeTempDirectoryScoped({ directory: work, prefix: "settings-converge-" });

  yield* Effect.acquireRelease(
    Effect.sync(() => vi.stubEnv("ALCHEMY_HOME", home)),
    () => Effect.sync(() => vi.unstubAllEnvs()),
  );

  return {
    context: { adopt: false, dev: false, dotAlchemy: path.join(home, ".alchemy") },
    home,
  };
});

/**
 * Converge `declared` against the fake through the real engine, and collect the plan action of
 * every resource.
 *
 * @param fake - The fake GitHub.
 * @param declared - The declaration to apply.
 * @returns The `logicalId` and plan action of each planned resource.
 */
const converge = Effect.fn("converge.test.converge")(
  function* converge(fake: ReturnType<typeof createFakeGitHub>, declared: DeclarationPlan) {
    const { context, home } = yield* hermetic();
    const actions: Array<{ readonly action: string; readonly logicalId: string }> = [];

    // A fresh provider reads the environment as it is now; the default one keeps its first read.
    assert.strictEqual(
      yield* Config.String("ALCHEMY_HOME").pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      ),
      home,
    );

    yield* applyDeclaration(declared, token).pipe(
      Alchemist.onEvent((event) =>
        event.type === "plan.resource.completed"
          ? Effect.sync(() => {
              actions.push({ action: event.action, logicalId: event.logicalId });
            })
          : Effect.void,
      ),
      Effect.provideService(AlchemyContext, context),
      Effect.provideService(FetchHttpClient.Fetch, fake.fetch),
    );

    return actions;
  },
  Effect.scoped,
  Effect.provide(BunServices.layer),
);

/**
 * Run `readDrift` against the fake.
 */
const drift = (fake: ReturnType<typeof createFakeGitHub>) =>
  readDrift(repository).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fake.fetch),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_TOKEN: "ghp_fake" }))),
  );

/**
 * A seed that holds the stored rulesets of `fake`, with `change` applied to each.
 */
const seedFrom = (
  fake: ReturnType<typeof createFakeGitHub>,
  change: (ruleset: FakeRuleset) => RulesetInput,
) => ({ rulesets: fake.state().rulesets.map(change) }) satisfies Seed;

const PullRequestRule = Schema.Struct({
  parameters: Schema.StructWithRest(
    Schema.Struct({ allowed_merge_methods: Schema.Array(Schema.String) }),
    [Schema.Record(Schema.String, Schema.Json)],
  ),
  type: Schema.Literal("pull_request"),
});

const isPullRequest = Schema.is(PullRequestRule);

/**
 * Open the `pull_request` rule to every merge method, leaving its other parameters and every other
 * rule as they are.
 */
const widen: (rule: Schema.Json) => Schema.Json = (rule) =>
  Schema.decodeUnknownOption(PullRequestRule)(rule).pipe(
    Option.match({
      onNone: () => rule,
      onSome: (found) =>
        ({
          parameters: { ...found.parameters, allowed_merge_methods: ["merge", "squash", "rebase"] },
          type: found.type,
        }) satisfies Schema.Json,
    }),
  );

/**
 * The merge methods the `pull_request` rule of a stored ruleset allows.
 */
const mergeMethods = (ruleset: FakeRuleset | undefined) =>
  (ruleset?.rules ?? [])
    .filter(isPullRequest)
    .flatMap((rule) => rule.parameters.allowed_merge_methods);

/**
 * The keys of a recorded JSON object body.
 */
const keysOf = (body: Schema.Json | undefined) =>
  Object.keys(
    Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(body).pipe(
      Option.getOrElse<JsonRecord>(() => ({})),
    ),
  );

const sorted = (values: Iterable<string>) => Arr.sort([...values], Order.String);

describe("settings stack converge", () => {
  it.effect("creates every resource on the first run", () =>
    Effect.gen(function* firstRun() {
      const fake = createFakeGitHub();
      const actions = yield* converge(fake, plan);
      const { calls } = fake;
      const live = fake.state();

      assert.strictEqual(where(calls, "POST", /\/rulesets$/u).length, 1);
      assert.strictEqual(where(calls, "POST", /\/labels$/u).length, LABELS.length);
      assert.strictEqual(where(calls, "POST", /\/actions\/variables$/u).length, 4);
      assert.strictEqual(where(calls, "PUT", /\/environments\/[^/]+$/u).length, 2);
      assert.strictEqual(where(calls, "PATCH", new RegExp(`^${REPO_PATH}$`, "u")).length, 1);
      assert.strictEqual(where(calls, "DELETE", /./u).length, 0);

      assert.deepStrictEqual(
        live.rulesets.map(({ name }) => name),
        ["main"],
      );
      assert.deepStrictEqual(
        live.labels.map(({ name }) => name),
        [...LABELS],
      );
      assert.deepStrictEqual(sorted(live.variables.keys()), [
        "BRANCH_PROTECTION",
        "ENVIRONMENTS",
        "PREVIEW_ON",
        "RELEASE_ON",
      ]);
      assert.deepStrictEqual(sorted(live.environments), ["prod", "prod-destructive"]);

      assert.isTrue(actions.length > 0);
      assert.isTrue(actions.every(({ action }) => action === "create"));
    }),
  );

  it.effect("sends the repository only its governed fields and keeps the rest", () =>
    Effect.gen(function* governed() {
      const fake = createFakeGitHub();

      yield* converge(fake, plan);

      const [patch] = where(fake.calls, "PATCH", new RegExp(`^${REPO_PATH}$`, "u"));
      const body = keysOf(patch?.body);

      for (const key of ["private", "description", "is_template", "visibility", "homepage"]) {
        assert.notInclude(body, key);
      }

      const live = fake.state().repository;

      assert.strictEqual(live.allow_squash_merge, true);
      assert.strictEqual(live.allow_merge_commit, false);
      assert.strictEqual(live.allow_rebase_merge, false);
      assert.strictEqual(live.delete_branch_on_merge, true);
      assert.strictEqual(live.allow_auto_merge, true);
      assert.strictEqual(live.private, true);
      assert.strictEqual(live.description, "keep me");
      assert.strictEqual(live.is_template, false);
    }),
  );

  it.effect("leaves live state matching the declaration, per readDrift", () =>
    Effect.gen(function* clean() {
      const fake = createFakeGitHub();

      yield* converge(fake, plan);

      assert.deepStrictEqual(yield* drift(fake), []);
    }),
  );

  it.effect("sends no POST, DELETE or ruleset PUT on a second run and keeps every id", () =>
    Effect.gen(function* secondRun() {
      const fake = createFakeGitHub();

      yield* converge(fake, plan);

      const before = fake.state();
      const since = fake.calls.length;
      const actions = yield* converge(fake, plan);
      const calls = after(fake.calls, since);
      const live = fake.state();

      assert.deepStrictEqual(where(calls, "POST", /./u), []);
      assert.deepStrictEqual(where(calls, "DELETE", /./u), []);
      assert.deepStrictEqual(where(calls, "PUT", /\/rulesets/u), []);

      assert.deepStrictEqual(
        live.rulesets.map(({ id }) => id),
        before.rulesets.map(({ id }) => id),
      );
      assert.deepStrictEqual(
        live.labels.map(({ id }) => id),
        before.labels.map(({ id }) => id),
      );
      assert.deepStrictEqual(live.environments, before.environments);
      assert.deepStrictEqual(live.variables, before.variables);

      assert.isTrue(actions.every(({ action }) => action !== "replace" && action !== "delete"));
      assert.deepStrictEqual(yield* drift(fake), []);
    }),
  );

  it.effect("takes over a differing main ruleset in place with one PUT", () =>
    Effect.gen(function* takeover() {
      const first = createFakeGitHub();

      yield* converge(first, plan);

      const fake = createFakeGitHub({
        rulesets: [
          {
            bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
            conditions: { ref_name: { exclude: [], include: ["~ALL"] } },
            enforcement: "evaluate",
            name: "main",
            rules: [{ type: "deletion" }],
            target: "branch",
          },
        ],
      });

      const [seeded] = fake.state().rulesets;

      assert.isDefined(seeded);

      const actions = yield* converge(fake, plan);
      const live = fake.state().rulesets;
      const [desired] = first.state().rulesets;

      assert.strictEqual(live.length, 1);
      assert.strictEqual(live[0]?.id, seeded?.id);

      const puts = where(fake.calls, "PUT", /\/rulesets\/\d+$/u);

      assert.strictEqual(puts.length, 1);
      assert.strictEqual(puts[0]?.path, `${REPO_PATH}/rulesets/${seeded?.id}`);
      assert.deepStrictEqual(puts[0]?.body, {
        bypass_actors: [],
        conditions: desired?.conditions,
        enforcement: "active",
        name: "main",
        rules: desired?.rules,
        target: "branch",
      });
      assert.deepStrictEqual(where(fake.calls, "POST", /\/rulesets/u), []);
      assert.deepStrictEqual(where(fake.calls, "DELETE", /./u), []);
      assert.isTrue(
        actions.some(({ action, logicalId }) => logicalId === "main" && action === "adopted"),
      );
      assert.deepStrictEqual(yield* drift(fake), []);
    }),
  );

  it.effect("repairs a widened merge method with a PUT to the same ruleset", () =>
    Effect.gen(function* widened() {
      const first = createFakeGitHub();

      yield* converge(first, plan);

      const fake = createFakeGitHub(
        seedFrom(first, (ruleset) => ({
          ...ruleset,
          rules: ruleset.rules.map(widen),
        })),
      );

      const [seeded] = fake.state().rulesets;

      assert.deepStrictEqual(mergeMethods(seeded), ["merge", "squash", "rebase"]);
      assert.include(
        yield* drift(fake),
        "MISMATCH main ruleset merge methods: live merge,rebase,squash, declared squash",
      );

      yield* converge(fake, plan);

      const puts = where(fake.calls, "PUT", /\/rulesets\/\d+$/u);
      const live = fake.state().rulesets;

      assert.strictEqual(puts.length, 1);
      assert.strictEqual(live[0]?.id, seeded?.id);
      assert.deepStrictEqual(mergeMethods(live[0]), ["squash"]);
      assert.deepStrictEqual(where(fake.calls, "POST", /\/rulesets/u), []);
      assert.deepStrictEqual(where(fake.calls, "DELETE", /./u), []);
      assert.deepStrictEqual(yield* drift(fake), []);
    }),
  );

  it.effect("creates a renamed label once, deletes nothing and leaves the old one undeclared", () =>
    Effect.gen(function* renamed() {
      const fake = createFakeGitHub();

      const previous = {
        ...plan,
        labels: plan.labels.map((label) =>
          label.name === "bug" ? { ...label, name: "defect" } : label,
        ),
      };

      yield* converge(fake, previous);

      assert.deepStrictEqual(yield* drift(fake), ["UNDECLARED label defect", "MISSING label bug"]);

      const since = fake.calls.length;
      const actions = yield* converge(fake, plan);
      const calls = after(fake.calls, since);

      assert.deepStrictEqual(lines(where(calls, "POST", /./u)), [`POST ${REPO_PATH}/labels`]);
      assert.deepStrictEqual(where(calls, "POST", /./u)[0]?.body, { name: "bug" });
      assert.deepStrictEqual(where(calls, "DELETE", /./u), []);
      assert.isTrue(actions.every(({ action }) => action !== "replace" && action !== "delete"));

      assert.include(
        fake.state().labels.map(({ name }) => name),
        "defect",
      );
      assert.deepStrictEqual(yield* drift(fake), ["UNDECLARED label defect"]);
    }),
  );
});
