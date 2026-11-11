import { Effect, Layer } from "effect";
import { AppDatabase } from "../app-database.ts";
import { Notes, NotesDatabase } from "./notes.ts";

/**
 * The notes service of one isolate, on the app database. The Worker builds it once when the isolate
 * starts and every execution shares it; see `ApiWorkerIsolateLayers`.
 */
export const NotesIsolateLive = Notes.layer().pipe(
  Layer.provide(Layer.effect(NotesDatabase, Effect.service(AppDatabase))),
);
