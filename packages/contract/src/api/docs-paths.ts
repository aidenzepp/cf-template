/**
 * Where `api` serves the OpenAPI document derived from the `Api` contract.
 */
export const OPENAPI_PATH = "/api/openapi.json" as const;

/**
 * Where `api` serves the Scalar reference page for the same document.
 */
export const DOCS_PATH = "/api/docs" as const;

/**
 * Where `api` serves the `llms.txt` discovery entry point. It sits outside `/api`, so `web`
 * forwards this one path by name; `apps/web/src/forward-prefixes.ts` repeats the literal and a
 * test there pins the two together.
 */
export const LLMS_PATH = "/llms.txt" as const;

/**
 * Where `web` serves the committed `DESIGN.md`, behind the same `DOCS_ENABLED` knob as the other
 * documentation paths. `web` answers it itself, so it is not a forwarded path.
 */
export const DESIGN_PATH = "/design.md" as const;
