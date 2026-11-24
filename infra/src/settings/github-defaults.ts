import type { JsonRecord } from "./json-body.ts";

/**
 * The constants and the repository defaults the stateful GitHub model in `fake-state.ts` builds on.
 */

/**
 * The repository every fake run targets.
 */
export const OWNER = "acme";

export const REPO = "widget";

/**
 * The API path of the fake repository.
 */
export const REPO_PATH = `/repos/${OWNER}/${REPO}`;

export const NOW = "2026-01-01T00:00:00Z";

export const API = "https://api.github.com";

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
export const repositoryDefaults = {
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
