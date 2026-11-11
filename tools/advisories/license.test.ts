import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Config, Console, Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  ALLOWED_LICENSES,
  cachedBinary,
  hostAsset,
  licensesFlag,
  parseOptions,
  parsePins,
} from "./license.ts";

const digest = "a".repeat(64);

describe("parsePins", () => {
  it.effect("parses the tag and one digest per asset", () =>
    Effect.gen(function* case1() {
      const pins = yield* parsePins(`tag v2.7.0\nosv-scanner_linux_amd64 ${digest}\n`);

      assert.strictEqual(pins.tag, "v2.7.0");
      assert.strictEqual(pins.assets.get("osv-scanner_linux_amd64"), digest);
    }),
  );

  it.effect("rejects an asset line with no digest, naming the line", () =>
    Effect.gen(function* case2() {
      const error = yield* Effect.flip(parsePins("tag v2.7.0\nosv-scanner_linux_amd64\n"));

      assert.strictEqual(error._tag, "PinError");
      assert.match(error.message, /line 2: expected "<asset> <sha256>"/u);
    }),
  );

  it.effect("rejects a malformed digest", () =>
    Effect.gen(function* case3() {
      const error = yield* Effect.flip(parsePins("tag v2.7.0\nosv-scanner_linux_amd64 abc\n"));

      assert.strictEqual(error._tag, "PinError");
    }),
  );

  it.effect("rejects a text with no tag line", () =>
    Effect.gen(function* case4() {
      const error = yield* Effect.flip(parsePins(`osv-scanner_linux_amd64 ${digest}\n`));

      assert.match(error.message, /line 1: missing field "tag"/u);
    }),
  );
});

describe("allowlist", () => {
  it("joins the identifiers with commas", () => {
    assert.strictEqual(licensesFlag(["MIT", "ISC"]), "--licenses=MIT,ISC");
  });

  it("holds no compound expression and no UNKNOWN", () => {
    assert.isTrue(ALLOWED_LICENSES.every((license) => /^[\w.-]+$/u.test(license)));
    assert.notInclude(ALLOWED_LICENSES, "UNKNOWN");
  });

  it.effect("--allow replaces the constant and --dir names the directory", () =>
    Effect.gen(function* case5() {
      const options = yield* parseOptions(["--", "--dir", "somewhere", "--allow", "MIT-0,ISC"]);

      assert.deepStrictEqual(options, { allow: ["MIT-0", "ISC"], dir: "somewhere" });
      assert.deepStrictEqual(yield* parseOptions([]), { allow: undefined, dir: undefined });
    }),
  );

  it.effect("rejects an unknown argument", () =>
    Effect.gen(function* case6() {
      const error = yield* Effect.flip(parseOptions(["--bogus"]));

      assert.strictEqual(error._tag, "UsageError");
    }),
  );
});

describe("license.ts against a seeded tree", () => {
  it.effect("exits 1 and names a package when the allowlist excludes a present license", () =>
    Effect.gen(function* case7() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* path.fromFileUrl(new URL("../..", import.meta.url));

      const pins = yield* parsePins(
        yield* fs.readFileString(path.join(root, "tools/advisories/osv-scanner.pins.txt")),
      );

      const binary = cachedBinary(
        path,
        root,
        pins,
        yield* hostAsset(process.platform, process.arch),
      );

      if (!(yield* fs.exists(binary))) {
        yield* Console.log("skipped: the scanner binary is not cached; run bun run license once.");

        return;
      }

      yield* fs.makeDirectory(path.join(root, "work"), { recursive: true });

      const seeded = yield* fs.makeTempDirectoryScoped({
        directory: path.join(root, "work"),
        prefix: "license-test-",
      });

      yield* fs.copyFile(path.join(root, "package.json"), path.join(seeded, "package.json"));
      yield* fs.copyFile(path.join(root, "bun.lock"), path.join(seeded, "bun.lock"));

      const env = { HOME: yield* Config.String("HOME"), PATH: yield* Config.String("PATH") };

      const [output, code] = yield* Effect.scoped(
        Effect.gen(function* spawned() {
          const handle = yield* spawner.spawn(
            ChildProcess.make(
              "bun",
              [path.join(root, "tools/advisories/license.ts"), "--dir", seeded, "--allow", "MIT-0"],
              { env, extendEnv: false },
            ),
          );

          return yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
            { concurrency: 2 },
          );
        }),
      );

      assert.strictEqual(code, 1);
      assert.match(output, /\beffect\b/u);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
