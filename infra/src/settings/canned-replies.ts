import type { Schema } from "effect";

/**
 * A reply: a status and a JSON body.
 */
export interface Reply {
  readonly body?: Schema.Json;
  readonly status: number;
}

export const ok = (body: Schema.Json) => ({ body, status: 200 }) satisfies Reply;

export const created = (body: Schema.Json) => ({ body, status: 201 }) satisfies Reply;

export const noContent: Reply = { status: 204 };

export const notFound: Reply = { body: { message: "Not Found" }, status: 404 };

export const invalid: Reply = { body: { message: "Validation Failed" }, status: 422 };
