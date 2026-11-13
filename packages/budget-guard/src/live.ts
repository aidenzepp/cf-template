import { Effect, Layer, Ref, Schema } from "effect";
import { HttpServerResponse, ProblemDetails } from "effect/http";
import { RequestGuard, WorkerBindings } from "@workspace/config/web-guard";
import { LATCH_KEY } from "./latch.ts";

/**
 * The name `infra` binds the latch namespace under in the env of `web`.
 */
const BINDING = "GUARD_KV";

/**
 * The longest a latch read is reused inside one isolate.
 */
const READ_TTL = "30 seconds";

/**
 * The path prefix of static assets, which are never refused.
 */
const ASSET_PREFIX = "/assets/";

/**
 * The problem the 503 answer carries.
 */
const LATCHED_PROBLEM = {
  detail:
    "Request volume crossed the project's budget line; serving resumes when the latch clears.",
  status: 503,
  title: "Service paused",
  type: "/problems/budget-latched",
} as const;

/**
 * The failure of one latch read: the binding is missing or has no `get`, or the read rejected.
 */
class LatchReadError extends Schema.TaggedError<LatchReadError>()("LatchReadError", {
  message: Schema.String,
}) {}

/**
 * Where the guard reads the latch: whether it is set.
 */
interface LatchStore<E> {
  readonly isLatched: Effect.Effect<boolean, E>;
}

/**
 * Build the guard over a latch store.
 *
 * `check` reads the latch at most once per `30` s per isolate and answers the 503 on every path
 * but static assets while it is set. A failed read serves normally and logs `web.guard.read_error`
 * at Error once per isolate.
 *
 * @param store - The latch store.
 * @returns The `check` of the guard.
 */
export const makeCheck = <E>(store: LatchStore<E>) =>
  Effect.gen(function* makeCheckEffect() {
    const logged = yield* Ref.make(false);

    const read = store.isLatched.pipe(
      Effect.tapError(() =>
        Ref.getAndSet(logged, true).pipe(
          Effect.flatMap((already) =>
            already ? Effect.void : Effect.logError("web.guard.read_error"),
          ),
        ),
      ),
      Effect.orElseSucceed(() => false),
    );

    const latched = yield* Effect.cachedWithTTL(read, READ_TTL);

    return (request: Request): Effect.Effect<Response | undefined> =>
      new URL(request.url).pathname.startsWith(ASSET_PREFIX)
        ? Effect.succeed(undefined)
        : latched.pipe(
            Effect.map((isLatched) =>
              isLatched
                ? HttpServerResponse.toWeb(
                    HttpServerResponse.setHeader(
                      ProblemDetails.toResponse(LATCHED_PROBLEM),
                      "retry-after",
                      "300",
                    ),
                  )
                : undefined,
            ),
          );
  });

/**
 * The `web` layer of the block, the {@link RequestGuard} `web` asks about every request.
 *
 * It reads the latch from the plain KV binding `GUARD_KV` of `web`'s env, never an account token.
 * A missing or unreadable binding fails the read, which serves. The receiver of the guard alert is
 * a Worker of its own; see `./stack`.
 */
export const BudgetGuardLive = Layer.effect(
  RequestGuard,
  Effect.gen(function* budgetGuardLive() {
    const bindings = yield* WorkerBindings;
    const binding = bindings.kv(BINDING);

    const isLatched =
      binding === undefined
        ? Effect.fail(new LatchReadError({ message: `${BINDING} is not a KV binding.` }))
        : Effect.tryPromise({
            catch: () => new LatchReadError({ message: `${BINDING} rejected a read.` }),
            try: () => binding.get(LATCH_KEY),
          }).pipe(Effect.map((value) => value !== null));

    return RequestGuard.of({ check: yield* makeCheck({ isLatched }) });
  }),
);
