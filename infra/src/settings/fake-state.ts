import { Function, Option, Predicate, Schema } from "effect";
import {
  API,
  NOW,
  OWNER,
  REPO,
  REPO_PATH,
  account,
  created,
  invalid,
  noContent,
  notFound,
  ok,
  policyBody,
  readBody,
  repositoryDefaults,
} from "./github-defaults.ts";
import type { JsonRecord, Reply } from "./github-defaults.ts";

/**
 * A stateful model of the GitHub REST API paths the settings stack touches: repository, rulesets,
 * environments, labels and Actions variables. It keeps what a client writes, so a second run reads
 * what the first created, which a canned-reply fake cannot show. It answers in the shape the
 * `@distilled.cloud/github` response schemas decode, and records every request.
 *
 * It is a model, not GitHub: a real ruleset PUT may normalize the stored rules, and this model
 * stores them exactly as sent, so a branch that depends on GitHub rewriting a payload stays
 * unobserved.
 */

/**
 * One recorded request: the method, path, query string and decoded JSON body.
 */
export interface Call {
  readonly body: Schema.Json;
  readonly method: string;
  readonly path: string;
  readonly search: string;
}

/**
 * The body of a ruleset POST or PUT. The rules and conditions stay raw JSON: the model stores them
 * exactly as sent, because the provider compares what it reads back with what it wrote.
 */
const RulesetBody = Schema.Struct({
  bypass_actors: Schema.Array(Schema.Json),
  conditions: Schema.Json,
  enforcement: Schema.String,
  name: Schema.String,
  rules: Schema.Array(Schema.Json),
  target: Schema.String,
});

export type RulesetInput = typeof RulesetBody.Type;

/**
 * A stored ruleset.
 */
export type FakeRuleset = RulesetInput & { readonly id: number };

/**
 * The body of a label POST or PATCH.
 */
const LabelInput = Schema.Struct({
  color: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});

/**
 * A stored label.
 */
export interface FakeLabel {
  readonly color: string;
  readonly description: string | null;
  readonly id: number;
  readonly name: string;
}

/**
 * The body of a variable POST or PATCH.
 */
const VariableInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  value: Schema.String,
});

/**
 * The body of a deployment branch policy POST.
 */
const PolicyInput = Schema.Struct({ name: Schema.String });

/**
 * The body of a repository PATCH: any fields, each a JSON value.
 */
const RepositoryPatch = Schema.Record(Schema.String, Schema.Json);

/**
 * What a test seeds before the first request; every field is optional.
 */
export interface Seed {
  readonly labels?: ReadonlyArray<{
    readonly color?: string;
    readonly description?: string;
    readonly name: string;
  }>;
  readonly repository?: JsonRecord;
  readonly rulesets?: ReadonlyArray<RulesetInput>;
}

/**
 * Build the fake: its `fetch`, the request log and a read of the stored state.
 *
 * @param seed - What exists before the first request.
 * @returns The `fetch` to provide as `FetchHttpClient.Fetch`, the recorded calls and `state`.
 */
export const createFakeGitHub = (seed: Seed = {}) => {
  const calls: Array<Call> = [];
  let nextId = 1000;
  let repository = { ...repositoryDefaults, ...seed.repository };
  const rulesets = new Map<number, FakeRuleset>();
  const labels = new Map<string, FakeLabel>();
  const variables = new Map<string, string>();
  const environments = new Map<string, number>();
  const policies = new Map<string, Map<number, string>>();

  const id = () => {
    nextId += 1;

    return nextId;
  };

  for (const ruleset of seed.rulesets ?? []) {
    const stored = { ...ruleset, id: id() };

    rulesets.set(stored.id, stored);
  }

  for (const label of seed.labels ?? []) {
    labels.set(label.name, {
      color: label.color ?? "ededed",
      description: label.description ?? null,
      id: id(),
      name: label.name,
    });
  }

  const rulesetBody = (stored: FakeRuleset) =>
    ({
      ...stored,
      _links: {},
      created_at: NOW,
      current_user_can_bypass: "never",
      node_id: `RRS_${stored.id}`,
      source: `${OWNER}/${REPO}`,
      source_type: "Repository",
      updated_at: NOW,
    }) satisfies Schema.Json;

  const labelBody = (stored: FakeLabel) =>
    ({
      ...stored,
      default: false,
      node_id: `L_${stored.id}`,
      url: `${API}${REPO_PATH}/labels/${encodeURIComponent(stored.name)}`,
    }) satisfies Schema.Json;

  const environmentBody = (name: string) => {
    const environmentId = environments.get(name) ?? 0;

    return {
      created_at: NOW,
      html_url: `https://github.com${REPO_PATH}/deployments/${name}`,
      id: environmentId,
      name,
      node_id: `E_${environmentId}`,
      protection_rules: [],
      updated_at: NOW,
      url: `${API}${REPO_PATH}/environments/${name}`,
    } satisfies Schema.Json;
  };

  const rulesetRoute: (method: string, tail: ReadonlyArray<string>, body: Schema.Json) => Reply = (
    method,
    tail,
    body,
  ) => {
    const [first] = tail;
    const input = Schema.decodeUnknownOption(RulesetBody)(body);

    if (first === undefined && method === "GET") {
      return ok([...rulesets.values()].map(rulesetBody));
    }

    if (first === undefined) {
      if (Option.isNone(input)) {
        return invalid;
      }

      const stored = { ...input.value, id: id() };

      rulesets.set(stored.id, stored);

      return created(rulesetBody(stored));
    }

    const found = rulesets.get(Number(first));

    if (found === undefined) {
      return notFound;
    }

    if (method === "PUT") {
      if (Option.isNone(input)) {
        return invalid;
      }

      const stored = { ...input.value, id: found.id };

      rulesets.set(found.id, stored);

      return ok(rulesetBody(stored));
    }

    if (method === "DELETE") {
      rulesets.delete(found.id);

      return noContent;
    }

    return ok(rulesetBody(found));
  };

  const environmentRoute: (
    method: string,
    tail: ReadonlyArray<string>,
    body: Schema.Json,
  ) => Reply = (method, tail, body) => {
    const [name, segment, policy] = tail;

    if (name === undefined) {
      return ok({
        environments: [...environments.keys()].map(environmentBody),
        total_count: environments.size,
      });
    }

    if (segment === undefined) {
      environments.set(name, environments.get(name) ?? id());

      return ok(environmentBody(name));
    }

    const own = policies.get(name) ?? new Map<number, string>();

    policies.set(name, own);

    if (method === "GET") {
      return ok({
        branch_policies: [...own].map(([policyId, pattern]) => policyBody(policyId, pattern)),
        total_count: own.size,
      });
    }

    if (method === "POST") {
      const input = Schema.decodeUnknownOption(PolicyInput)(body);

      if (Option.isNone(input)) {
        return invalid;
      }

      const policyId = id();

      own.set(policyId, input.value.name);

      return created(policyBody(policyId, input.value.name));
    }

    own.delete(Number(policy));

    return noContent;
  };

  const labelRoute: (method: string, tail: ReadonlyArray<string>, body: Schema.Json) => Reply = (
    method,
    tail,
    body,
  ) => {
    const [encoded] = tail;
    const input = Schema.decodeUnknownOption(LabelInput)(body);

    if (encoded === undefined && method === "GET") {
      return ok([...labels.values()].map(labelBody));
    }

    if (encoded === undefined) {
      if (Option.isNone(input) || input.value.name === undefined) {
        return invalid;
      }

      const stored = {
        color: input.value.color ?? "ededed",
        description: input.value.description ?? null,
        id: id(),
        name: input.value.name,
      };

      labels.set(stored.name, stored);

      return created(labelBody(stored));
    }

    const name = decodeURIComponent(encoded);
    const found = labels.get(name);

    if (found === undefined) {
      return notFound;
    }

    if (method === "PATCH") {
      const stored = {
        ...found,
        color: Option.flatMapNullishOr(input, (value) => value.color).pipe(
          Option.getOrElse(() => found.color),
        ),
        description: Option.flatMapNullishOr(input, (value) => value.description).pipe(
          Option.getOrElse(() => found.description),
        ),
      };

      labels.set(name, stored);

      return ok(labelBody(stored));
    }

    if (method === "DELETE") {
      labels.delete(name);

      return noContent;
    }

    return ok(labelBody(found));
  };

  const variableRoute: (method: string, tail: ReadonlyArray<string>, body: Schema.Json) => Reply = (
    method,
    tail,
    body,
  ) => {
    const [name] = tail;
    const input = Schema.decodeUnknownOption(VariableInput)(body);

    if (name === undefined && method === "GET") {
      return ok({
        total_count: variables.size,
        variables: [...variables].map(([key, value]) => ({
          created_at: NOW,
          name: key,
          updated_at: NOW,
          value,
        })),
      });
    }

    if (name === undefined) {
      if (Option.isNone(input) || input.value.name === undefined) {
        return invalid;
      }

      variables.set(input.value.name, input.value.value);

      return created({});
    }

    const value = variables.get(name);

    if (value === undefined) {
      return notFound;
    }

    if (method === "PATCH" && Option.isSome(input)) {
      variables.set(name, input.value.value);

      return noContent;
    }

    if (method === "DELETE") {
      variables.delete(name);

      return noContent;
    }

    return ok({ created_at: NOW, name, updated_at: NOW, value });
  };

  const route: (method: string, path: string, body: Schema.Json) => Reply = (
    method,
    path,
    body,
  ) => {
    if (path === "/user") {
      return ok({ ...account, plan: { name: "pro" } });
    }

    if (path === `${REPO_PATH}/actions/secrets`) {
      return ok({ secrets: [], total_count: 0 });
    }

    if (path === REPO_PATH && method === "GET") {
      return ok(repository);
    }

    if (path === REPO_PATH && method === "PATCH") {
      const patch = Schema.decodeUnknownOption(RepositoryPatch)(body);

      if (Option.isNone(patch)) {
        return invalid;
      }

      repository = { ...repository, ...patch.value };

      return ok(repository);
    }

    const [area, ...tail] = path.split("/").slice(4);

    if (area === "rulesets") {
      return rulesetRoute(method, tail, body);
    }

    if (area === "environments") {
      return environmentRoute(method, tail, body);
    }

    if (area === "labels") {
      return labelRoute(method, tail, body);
    }

    return area === "actions" && tail[0] === "variables"
      ? variableRoute(method, tail.slice(1), body)
      : notFound;
  };

  const handle = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(Predicate.hasProperty(input, "url") ? input.url : input);
    const method = init?.method ?? "GET";
    const body = readBody(init);

    calls.push({ body, method, path: url.pathname, search: url.search });

    const reply = route(method, url.pathname, body);

    return Promise.resolve(
      new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), {
        headers: { "content-type": "application/json" },
        status: reply.status,
      }),
    );
  };

  return {
    calls,
    fetch: Object.assign(handle, { preconnect: Function.constVoid }),
    state: () => ({
      environments: [...environments.keys()],
      labels: [...labels.values()],
      repository,
      rulesets: [...rulesets.values()],
      variables: new Map(variables),
    }),
  };
};
