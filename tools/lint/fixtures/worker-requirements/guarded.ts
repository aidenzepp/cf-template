import * as Cloudflare from "@alchemy.run/cloudflare";
import { Context, Effect } from "effect";
import type { WorkerRequirements } from "../../../../packages/config/src/worker-requirements.ts";

class Mailer extends Context.Service<
  Mailer,
  { readonly send: (to: string) => Effect.Effect<void> }
>()("Mailer") {}

const body = Effect.gen(function* body() {
  yield* Mailer;

  return { ping: Effect.void };
});

/**
 * Function form.
 */
export const FunctionWorker = Cloudflare.Worker(
  "FunctionWorker",
  { main: import.meta.url },
  // @ts-expect-error Mailer is a user service no provider supplies, so the guard rejects it.
  body.pipe(Effect.satisfiesServicesType<WorkerRequirements>()),
);

/**
 * Class form.
 */
export class ClassWorker extends Cloudflare.Worker<ClassWorker>()(
  "ClassWorker",
  { main: import.meta.url },
  // @ts-expect-error Mailer is a user service no provider supplies, so the guard rejects it.
  body.pipe(Effect.satisfiesServicesType<WorkerRequirements>()),
) {}

/**
 * Class plus `.make` form.
 */
export class MakeWorker extends Cloudflare.Worker<
  MakeWorker,
  { readonly ping: Effect.Effect<void> }
>()("MakeWorker") {}

export const MakeWorkerLive = MakeWorker.make(
  { main: import.meta.url },
  // @ts-expect-error Mailer is a user service no provider supplies, so the guard rejects it.
  body.pipe(Effect.satisfiesServicesType<WorkerRequirements>()),
);
