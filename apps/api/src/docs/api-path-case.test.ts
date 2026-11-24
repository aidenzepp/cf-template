import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { constVoid } from "effect/Function";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ServedApi } from "./routes.ts";

/**
 * A plain path segment: lowercase words and digits joined by single hyphens, so `create-note` and
 * `v2` pass while `CreateNote`, `createNote` and `create_note` do not.
 */
const PLAIN_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * The name of a `:param` segment: a camelCase identifier that starts with a lowercase letter. A
 * parameter name is a key of the decoded `params` struct rather than text a caller reads in the
 * URL, so it stays a plain identifier.
 */
const PARAM_NAME = /^[a-z][A-Za-z0-9]*$/u;

/**
 * Name the rule one path segment breaks, if any.
 *
 * @param segment - One `/`-separated segment of an endpoint path, such as `notes` or `:key`.
 * @returns The broken rule with the segment, or `undefined` when the segment follows the rules.
 */
const segmentViolation = (segment: string): string | undefined => {
  if (segment.startsWith(":")) {
    const name = segment.slice(1);

    return PARAM_NAME.test(name) ? undefined : `parameter name \`${name}\` is not camelCase`;
  }

  return PLAIN_SEGMENT.test(segment) ? undefined : `segment \`${segment}\` is not kebab-case`;
};

/**
 * List every endpoint of an HttpApi whose path breaks the casing rules, as `METHOD path: reason`.
 * `HttpApi.reflect` visits each endpoint of each group with its full path, prefixes included, so
 * the walk sees the routes a caller reaches.
 *
 * @param api - The HttpApi to walk.
 * @returns One line per broken segment, in the order the endpoints are declared.
 */
const pathViolations = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
): ReadonlyArray<string> => {
  const found: Array<string> = [];

  HttpApi.reflect(api, {
    onEndpoint: ({ endpoint }) => {
      for (const segment of endpoint.path.split("/").filter((part) => part !== "")) {
        const reason = segmentViolation(segment);

        if (reason !== undefined) {
          found.push(`${endpoint.method} ${endpoint.path}: ${reason}`);
        }
      }
    },
    onGroup: constVoid,
  });

  return found;
};

describe("the paths of every route the Worker serves", () => {
  it("use kebab-case plain segments and camelCase parameter names", () => {
    assert.deepStrictEqual(pathViolations(ServedApi), []);
  });

  it("reject a camelCase plain segment, so the check can fail", () => {
    const Probe = HttpApi.make("Probe").add(
      HttpApiGroup.make("probe").add(
        HttpApiEndpoint.get("camel", "/api/camelCase/:id", { params: { id: Schema.String } }),
      ),
    );

    assert.deepStrictEqual(pathViolations(Probe), [
      "GET /api/camelCase/:id: segment `camelCase` is not kebab-case",
    ]);
  });

  it("reject a parameter name that is not camelCase", () => {
    const Probe = HttpApi.make("Probe").add(
      HttpApiGroup.make("probe").add(
        HttpApiEndpoint.get("snake", "/api/notes/:note_id", {
          params: { note_id: Schema.String },
        }),
      ),
    );

    assert.deepStrictEqual(pathViolations(Probe), [
      "GET /api/notes/:note_id: parameter name `note_id` is not camelCase",
    ]);
  });
});
