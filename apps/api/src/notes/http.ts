import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { CurrentUser } from "@workspace/contract/api/authorization";
import { Api } from "@workspace/contract/api/api";
import { Notes } from "./notes.ts";

/**
 * The handlers of the notes group, without their dependencies provided so tests can substitute
 * `Notes`. Every handler reads the owner from `CurrentUser`, which `SessionMiddleware` provides.
 */
export const NotesApiHandlersNoDeps = HttpApiBuilder.group(
  Api,
  "notes",
  Effect.fn("NotesApi.handlers")(function* handlers(group) {
    const notes = yield* Notes;

    return group.handleAll({
      create: Effect.fn("NotesApi.create")(function* create({ payload }) {
        const { userId } = yield* CurrentUser;

        return yield* notes.create(userId, payload);
      }),
      get: Effect.fn("NotesApi.get")(function* get({ params }) {
        const { userId } = yield* CurrentUser;

        return yield* notes.get(userId, params.id);
      }),
      list: Effect.fn("NotesApi.list")(function* list() {
        const { userId } = yield* CurrentUser;

        return yield* notes.list(userId);
      }),
      remove: Effect.fn("NotesApi.remove")(function* remove({ params }) {
        const { userId } = yield* CurrentUser;

        yield* notes.remove(userId, params.id);
      }),
      update: Effect.fn("NotesApi.update")(function* update({ params, payload }) {
        const { userId } = yield* CurrentUser;

        return yield* notes.update(userId, params.id, payload);
      }),
    });
  }),
);
