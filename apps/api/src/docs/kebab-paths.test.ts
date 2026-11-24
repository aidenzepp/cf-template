import * as DomainHttp from "@alchemy.run/domain/Http";
import { assert, describe, it } from "@effect/vitest";
import { NotebookApi } from "../notes/notebook.api.ts";
import { kebabGroup, kebabPath } from "./kebab-paths.ts";

describe("kebabPath", () => {
  it("converts plain segments and leaves parameter segments as written", () => {
    assert.strictEqual(kebabPath("/CreateNote"), "/create-note");
    assert.strictEqual(kebabPath("/Note/:keyName/watch"), "/note/:keyName/watch");
    assert.strictEqual(kebabPath("/api/create-note"), "/api/create-note");
  });
});

describe("kebabGroup over the Notebook group", () => {
  const Source = DomainHttp.toHttpApi(NotebookApi).group;
  const converted = kebabGroup(Source);

  it("converts every endpoint path and keeps the identifiers in their order", () => {
    assert.deepStrictEqual(Object.keys(converted.endpoints), Object.keys(Source.endpoints));
    assert.deepStrictEqual(
      Object.values(converted.endpoints).map((endpoint) => `${endpoint.method} ${endpoint.path}`),
      [
        "POST /create-note",
        "POST /update-note",
        "POST /delete-note",
        "GET /note/:key",
        "GET /note/:key/watch",
        "GET /note/:key/events",
        "GET /note/:key/list",
        "GET /note/:key/snapshot",
      ],
    );
  });

  it("keeps the schemas of every endpoint", () => {
    for (const [identifier, endpoint] of Object.entries(Source.endpoints)) {
      assert.strictEqual(converted.endpoints[identifier]?.params, endpoint.params, identifier);
      assert.strictEqual(converted.endpoints[identifier]?.success, endpoint.success, identifier);
      assert.strictEqual(converted.endpoints[identifier]?.error, endpoint.error, identifier);
    }
  });

  it("leaves the group it converts untouched", () => {
    assert.deepStrictEqual(
      Object.values(Source.endpoints).map((endpoint) => endpoint.path.split("/")[1]),
      ["CreateNote", "UpdateNote", "DeleteNote", "Note", "Note", "Note", "Note", "Note"],
    );
  });
});
