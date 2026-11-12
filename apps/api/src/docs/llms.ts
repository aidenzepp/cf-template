import type { OpenApi } from "effect/http-api";
import { DOCS_PATH, OPENAPI_PATH } from "@workspace/contract/api/docs-paths";

/**
 * The HTTP methods an OpenAPI path item names its operations by, in the order `llms.txt` lists
 * them.
 */
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * Render `llms.txt` from the OpenAPI document of the `Api` contract.
 *
 * Every line comes from the document or from the shared path constants: the title and description
 * from `info`, one bullet per operation from its method, path and `operationId`. Nothing restates
 * an endpoint, so adding an endpoint to the contract adds its line with no edit here. The two links
 * are the document and the reference page, joined to `origin` so they resolve wherever `api` is
 * reached.
 *
 * @param origin - The origin of the request being answered, such as `https://app.example.com`.
 * @param document - The document `OpenApi.fromApi(Api)` produced.
 * @returns The Markdown text of `llms.txt`.
 */
export const llmsText = (origin: string, document: OpenApi.OpenAPISpec): string => {
  const operations = Object.entries(document.paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const operation = item[method];

      return operation === undefined
        ? []
        : [`- \`${method.toUpperCase()} ${path}\`: ${operation.operationId}`];
    }),
  );

  return [
    `# ${document.info.title}`,
    ...(document.info.description === undefined ? [] : ["", `> ${document.info.description}`]),
    "",
    "## Reference",
    "",
    `- [OpenAPI document](${origin}${OPENAPI_PATH}): the machine-readable contract`,
    `- [API reference](${origin}${DOCS_PATH}): the same contract as a browsable page`,
    "",
    "## Operations",
    "",
    ...operations,
    "",
  ].join("\n");
};
