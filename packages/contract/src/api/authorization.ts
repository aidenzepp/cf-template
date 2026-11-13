import { Context } from "effect";
import type { Session } from "../domain/session.ts";

/**
 * The session of the caller, provided to handlers.
 */
export class CurrentUser extends Context.Service<CurrentUser, Session>()(
  "@workspace/contract/CurrentUser",
) {}
