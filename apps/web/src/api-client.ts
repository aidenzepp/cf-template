import { env } from "cloudflare:workers";
import { fromCloudflareFetcher, toHttpClient } from "@alchemy.run/cloudflare/Fetcher";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { AtomHttpApi } from "effect/reactivity";
import { Api } from "@workspace/contract/api/api";
import { browserApiBaseUrl, SERVER_API_BASE_URL } from "./api-base-url.ts";

/**
 * The HTTP client layer of one environment.
 *
 * On the server it calls the `API` service binding and copies only the inbound `Cookie` header onto
 * the request; no `Set-Cookie` is relayed back. The binding ignores the base URL, which is never
 * resolved. In the browser it is `fetch`, which sends the cookie itself.
 */
const httpClient = createIsomorphicFn()
  .server(() =>
    Layer.succeed(
      HttpClient.HttpClient,
      toHttpClient(fromCloudflareFetcher(env.API)).pipe(
        HttpClient.mapRequest((request) => {
          const cookie = getRequestHeader("cookie");

          return cookie === undefined
            ? request
            : HttpClientRequest.setHeader(request, "cookie", cookie);
        }),
      ),
    ),
  )
  .client(() => FetchHttpClient.layer);

/**
 * The base URL of one environment: the binding's placeholder on the server, the page origin in the
 * browser, where `http://api.internal` would be blocked as mixed content.
 */
const baseUrl = createIsomorphicFn()
  .server(() => SERVER_API_BASE_URL)
  .client(() => browserApiBaseUrl());

/**
 * The one typed client of the `Api`, with the atom helpers of the query and mutation atoms.
 */
export class ApiClient extends AtomHttpApi.Service<ApiClient>()("@workspace/web/ApiClient", {
  api: Api,
  baseUrl: baseUrl(),
  httpClient: httpClient(),
}) {}
