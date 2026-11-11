import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, DateTime, Effect, Layer, Ref } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { Api } from "@workspace/contract/api/api";
import { NoteCreate, NotePatch } from "@workspace/contract/domain/note";
import { Session, UserId } from "@workspace/contract/domain/session";
import { AuthCheckSession, SessionLookup, SessionMiddlewareLive } from "../authorization.ts";
import { layerProblemDetails } from "../problem-details.ts";
import { ExampleFeatureGateLive } from "./gate.ts";
import { NotesApiHandlersNoDeps } from "./http.ts";
import { NOTES_MAX_PER_OWNER, Notes } from "./notes.ts";

/**
 * A signed-in caller with the given user id.
 *
 * @param id - The user id.
 * @returns The session `auth` would answer for that caller.
 */
const sessionOf = (id: string) =>
  new Session({
    email: `${id}@example.test`,
    expiresAt: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
    image: null,
    name: id,
    userId: UserId.make(id),
  });

const ada = sessionOf("ada");

const grace = sessionOf("grace");

/**
 * The typed client of the notes group.
 */
const notesClient = HttpApiTest.groups(Api, ["notes"]);

/**
 * Run `use` against the notes group over `Notes.layerMemory`, with a stub `AUTH` that answers the
 * session currently held in `current` and the example feature on or off.
 *
 * @param options - The stack's settings.
 * @param options.current - The session the stub `AUTH` answers; `null` is signed out.
 * @param options.feature - The `EXAMPLE_FEATURE_ENABLED` value.
 * @param use - The test body, given the typed client.
 * @returns The result of `use`.
 */
const withNotesApi = <A, E, R>(
  options: { readonly current: Ref.Ref<Session | null>; readonly feature: boolean },
  use: (client: Effect.Success<typeof notesClient>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* run() {
    const client = yield* notesClient;

    return yield* use(client);
  }).pipe(
    Effect.provide(
      NotesApiHandlersNoDeps.pipe(
        Layer.provide(Notes.layerMemory),
        Layer.provideMerge(
          Layer.mergeAll(
            SessionMiddlewareLive,
            ExampleFeatureGateLive,
            layerProblemDetails({ includeDetails: false }),
          ).pipe(
            Layer.provide(SessionLookup.layer),
            Layer.provide(Layer.succeed(AuthCheckSession, () => Ref.get(options.current))),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  EXAMPLE_FEATURE_ENABLED: String(options.feature),
                }),
              ),
            ),
          ),
        ),
        Layer.provideMerge(HttpServer.layerServices),
      ),
    ),
    Effect.scoped,
  );

describe("notes group with the example feature off", () => {
  it.effect("answers an anonymous caller 401 SessionRequired", () =>
    Effect.gen(function* anonymous() {
      const current = yield* Ref.make<Session | null>(null);

      yield* withNotesApi({ current, feature: false }, (client) =>
        Effect.gen(function* check() {
          const error = yield* Effect.flip(client.notes.list());

          assert.strictEqual(error._tag, "SessionRequired");
        }),
      );
    }),
  );

  it.effect("answers a signed-in caller 404 NotesUnavailable", () =>
    Effect.gen(function* signedIn() {
      const current = yield* Ref.make<Session | null>(ada);

      yield* withNotesApi({ current, feature: false }, (client) =>
        Effect.gen(function* check() {
          const error = yield* Effect.flip(client.notes.list());

          assert.strictEqual(error._tag, "NotesUnavailable");
        }),
      );
    }),
  );
});

describe("notes group with the example feature on", () => {
  it.effect("creates, lists newest first, gets, updates and deletes", () =>
    Effect.gen(function* crud() {
      const current = yield* Ref.make<Session | null>(ada);

      yield* withNotesApi({ current, feature: true }, (client) =>
        Effect.gen(function* check() {
          const first = yield* client.notes.create({
            payload: new NoteCreate({ body: "one", title: "First" }),
          });

          const second = yield* client.notes.create({
            payload: new NoteCreate({ body: "two", title: "Second" }),
          });

          const listed = yield* client.notes.list();

          assert.deepStrictEqual(
            listed.map(({ id }) => id),
            [second.id, first.id],
          );

          assert.strictEqual(
            (yield* client.notes.get({ params: { id: first.id } })).title,
            "First",
          );

          const updated = yield* client.notes.update({
            params: { id: first.id },
            payload: new NotePatch({ title: "Renamed" }),
          });

          assert.strictEqual(updated.title, "Renamed");
          assert.strictEqual(updated.body, "one");

          yield* client.notes.remove({ params: { id: first.id } });

          const error = yield* Effect.flip(client.notes.get({ params: { id: first.id } }));

          assert.strictEqual(error._tag, "NoteNotFound");
          assert.deepStrictEqual(
            (yield* client.notes.list()).map(({ id }) => id),
            [second.id],
          );
        }),
      );
    }),
  );

  it.effect("answers a foreign id 404 NoteNotFound", () =>
    Effect.gen(function* foreign() {
      const current = yield* Ref.make<Session | null>(ada);

      yield* withNotesApi({ current, feature: true }, (client) =>
        Effect.gen(function* check() {
          const note = yield* client.notes.create({
            payload: new NoteCreate({ body: "mine", title: "Mine" }),
          });

          yield* Ref.set(current, grace);

          assert.strictEqual(
            (yield* Effect.flip(client.notes.get({ params: { id: note.id } })))._tag,
            "NoteNotFound",
          );
          assert.strictEqual(
            (yield* Effect.flip(client.notes.remove({ params: { id: note.id } })))._tag,
            "NoteNotFound",
          );
          assert.deepStrictEqual(yield* client.notes.list(), []);
        }),
      );
    }),
  );

  it.effect("answers the 101st create of one owner 409 NoteQuotaExceeded", () =>
    Effect.gen(function* quota() {
      const current = yield* Ref.make<Session | null>(ada);

      yield* withNotesApi({ current, feature: true }, (client) =>
        Effect.gen(function* check() {
          yield* Effect.forEach(
            Array.from({ length: NOTES_MAX_PER_OWNER }, (_, index) => index),
            (index) =>
              client.notes.create({
                payload: new NoteCreate({ body: "", title: `Note ${index}` }),
              }),
          );

          const error = yield* Effect.flip(
            client.notes.create({ payload: new NoteCreate({ body: "", title: "One too many" }) }),
          );

          assert.strictEqual(error._tag, "NoteQuotaExceeded");
          assert.isTrue(error._tag === "NoteQuotaExceeded" && error.limit === 100);

          yield* Ref.set(current, grace);
          yield* client.notes.create({
            payload: new NoteCreate({ body: "", title: "Another owner" }),
          });
        }),
      );
    }),
  );
});
