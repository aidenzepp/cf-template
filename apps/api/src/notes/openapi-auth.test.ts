import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Domain from "@alchemy.run/domain";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Layer, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { OpenApi } from "effect/http-api";
import { ServedApi } from "../docs/routes.ts";
import { makeHandler } from "../worker.ts";
import { NotesModel } from "./notes.model.ts";

/**
 * One operation of the generated document: its method, its path and its `operationId`.
 */
interface Operation {
  readonly id: string;
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly body: Sample;
}

/**
 * The operations meant to be answered without a session, each named as `METHOD /path` with the
 * reason it is open. Every other operation of the document must answer 401 to a caller with no
 * cookie.
 */
const OPEN_OPERATIONS = {
  "GET /api/health": "Liveness probe: it answers anonymous callers by design (SystemApi).",
  "GET /api/session":
    "Reports who the caller is and answers null when signed out, so the app can show sign-in (SystemApi).",
} satisfies Record<string, string>;

/**
 * The HTTP methods an OpenAPI path item can carry an operation under.
 */
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

/**
 * The part of a JSON schema the sweep reads to build a request body.
 */
interface BodySchema {
  readonly anyOf?: ReadonlyArray<BodySchema> | undefined;
  readonly properties?: Readonly<Record<string, BodySchema>> | undefined;
  readonly required?: ReadonlyArray<string> | undefined;
  readonly type?: string | undefined;
}

/**
 * Decodes a schema of the document into {@link BodySchema}.
 */
const bodySchema: Schema.Codec<BodySchema> = Schema.Struct({
  anyOf: Schema.optional(Schema.Array(Schema.suspend(() => bodySchema))),
  properties: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.suspend(() => bodySchema),
    ),
  ),
  required: Schema.optional(Schema.Array(Schema.String)),
  type: Schema.optional(Schema.String),
});

/**
 * A JSON value the sweep sends as a request body.
 */
type Sample = string | number | null | { readonly [name: string]: Sample };

/**
 * A minimal value that satisfies a JSON schema of the document: required properties only, strings
 * as `"x"`, numbers as `0`. A request with a body the schema rejects would answer 400 before the
 * session check could answer, so the sweep sends a valid one.
 *
 * @param schema - A schema of the document.
 * @returns A value the schema accepts.
 */
const sample = (schema: BodySchema): Sample => {
  const [first] = schema.anyOf ?? [];

  if (first !== undefined) {
    return sample(first);
  }

  if (schema.type === "object") {
    const properties = schema.properties ?? {};

    return Object.fromEntries(
      (schema.required ?? []).flatMap((name) => {
        const property = properties[name];

        return property === undefined ? [] : [[name, sample(property)]];
      }),
    );
  }

  if (schema.type === "string") {
    return "x";
  }

  return schema.type === "number" || schema.type === "integer" ? 0 : null;
};

/**
 * Every operation of the document `OpenApi.fromApi(ServedApi)` generates, which is the document
 * `/api/openapi.json` serves.
 */
const operations: ReadonlyArray<Operation> = Object.entries(
  OpenApi.fromApi(ServedApi).paths,
).flatMap(([path, item]) =>
  METHODS.flatMap((method) => {
    const operation = item[method];
    const schema = operation?.requestBody?.content["application/json"]?.schema;

    return operation === undefined
      ? []
      : [
          {
            body:
              schema === undefined ? null : sample(Schema.decodeUnknownSync(bodySchema)(schema)),
            id: operation.operationId,
            key: `${method.toUpperCase()} ${path}`,
            method: method.toUpperCase(),
            path,
          },
        ];
  }),
);

/**
 * The status the `api` handler answers an operation called with no `Cookie` header, with the
 * session check answering that the caller is signed out.
 *
 * @param operation - The operation to call.
 * @returns The response status.
 */
const statusWithoutCookie = (operation: Operation) =>
  Effect.gen(function* call() {
    const hosted = yield* Layer.build(
      NotesModel.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory)),
    );

    const handler = yield* makeHandler(
      () => Effect.succeed(null),
      Context.empty(),
      Layer.empty,
      hosted,
    );

    const init: RequestInit = { method: operation.method };

    if (operation.body !== null) {
      init.body = JSON.stringify(operation.body);
      init.headers = { "content-type": "application/json" };
    }

    const request = HttpServerRequest.fromWeb(
      new Request(`http://api.internal${operation.path.replaceAll(/\{[^}]+\}/gu, "x")}`, init),
    );

    const response = yield* handler.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    );

    return HttpServerResponse.toWeb(response).status;
  }).pipe(Effect.scoped, Effect.provideService(Cloudflare.WorkerEnvironment, {}), Effect.orDie);

describe("the generated OpenAPI document with no cookie", () => {
  it.effect("lists a Notebook operation and answers 401 to every operation not allowlisted", () =>
    Effect.gen(function* sweep() {
      yield* Effect.logInfo(
        `OpenAPI operations swept: ${operations.length}: ${operations.map((o) => o.key).join(", ")}`,
      );

      for (const name of ["CreateNote", "UpdateNote", "DeleteNote"]) {
        assert.isTrue(
          operations.some((operation) => operation.path === `/api/${name}`),
          `The document lists no ${name} operation.`,
        );
      }

      const answers = yield* Effect.forEach(
        operations.filter((operation) => !(operation.key in OPEN_OPERATIONS)),
        (operation) =>
          statusWithoutCookie(operation).pipe(
            Effect.map((status) => ({ key: operation.key, status })),
          ),
      );

      assert.deepStrictEqual(
        answers.filter((answer) => answer.status !== 401),
        [],
      );
    }),
  );

  it("names only allowlisted operations the document lists", () => {
    const keys = new Set(operations.map((operation) => operation.key));

    assert.deepStrictEqual(
      Object.keys(OPEN_OPERATIONS).filter((key) => !keys.has(key)),
      [],
    );
  });
});
