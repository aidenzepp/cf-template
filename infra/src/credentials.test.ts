import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Console, Effect, Option } from "effect";
import bootstrapStack, {
  BOOTSTRAP_SECRETS,
  BOOTSTRAP_VARIABLES,
  CI_TOKEN_PERMISSION_GROUPS,
  bootstrapInputs,
  ciTokenPolicies,
} from "../stacks/bootstrap.ts";
import {
  CredentialsError,
  NO_STACK_NAME,
  PLAN_PAGE,
  SpinUp,
  collision,
  credentials,
  decidePin,
  parseArguments,
  permissionPreflight,
  planOf,
  workersPlan,
} from "./credentials.ts";
import type {
  DeployInput,
  FrozenIdentity,
  Plan,
  ReadProbe,
  RepositoryView,
} from "./credentials.ts";

/**
 * The repository every fake run targets. The id and shapes are inferred from the GitHub REST
 * documentation, not observed.
 */
const LIVE: RepositoryView = { admin: true, fullName: "acme/widget", id: 4242 };

/**
 * What the fake answers. Every field has a passing default.
 */
interface World {
  readonly bun: string;
  readonly denied: ReadonlyArray<ReadProbe>;
  readonly pin: string;
  readonly repository: Option.Option<RepositoryView>;
  readonly profiles: ReadonlyArray<string>;
  readonly detector: Option.Option<Plan>;
  readonly variables: ReadonlyMap<string, string>;
  readonly secrets: ReadonlyArray<string>;
  readonly names: ReadonlyArray<string>;
  readonly record: Option.Option<FrozenIdentity>;
}

/**
 * A finished bootstrap's repository values.
 */
const WRITTEN = new Map([
  ["STACK_NAME", "widget"],
  ["CUSTOM_DOMAIN", "workers-dev"],
  ["CLOUDFLARE_DEPLOYS", "true"],
  ["CLOUDFLARE_WORKERS_SUBDOMAIN", "acme-sub"],
]);

const DEFAULTS: World = {
  bun: "1.4.3",
  denied: [],
  detector: Option.some("paid"),
  names: [],
  pin: "1.4.3",
  profiles: ["default", "admin"],
  record: Option.none(),
  repository: Option.some(LIVE),
  secrets: [...BOOTSTRAP_SECRETS],
  variables: new Map(),
};

/**
 * The configuration of a run on {@link LIVE} with the stack name `widget`.
 */
const REPOSITORY_CONFIG = {
  GITHUB_REPOSITORY: "acme/widget",
  STACK_NAME: "widget",
} satisfies Record<string, string>;

/**
 * Run an effect against a fake {@link SpinUp} that records every call, offline, under
 * `ConfigProvider.fromUnknown`.
 *
 * @param effect - The effect to run.
 * @param overrides - The answers that differ from {@link DEFAULTS}.
 * @param config - The configuration entries.
 * @returns The exit, the recorded calls, the deploy inputs and the printed lines.
 */
const harness = <A>(
  effect: Effect.Effect<A, CredentialsError, SpinUp>,
  overrides: Partial<World> = {},
  config: Record<string, string> = REPOSITORY_CONFIG,
) => {
  const world = { ...DEFAULTS, ...overrides };
  const calls: Array<string> = [];
  const deploys: Array<DeployInput> = [];
  const lines: Array<string> = [];
  let deployed = false;

  const record = <B>(call: string, value: Effect.Effect<B, CredentialsError>) =>
    Effect.suspend(() => {
      calls.push(call);

      return value;
    });

  const spinUp = SpinUp.of({
    accountNames: () => record("accountNames", Effect.succeed(world.names)),
    bunPin: record("bunPin", Effect.succeed(world.pin)),
    bunVersion: record("bunVersion", Effect.succeed(world.bun)),
    canRead: (_profile, group) =>
      record(`canRead:${group}`, Effect.succeed(!world.denied.includes(group))),
    deploy: (input) =>
      record(
        "deploy",
        Effect.sync(() => {
          deploys.push(input);
          deployed = true;
        }),
      ),
    detectPlan: () =>
      record(
        "detectPlan",
        Effect.fromOption(world.detector).pipe(
          Effect.mapError(() => new CredentialsError({ message: "no answer" })),
        ),
      ),
    profiles: record("profiles", Effect.succeed(world.profiles)),
    record: () => record("record", Effect.succeed(world.record)),
    repository: () => Effect.sync(() => calls.push("repository")).pipe(Effect.as(world.repository)),
    secrets: () => record("secrets", Effect.succeed(world.secrets)),
    stateBootstrap: () => record("stateBootstrap", Effect.void),
    variables: () =>
      record(
        "variables",
        Effect.sync(() => (deployed ? WRITTEN : world.variables)),
      ),
    workersSubdomain: () => record("workersSubdomain", Effect.succeed("acme-sub")),
  });

  const run = effect.pipe(
    Effect.provideService(SpinUp, spinUp),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ STACK_NAME_ORIGIN_COMMAND: "false", ...config }),
      ),
    ),
    Effect.provideService(Console.Console, {
      ...globalThis.console,
      log: (...args: ReadonlyArray<unknown>) => {
        lines.push(args.join(" "));
      },
    }),
    Effect.exit,
  );

  return { calls, deploys, lines, run };
};

/**
 * Run the credentials half and return its failure message.
 *
 * @param overrides - The answers that differ from {@link DEFAULTS}.
 * @param force - Whether `--force` is passed.
 * @returns The failure message and the recorded calls.
 */
const refusal = (overrides: Partial<World>, force = false) =>
  Effect.gen(function* refused() {
    const { calls, run } = harness(credentials({ force, profile: "admin" }), overrides);
    const exit = yield* run;

    assert.isTrue(exit._tag === "Failure");

    const error = yield* Effect.flip(Effect.flatten(Effect.succeed(exit)));

    return { calls, message: error.message };
  });

/**
 * Whether any write ran: the state bootstrap or the deploy.
 *
 * @param calls - The recorded calls.
 * @returns True when nothing was written.
 */
const noWrite = (calls: ReadonlyArray<string>) =>
  !calls.includes("stateBootstrap") && !calls.includes("deploy");

describe("preflight refusals", () => {
  it.effect("refuses a Bun that is not the packageManager pin, naming the runbook", () =>
    Effect.gen(function* bun() {
      const { calls, message } = yield* refusal({ bun: "1.3.0" });

      assert.include(message, "Bun 1.3.0 is running but package.json pins bun@1.4.3");
      assert.include(message, "docs/spin-up.md, Prerequisites");
      assert.isTrue(noWrite(calls));
    }),
  );

  it.effect("refuses when the repository read does not answer 200", () =>
    Effect.gen(function* unreadable() {
      const { calls, message } = yield* refusal({ repository: Option.none() });

      assert.include(message, "GET /repos/acme/widget did not answer 200 with permissions.admin");
      assert.include(message, "step 1");
      assert.isTrue(noWrite(calls));
    }),
  );

  it.effect("refuses a token without admin permission", () =>
    Effect.gen(function* notAdmin() {
      const { message } = yield* refusal({ repository: Option.some({ ...LIVE, admin: false }) });

      assert.include(message, "gh auth login");
    }),
  );

  it.effect("refuses when an Alchemy profile is missing", () =>
    Effect.gen(function* profile() {
      const { calls, message } = yield* refusal({ profiles: ["default"] });

      assert.include(message, "The Alchemy profile `admin` is missing");
      assert.include(message, "step 1");
      assert.isTrue(noWrite(calls));
    }),
  );

  it.effect("refuses a Free account with the plan page and the two facts", () =>
    Effect.gen(function* free() {
      const { calls, message } = yield* refusal({ detector: Option.some("free") });

      assert.include(message, PLAN_PAGE);
      assert.include(message, "10 ms");
      assert.include(message, "115 ms");
      assert.isTrue(noWrite(calls));
    }),
  );

  it.effect("stops before any API call when no source names the stack", () =>
    Effect.gen(function* unnamed() {
      const { calls, run } = harness(credentials({ force: false, profile: "admin" }), {}, {});
      const exit = yield* run;
      const error = yield* Effect.flip(Effect.flatten(Effect.succeed(exit)));

      assert.include(error.message, NO_STACK_NAME);
      assert.deepStrictEqual(calls, []);
    }),
  );
});

describe("the admin token permission preflight", () => {
  const cases = [
    ["workers", "Workers Scripts Edit"],
    ["d1", "D1 Read"],
    ["secrets-store", "Secrets Store Edit"],
  ] as const;

  for (const [group, name] of cases) {
    it.effect(`a denied ${group} read names ${name} and the step, before any write`, () =>
      Effect.gen(function* denied() {
        const { calls, message } = yield* refusal({ denied: [group] });

        assert.include(message, name);
        assert.include(message, "docs/spin-up.md, Once per machine, step 1");
        assert.isTrue(noWrite(calls));
        assert.isFalse(calls.includes("accountNames"));
      }),
    );
  }

  it.effect("all three reads answering lets the run continue to the write", () =>
    Effect.gen(function* allowed() {
      const { calls, run } = harness(permissionPreflight("admin"));
      const exit = yield* run;

      assert.strictEqual(exit._tag, "Success");
      assert.deepStrictEqual(calls, ["canRead:workers", "canRead:d1", "canRead:secrets-store"]);

      const full = harness(credentials({ force: false, profile: "admin" }));

      yield* full.run;
      assert.isTrue(
        full.calls.indexOf("canRead:secrets-store") < full.calls.indexOf("stateBootstrap"),
      );
    }),
  );
});

describe("the Workers plan: detector, then knob", () => {
  it.effect("does not read the knob when the detector answers", () =>
    Effect.gen(function* detected() {
      const { run } = harness(workersPlan("admin"), {}, { CLOUDFLARE_PLAN: "not-a-plan" });
      const exit = yield* run;

      assert.deepStrictEqual(exit._tag === "Success" ? exit.value : undefined, "paid");
    }),
  );

  it.effect("reads the knob when the detector fails", () =>
    Effect.gen(function* knob() {
      const { run } = harness(
        workersPlan("admin"),
        { detector: Option.none() },
        { CLOUDFLARE_PLAN: "free" },
      );

      const exit = yield* run;

      assert.deepStrictEqual(exit._tag === "Success" ? exit.value : undefined, "free");
    }),
  );

  it.effect("defaults the knob to paid when the detector fails and the knob is unset", () =>
    Effect.gen(function* defaulted() {
      const { run } = harness(workersPlan("admin"), { detector: Option.none() }, {});
      const exit = yield* run;

      assert.deepStrictEqual(exit._tag === "Success" ? exit.value : undefined, "paid");
    }),
  );

  it("reads a Workers rate plan from the subscriptions (inferred shape)", () => {
    assert.deepStrictEqual(
      planOf([{ price: 5, ratePlan: { id: "workers_paid", publicName: "Workers Paid" } }]),
      Option.some("paid"),
    );

    assert.deepStrictEqual(
      planOf([{ price: 0, ratePlan: { publicName: "Workers Free" } }]),
      Option.some("free"),
    );

    assert.deepStrictEqual(planOf([{ ratePlan: { id: "pro" } }]), Option.none());
  });
});

describe("the re-run table", () => {
  it.effect("first run: no pin and no record runs the collision check and declares live", () =>
    Effect.gen(function* first() {
      const { calls, deploys, lines, run } = harness(
        credentials({ force: false, profile: "admin" }),
      );

      const exit = yield* run;

      assert.strictEqual(exit._tag, "Success");
      assert.deepStrictEqual(deploys, [
        {
          customDomain: "workers-dev",
          repository: "acme/widget",
          repositoryId: 4242,
          stack: "widget",
          subdomain: "acme-sub",
        },
      ]);

      assert.isFalse(calls.includes("record"));
      assert.isTrue(calls.indexOf("stateBootstrap") < calls.indexOf("deploy"));
      assert.include(lines, "STACK_NAME=widget");
      assert.include(lines, "CLOUDFLARE_WORKERS_SUBDOMAIN=acme-sub");
    }),
  );

  it.effect("pin present with a matching id declares the live pin and the frozen identity", () =>
    Effect.gen(function* resume() {
      const { calls, deploys, run } = harness(credentials({ force: false, profile: "admin" }), {
        names: ["kept-state", "kept-api-prod"],
        record: Option.some({ repository: "acme/old-name", repositoryId: 4242 }),
        variables: new Map([
          ["STACK_NAME", "kept"],
          ["CUSTOM_DOMAIN", "app.example.com"],
        ]),
      });

      const exit = yield* run;

      assert.strictEqual(exit._tag, "Success");
      assert.isTrue(calls.includes("record"));
      assert.strictEqual(deploys[0]?.stack, "kept");
      assert.strictEqual(deploys[0]?.repository, "acme/old-name");
      assert.strictEqual(deploys[0]?.customDomain, "app.example.com");
      assert.isTrue(calls.includes("stateBootstrap"));
    }),
  );

  it.effect("pin present with another id refuses before any write", () =>
    Effect.gen(function* idChanged() {
      const { calls, message } = yield* refusal({
        names: ["kept-state"],
        record: Option.some({ repository: "acme/widget", repositoryId: 1 }),
        variables: new Map([["STACK_NAME", "kept"]]),
      });

      assert.include(message, "differs from id 1 frozen in kept-bootstrap");
      assert.include(message, "--force");
      assert.isTrue(noWrite(calls));
    }),
  );

  it.effect("pin present with another id declares the live identity under --force", () =>
    Effect.gen(function* forced() {
      const { deploys, run } = harness(credentials({ force: true, profile: "admin" }), {
        names: ["kept-state"],
        record: Option.some({ repository: "acme/widget", repositoryId: 1 }),
        variables: new Map([["STACK_NAME", "kept"]]),
      });

      yield* run;

      assert.strictEqual(deploys[0]?.repositoryId, 4242);
    }),
  );

  it.effect("pin absent with a record is a hand deletion and refuses unless --force", () =>
    Effect.gen(function* handDeletion() {
      const { calls, message } = yield* refusal({
        names: ["widget-state"],
        record: Option.some({ repository: "acme/widget", repositoryId: 4242 }),
      });

      assert.include(message, "deleted by hand");
      assert.isTrue(noWrite(calls));
    }),
  );

  it.effect("pin present with no record refuses unless --force", () =>
    Effect.gen(function* lostRecord() {
      const { message } = yield* refusal({ variables: new Map([["STACK_NAME", "kept"]]) });

      assert.include(message, "holds no kept-bootstrap record");
    }),
  );

  it.effect("read back fails when a written value is missing", () =>
    Effect.gen(function* missing() {
      const { message } = yield* refusal({ secrets: ["CLOUDFLARE_API_TOKEN"] });

      assert.include(message, "Read back failed: CLOUDFLARE_ACCOUNT_ID missing on acme/widget");
    }),
  );

  it.effect("decidePin skips the collision check on a resume", () =>
    Effect.gen(function* decision() {
      const resumed = yield* decidePin({
        derived: "widget",
        force: false,
        live: LIVE,
        pin: Option.some("widget"),
        record: Option.some({ repository: "acme/widget", repositoryId: 4242 }),
      });

      assert.strictEqual(resumed.kind, "resume");
    }),
  );
});

describe("the collision rule", () => {
  it.effect("refuses a <stack>- Worker or D1 database by name", () =>
    Effect.gen(function* taken() {
      const error = yield* Effect.flip(collision("widget", ["widget-api-prod"], false));

      assert.include(error.message, "widget-api-prod already exists on the account");
    }),
  );

  it.effect("treats the store holding this bootstrap's record as a resume", () =>
    Effect.gen(function* resumed() {
      assert.strictEqual(yield* collision("widget", ["widget-state"], true), "resume");
    }),
  );

  it.effect("refuses the store with no record, naming the two repairs", () =>
    Effect.gen(function* orphan() {
      const error = yield* Effect.flip(collision("widget", ["widget-state"], false));

      assert.include(error.message, "Destroy widget-state if it is a leftover");
      assert.include(error.message, "choose another name with STACK_NAME");
    }),
  );

  it.effect("passes when no <stack>- name exists", () =>
    Effect.gen(function* clear() {
      assert.strictEqual(yield* collision("widget", [], false), "clear");
    }),
  );
});

describe("the bootstrap stack inputs", () => {
  it("scopes the CI token to the six permission groups on the account", () => {
    assert.deepStrictEqual(ciTokenPolicies("acct"), [
      {
        effect: "allow",
        permissionGroups: [...CI_TOKEN_PERMISSION_GROUPS],
        resources: { "com.cloudflare.api.account.acct": "*" },
      },
    ]);

    assert.deepStrictEqual(BOOTSTRAP_VARIABLES, [
      "STACK_NAME",
      "CUSTOM_DOMAIN",
      "CLOUDFLARE_DEPLOYS",
      "CLOUDFLARE_WORKERS_SUBDOMAIN",
    ]);
  });

  it.effect("decodes the deploy inputs and defaults CUSTOM_DOMAIN to workers-dev", () =>
    Effect.gen(function* inputs() {
      const decoded = yield* bootstrapInputs.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              BOOTSTRAP_REPOSITORY: "acme/widget",
              BOOTSTRAP_REPOSITORY_ID: "4242",
              CLOUDFLARE_WORKERS_SUBDOMAIN: "acme-sub",
              STACK_NAME: "widget",
            }),
          ),
        ),
      );

      assert.strictEqual(decoded.customDomain, "workers-dev");
      assert.strictEqual(decoded.repositoryId, 4242);
    }),
  );

  it("exports the stack as the Alchemy entry's default", () => {
    assert.isTrue(Effect.isEffect(bootstrapStack));
  });

  it("reads --profile and --force", () => {
    assert.deepStrictEqual(parseArguments(["--profile", "admin", "--force"]), {
      force: true,
      profile: "admin",
    });
  });
});
