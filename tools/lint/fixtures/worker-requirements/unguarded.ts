import * as Cloudflare from "@alchemy.run/cloudflare";
import { Context, Effect } from "effect";

class Mailer extends Context.Service<
  Mailer,
  { readonly send: (to: string) => Effect.Effect<void> }
>()("Mailer") {}

const body = Effect.gen(function* body() {
  yield* Mailer;

  return { ping: Effect.void };
});

// Alchemy 2.0.0-beta.85 already rejects an unprovided service in the function and class forms,
// so only the `.make` form still compiles without the guard.
/**
 * Class plus `.make` form.
 */
export class MakeWorker extends Cloudflare.Worker<
  MakeWorker,
  { readonly ping: Effect.Effect<void> }
>()("MakeWorker") {}

export const MakeWorkerLive = MakeWorker.make({ main: import.meta.url }, body);
