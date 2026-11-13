import { describe, expect, it } from "@effect/vitest";
import { Array as Arr, Option } from "effect";
import { OpenApi } from "effect/http-api";
import { Api } from "./api.ts";

const spec = OpenApi.fromApi(Api);

const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  Arr.getSomes(methods.map((method) => Option.fromNullishOr(item[method]))).map((operation) => ({
    operation,
    path,
  })),
);

describe("Api OpenAPI document", () => {
  it("declares operations", () => {
    expect(operations.length).toBeGreaterThan(0);
  });

  it("lists a 400 problem+json response on every operation", () => {
    for (const { path, operation } of operations) {
      const response = operation.responses["400"];
      expect(response, `${operation.operationId} (${path}) has no 400`).toBeDefined();
      expect(response?.content?.["application/problem+json"]).toBeDefined();
    }
  });

  it("lists the 503 problem+json response of GET /api/session", () => {
    const response = spec.paths["/api/session"]?.get?.responses["503"];

    expect(response?.content?.["application/problem+json"]).toBeDefined();
  });

  it("serves no path under /auth", () => {
    expect(Object.keys(spec.paths).filter((path) => path.startsWith("/auth"))).toStrictEqual([]);
  });

  it("gives every operation an operationId of the shape group.endpoint", () => {
    const offenders = operations
      .filter(({ operation }) => !/^[^.]+\.[^.]+$/u.test(operation.operationId))
      .map(({ path, operation }) => `${path}: ${operation.operationId}`);

    expect(
      offenders,
      "operationId must be group.endpoint (C45a); a docs site's reference slugs and the contract-derived CLI and MCP key on it",
    ).toStrictEqual([]);
  });
});
