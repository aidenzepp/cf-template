import { Effect, Ref } from "effect";

/**
 * The longest a latch read is reused inside one isolate.
 */
const READ_TTL = "30 seconds";

/**
 * The path prefix of static assets, which are never refused.
 */
const ASSET_PREFIX = "/assets/";

/**
 * The body of the 503 answer, as `application/problem+json`.
 */
const LATCHED_BODY =
  '{"type":"/problems/budget-latched","title":"Service paused","status":503,"detail":"Request volume crossed the project\'s budget line; serving resumes when the latch clears."}';

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
      Effect.catch(() =>
        Ref.getAndSet(logged, true).pipe(
          Effect.flatMap((already) =>
            already ? Effect.void : Effect.logError("web.guard.read_error"),
          ),
          Effect.as(false),
        ),
      ),
    );

    const latched = yield* Effect.cachedWithTTL(read, READ_TTL);

    return (request: Request): Effect.Effect<Response | undefined> =>
      new URL(request.url).pathname.startsWith(ASSET_PREFIX)
        ? Effect.succeed(undefined)
        : latched.pipe(
            Effect.map((isLatched) =>
              isLatched
                ? new Response(LATCHED_BODY, {
                    headers: { "content-type": "application/problem+json", "retry-after": "300" },
                    status: 503,
                  })
                : undefined,
            ),
          );
  });
