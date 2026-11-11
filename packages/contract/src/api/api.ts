import { HttpApi, HttpApiMiddleware } from "effect/http-api";
import { NotesApiGroup } from "./notes.ts";
import { SystemApi } from "./system.ts";

/**
 * The one HttpApi every handler, client and OpenAPI document derives from. `ProblemDetails` is
 * declared last because `HttpApi.middleware` wraps only the groups added before it.
 */
export const Api = HttpApi.make("Api")
  .add(NotesApiGroup)
  .add(SystemApi)
  .middleware(HttpApiMiddleware.ProblemDetails);
