import type { HttpApiSurface } from "@alchemy.run/domain/Http";
import { Context } from "effect";
import { HttpApi } from "effect/http-api";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { kebabCase } from "effect/String";

/**
 * Convert one path to kebab-case: each plain segment goes through `effect/String`'s `kebabCase`
 * and each `:param` segment stays as written, because a parameter name is the key of the decoded
 * `params` struct and not text of the URL. `kebabCase` also splits digits from letters, so a
 * segment such as `v2` becomes `v-2`, which the `api-path-case.test.ts` rule accepts.
 *
 * @param path - A router path such as `/CreateNote` or `/Note/:key/watch`.
 * @returns The same path with every plain segment in kebab-case, such as `/create-note`.
 */
export const kebabPath = (path: string) =>
  path
    .split("/")
    .map((segment) => (segment === "" || segment.startsWith(":") ? segment : kebabCase(segment)))
    .join("/");

/**
 * Clone an endpoint with a different path. `HttpApiEndpoint` offers no way to replace a path
 * (`prefix` only prepends), but every combinator returns a new endpoint that holds the same
 * schemas, method, middleware and annotations. Merging an empty annotation context is the one that
 * changes nothing, so the fresh copy it returns is the clone, and only the copy's `path` field is
 * then assigned.
 *
 * @param endpoint - The endpoint to clone.
 * @param path - The path of the clone.
 * @returns A new endpoint equal to `endpoint` in everything but its path.
 */
const withPath = (endpoint: HttpApiEndpoint.Top, path: string) => {
  const clone: HttpApiEndpoint.Top = Object.assign(endpoint.annotateMerge(Context.empty()), {
    path,
  });

  return clone;
};

/**
 * Convert the path of every endpoint of a group to kebab-case. `HttpApiGroup.add` replaces an
 * endpoint of the same identifier, so each converted clone takes the place of its original and the
 * group keeps its identifier, annotations and endpoint order.
 *
 * @param group - The group whose endpoints are converted.
 * @returns A group with the same endpoints, each at its {@link kebabPath}.
 */
export const kebabGroup = <Name extends string>(
  group: HttpApiGroup.HttpApiGroup<Name, HttpApiEndpoint.Top>,
) => {
  let converted = group;

  for (const endpoint of Object.values<HttpApiEndpoint.Top>(group.endpoints)) {
    converted = converted.add(withPath(endpoint, kebabPath(endpoint.path)));
  }

  return converted;
};

/**
 * Publish a Domain Api's HTTP surface with kebab-case paths. `toHttpApi` names each route after the
 * model (`POST /CreateNote`, `GET /Note/{key}`), and the model's names are PascalCase, so the
 * surface is rebuilt around {@link kebabGroup}: the group and the `HttpApi` that holds it carry the
 * converted paths, and the layers serve them. Handlers are registered by endpoint identifier, not
 * by path, so `layerFor` serves a converted group in any `HttpApi` unchanged, and `layer` is
 * rebuilt for the converted `api`.
 *
 * @param surface - What `DomainHttp.toHttpApi` returns for an Api.
 * @returns A surface of the same shape whose paths are all kebab-case.
 */
export const kebabPaths = <Name extends string, R>(surface: HttpApiSurface<Name, R>) => {
  const group = kebabGroup(surface.group);
  const api = HttpApi.make(surface.api.identifier).add(group);

  const kebabbed: HttpApiSurface<Name, R> = {
    api,
    group,
    layer: surface.layerFor(api),
    layerFor: surface.layerFor,
  };

  return kebabbed;
};
