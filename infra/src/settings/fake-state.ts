import { Function, Option, Predicate, Schema } from "effect";

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
 * A JSON object, as a plain record so it can be spread.
 */
export type JsonRecord = Readonly<Record<string, Schema.Json>>;

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
 * The repository every fake run targets.
 */
export const OWNER = "acme";

export const REPO = "widget";

/**
 * The API path of the fake repository.
 */
export const REPO_PATH = `/repos/${OWNER}/${REPO}`;

const NOW = "2026-01-01T00:00:00Z";

const API = "https://api.github.com";

/**
 * The `*_url` fields a full repository carries; each is required by the response schema.
 */
const REPOSITORY_URL_FIELDS = [
  "archive_url",
  "assignees_url",
  "blobs_url",
  "branches_url",
  "collaborators_url",
  "comments_url",
  "commits_url",
  "compare_url",
  "contents_url",
  "contributors_url",
  "deployments_url",
  "downloads_url",
  "events_url",
  "forks_url",
  "git_commits_url",
  "git_refs_url",
  "git_tags_url",
  "hooks_url",
  "issue_comment_url",
  "issue_events_url",
  "issues_url",
  "keys_url",
  "labels_url",
  "languages_url",
  "merges_url",
  "milestones_url",
  "notifications_url",
  "pulls_url",
  "releases_url",
  "stargazers_url",
  "statuses_url",
  "subscribers_url",
  "subscription_url",
  "tags_url",
  "teams_url",
  "trees_url",
] as const;

/**
 * The `*_url` fields of an account object.
 */
const ACCOUNT_URL_FIELDS = [
  "avatar_url",
  "events_url",
  "followers_url",
  "following_url",
  "gists_url",
  "html_url",
  "organizations_url",
  "received_events_url",
  "repos_url",
  "starred_url",
  "subscriptions_url",
  "url",
] as const;

const urlFields = (fields: ReadonlyArray<string>, base: string) =>
  Object.fromEntries(fields.map((field) => [field, `${base}/${field}`])) satisfies JsonRecord;

/**
 * The account object a repository owner carries.
 */
const account = {
  gravatar_id: "",
  id: 1,
  login: OWNER,
  node_id: "U_1",
  site_admin: false,
  type: "User",
  ...urlFields(ACCOUNT_URL_FIELDS, `${API}/users/${OWNER}`),
} satisfies JsonRecord;

/**
 * The repository the fake starts with: private, all three merge methods open, delete-on-merge off.
 */
const repositoryDefaults = {
  allow_auto_merge: false,
  allow_merge_commit: true,
  allow_rebase_merge: true,
  allow_squash_merge: true,
  archived: false,
  clone_url: `https://github.com/${OWNER}/${REPO}.git`,
  created_at: NOW,
  default_branch: "main",
  delete_branch_on_merge: false,
  description: "keep me",
  disabled: false,
  fork: false,
  forks: 0,
  forks_count: 0,
  full_name: `${OWNER}/${REPO}`,
  git_url: `git://github.com/${OWNER}/${REPO}.git`,
  has_discussions: false,
  has_downloads: true,
  has_issues: true,
  has_pages: false,
  has_projects: true,
  has_wiki: true,
  homepage: null,
  html_url: `https://github.com/${OWNER}/${REPO}`,
  id: 100,
  is_template: false,
  language: null,
  mirror_url: null,
  name: REPO,
  network_count: 0,
  node_id: "R_100",
  open_issues: 0,
  open_issues_count: 0,
  owner: account,
  permissions: { admin: true, maintain: true, pull: true, push: true, triage: true },
  private: true,
  pushed_at: NOW,
  size: 0,
  ssh_url: `git@github.com:${OWNER}/${REPO}.git`,
  stargazers_count: 0,
  subscribers_count: 0,
  svn_url: `https://github.com/${OWNER}/${REPO}`,
  topics: [],
  updated_at: NOW,
  url: `${API}${REPO_PATH}`,
  visibility: "private",
  watchers: 0,
  watchers_count: 0,
  ...urlFields(REPOSITORY_URL_FIELDS, `${API}${REPO_PATH}`),
} satisfies JsonRecord;

/**
 * A reply: a status and a JSON body.
 */
interface Reply {
  readonly body?: Schema.Json;
  readonly status: number;
}

const ok = (body: Schema.Json) => ({ body, status: 200 }) satisfies Reply;

const created = (body: Schema.Json) => ({ body, status: 201 }) satisfies Reply;

const noContent: Reply = { status: 204 };

const notFound: Reply = { body: { message: "Not Found" }, status: 404 };

const invalid: Reply = { body: { message: "Validation Failed" }, status: 422 };

const policyBody = (policyId: number, name: string) =>
  ({
    id: policyId,
    name,
    node_id: `P_${policyId}`,
    type: "branch",
  }) satisfies Schema.Json;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/**
 * The text of a request body, when the client sent bytes or a string.
 */
const textOf: (raw: RequestInit["body"]) => string | undefined = (raw) => {
  if (Predicate.isUint8Array(raw)) {
    return new TextDecoder().decode(raw);
  }

  return Predicate.isString(raw) ? raw : undefined;
};

/**
 * Read a request body as JSON; no body is `null`.
 */
const readBody = (init: RequestInit | undefined) =>
  Option.fromNullishOr(textOf(init?.body)).pipe(
    Option.flatMap(decodeJson),
    Option.getOrElse<Schema.Json>(() => null),
  );

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
