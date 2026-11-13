import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The sentence `AGENTS.md` carries in `## Policy`: the order to look for a capability in before
 * writing code.
 */
const LADDER =
  "Before writing code, walk the ladder: a Cloudflare platform capability, then an Alchemy resource or binding, then an Effect module, service or layer, then an installed dependency or the stack's standard library (check `docs/capabilities.md`), then code in this repository, and only then an external service.";

/**
 * The sentence `AGENTS.md` carries in `## Workflow`: why a worktree installs its own packages.
 */
const WORKTREE_INSTALL =
  "A worktree runs its own `bun install` before any package script, binary or patch tool (`typescript` and `@effect/tsgo` included), because package resolution walks up into the main checkout.";

/**
 * The message a tracked tool-written path fails with.
 */
const TRACKED_PATH_MESSAGE =
  "a tracked `CLAUDE.md` replaces `AGENTS.md` for Claude Code unless it only imports the root instructions file; this repository keeps one instruction file. Tools known to write such paths: `vp create`, `vp migrate`, `ultracite init`, `shadcn add`, `supdoc skill install`. Untrack:";

/**
 * Returns the repository-relative targets of the Markdown links in the `## Skills` section.
 *
 * @param agents - The text of `AGENTS.md`.
 * @returns The set of link targets in that section.
 */
const listedSkills = (agents: string): Set<string> => {
  const section = agents.split("\n## Skills\n")[1]?.split("\n## ")[0] ?? "";

  return new Set(
    Array.from(
      section.matchAll(/\]\((?<target>[^)\s]+)\)/gu),
      (match) => match.groups?.target ?? "",
    ),
  );
};

/**
 * Returns the paths a tool writes that this repository must not track: a `CLAUDE.md` or
 * `CLAUDE.local.md` at any depth outside a `fixtures` directory, Claude's shared settings and
 * skills, and the editor folders.
 *
 * @param files - Repository-relative tracked paths, as `git ls-files` prints them.
 * @returns The tracked paths that match.
 */
const trackedToolPaths = (files: ReadonlyArray<string>): ReadonlyArray<string> =>
  files.filter((file) => {
    const segments = file.split("/");
    const name = segments.at(-1) ?? "";

    if (name === "CLAUDE.md" || name === "CLAUDE.local.md") {
      return !segments.includes("fixtures");
    }

    return (
      file === ".claude/settings.json" ||
      file.startsWith(".claude/skills/") ||
      file.startsWith(".vscode/") ||
      file.startsWith(".idea/")
    );
  });

/**
 * Reads `AGENTS.md`, the skill directories and the tracked paths of the repository root.
 */
const repository = Effect.gen(function* read() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cwd = yield* path.fromFileUrl(new URL("../..", import.meta.url));
  const skills = path.join(cwd, ".agents", "skills");
  const names = yield* fs.readDirectory(skills);

  const infos = yield* pipe(
    names,
    Effect.forEach((name) =>
      fs.stat(path.join(skills, name)).pipe(Effect.map((info) => ({ info, name }))),
    ),
  );

  const directories = infos.filter(({ info }) => info.type === "Directory").map(({ name }) => name);

  const tracked = yield* spawner.string(ChildProcess.make("git", ["ls-files"], { cwd }));

  return {
    agents: yield* fs.readFileString(path.join(cwd, "AGENTS.md")),
    directories,
    tracked: tracked.split("\n").filter(Boolean),
  };
}).pipe(Effect.provide(BunServices.layer));

describe("AGENTS.md skills list", () => {
  it.effect("links exactly the skill directories that exist", () =>
    Effect.gen(function* skillsMatch() {
      const { agents, directories } = yield* repository;
      const listed = listedSkills(agents);
      const present = new Set(directories.map((name) => `.agents/skills/${name}/SKILL.md`));
      const unlisted = [...present].filter((target) => !listed.has(target));
      const missing = [...listed].filter((target) => !present.has(target));

      assert.deepStrictEqual(
        { missing, unlisted },
        { missing: [], unlisted: [] },
        "the Skills list must link every skill directory once and no other path",
      );
    }),
  );

  it.effect("carries the ladder line and the worktree-install line", () =>
    Effect.gen(function* sentences() {
      const { agents } = yield* repository;

      assert.include(agents, LADDER);
      assert.include(agents, WORKTREE_INSTALL);
    }),
  );

  it.effect("tracks none of the paths tools write", () =>
    Effect.gen(function* untracked() {
      const { tracked } = yield* repository;

      assert.deepStrictEqual(trackedToolPaths(tracked), [], TRACKED_PATH_MESSAGE);
    }),
  );
});

describe("trackedToolPaths", () => {
  it("names every tool-written path and spares fixtures", () => {
    assert.deepStrictEqual(
      trackedToolPaths([
        "README.md",
        "CLAUDE.md",
        "apps/web/CLAUDE.local.md",
        "tools/lint/fixtures/CLAUDE.md",
        ".claude/settings.json",
        ".claude/settings.local.json",
        ".claude/skills/supdoc/SKILL.md",
        ".vscode/settings.json",
        ".idea/workspace.xml",
      ]),
      [
        "CLAUDE.md",
        "apps/web/CLAUDE.local.md",
        ".claude/settings.json",
        ".claude/skills/supdoc/SKILL.md",
        ".vscode/settings.json",
        ".idea/workspace.xml",
      ],
    );
  });
});

describe("listedSkills", () => {
  it("reads only the link targets of the Skills section", () => {
    const agents =
      "# A\n\n[x](other.md)\n\n## Skills\n\n- [a](a/SKILL.md): one.\n- [b](b/SKILL.md)\n\n## Next\n\n[y](y.md)\n";

    assert.deepStrictEqual([...listedSkills(agents)], ["a/SKILL.md", "b/SKILL.md"]);
  });
});
