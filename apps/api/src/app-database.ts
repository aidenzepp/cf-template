import { Context } from "effect";
import type { Effect } from "effect";
import type { makeDatabase } from "@workspace/db/database";

/**
 * The per-execution accessor of the app database, as `makeDatabase` returns it. The Worker provides
 * it to the isolate layers of `blocks.ts`, which build the services that hold the database; a unit
 * reads it and never the binding. Evaluating the accessor outside an execution scope is a defect.
 */
export class AppDatabase extends Context.Service<
  AppDatabase,
  Effect.Success<ReturnType<typeof makeDatabase>>
>()("@workspace/api/AppDatabase") {}
