# Examples

The examples add a `reminders` slice next to `notes`. Each shows one attach line and where it goes.

## POSITIVE: a `Layer.provide` line in the Worker's layer composition

The service the handlers need is provided once, next to the services the other slices provide.

```ts
const handlers = SlicesLayer.pipe(
  Layer.provide(Layer.succeed(Notes, notes)),
  Layer.provide(Layer.succeed(Reminders, reminders)),
);
```

## POSITIVE: a `.add(...)` line on the `HttpApi` group list

The group is added before the middleware line, because the middleware wraps only the groups added
before it.

```ts
export const Api = HttpApi.make("Api")
  .add(NotesApiGroup)
  .add(RemindersApiGroup)
  .add(SystemApi)
  .middleware(HttpApiMiddleware.ProblemDetails);
```

## POSITIVE: an entry in the multi-line `Layer.mergeAll(` of the services layer

One handler layer per line. A `mergeAll(` with entries on the same line as the bracket hides the
entry from the check that finds attach lines.

```ts
const handlers = Layer.mergeAll(
  SystemApiHandlers,
  RemindersApiHandlersNoDeps,
);
```

## POSITIVE: one entry appended to a named core `as const` array

The array is named in the attach-file list; the slice appends one identifier and nothing else.

```ts
export const registry = [
  DocsEnabledKnob,
  RemindersKnob,
] as const;
```

## NEGATIVE: a second attach line in one attach file

Two lines for one slice in `worker.ts` means the slice is leaking into shared code. Move the
second dependency into the slice's own layer so one line attaches it.

```ts
const handlers = Layer.mergeAll(
  SystemApiHandlers,
  RemindersApiHandlersNoDeps,
  RemindersExtraHandlers,
);
```

## POSITIVE: the `exports` edit for a new domain module

One subpath per module, each pointing at its source file, and no barrel.

```json
 "exports": {
   "./domain/session": "./src/domain/session.ts",
+  "./domain/reminders/reminder": "./src/domain/reminders/reminder.ts",
+  "./domain/reminders/reminder-errors": "./src/domain/reminders/reminder-errors.ts",
   "./api/system": "./src/api/system.ts",
+  "./api/reminders": "./src/api/reminders.ts",
   "./api/api": "./src/api/api.ts"
 }
```

## NEGATIVE: a barrel entry

A `"./domain/reminders": "./src/domain/reminders/index.ts"` entry re-exports the slice from one
module, so an import pulls in every file of the slice and removal leaves importers behind.
