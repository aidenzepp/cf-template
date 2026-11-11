import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));

const checkIgnore = (path: string): number =>
  Bun.spawnSync(["git", "check-ignore", "-q", path], { cwd }).exitCode;

describe("git check-ignore", () => {
  test.each([".env", ".env.local", ".env.op", ".alchemy/x"])("ignores %s", (path) => {
    expect(checkIgnore(path)).toBe(0);
  });

  test(".env.example is not ignored", () => {
    expect(checkIgnore(".env.example")).toBe(1);
  });
});
