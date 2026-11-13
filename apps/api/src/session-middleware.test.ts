import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { Rpc, RpcGroup, RpcTest } from "effect/rpc";
import { AuthUnavailable } from "@workspace/contract/domain/auth-errors";
import { Session as UserSession, UserId } from "@workspace/contract/domain/session";
import { SessionLookup } from "./authorization.ts";
import { CurrentActor, Session, SessionLive } from "./session-middleware.ts";

/**
 * One guarded call that answers the id of the actor the middleware provided.
 */
const WhoAmI = Rpc.make("WhoAmI", { success: Schema.String }).middleware(Session);

/**
 * The group the test client calls.
 */
const Group = RpcGroup.make(WhoAmI);

/**
 * The handler: the actor's user id.
 */
const Handlers = Group.toLayer({
  WhoAmI: () =>
    Effect.gen(function* whoAmIHandler() {
      const actor = yield* CurrentActor;

      return actor.userId;
    }),
});

/**
 * A lookup that reads the `Cookie` header the middleware hands it: `sid=ada` is Ada, `sid=down`
 * fails as a fault, anything else is signed out.
 */
const lookup = Layer.succeed(
  SessionLookup,
  SessionLookup.of({
    current: Effect.gen(function* current() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const cookie = request.headers.cookie ?? "";

      if (cookie === "sid=down") {
        return yield* new AuthUnavailable({ retryAfterSeconds: 1 });
      }

      return cookie === "sid=ada"
        ? new UserSession({
            email: "ada@example.test",
            expiresAt: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
            image: null,
            name: "Ada",
            userId: UserId.make("ada"),
          })
        : null;
    }),
  }),
);

/**
 * The server half over the stub lookup, beside the handler.
 */
const World = Layer.mergeAll(Handlers, SessionLive.pipe(Layer.provide(lookup)));

/**
 * Call `WhoAmI` with the given `Cookie` header.
 *
 * @param cookie - The `Cookie` header the call carries.
 * @returns The actor's id, or the middleware's failure.
 */
const whoAmI = (cookie: string) =>
  Effect.gen(function* call() {
    const client = yield* RpcTest.makeClient(Group);

    return yield* client.WhoAmI(undefined, { headers: { cookie } });
  }).pipe(Effect.scoped, Effect.provide(World));

describe("the Session middleware", () => {
  it.effect("provides the signed-in caller as the current actor", () =>
    Effect.gen(function* signedIn() {
      assert.strictEqual(yield* whoAmI("sid=ada"), "ada");
    }),
  );

  it.effect("refuses a signed-out caller with SessionRequired", () =>
    Effect.gen(function* signedOut() {
      const error = yield* Effect.flip(whoAmI("sid=nobody"));

      assert.strictEqual(error._tag, "SessionRequired");
    }),
  );

  it.effect("fails with AuthUnavailable when the session check fails", () =>
    Effect.gen(function* fault() {
      const error = yield* Effect.flip(whoAmI("sid=down"));

      assert.strictEqual(error._tag, "AuthUnavailable");
    }),
  );
});
