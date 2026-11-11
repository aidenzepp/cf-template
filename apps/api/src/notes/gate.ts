import { Effect, Layer } from "effect";
import { ExampleFeatureGate } from "@workspace/contract/api/notes";
import { NotesUnavailable } from "@workspace/contract/domain/note-errors";
import { LiveKnobs } from "@workspace/config/knob";
import { ExampleFeatureKnob } from "./knob.ts";

/**
 * The implementation of `ExampleFeatureGate`: it reads `EXAMPLE_FEATURE_ENABLED` through the
 * `LiveKnobs` port on every request and fails with 404 `NotesUnavailable` while it is `false`.
 *
 * The contract declares the gate before `SessionMiddleware`, so the session middleware runs first
 * and an anonymous caller never reaches this check.
 */
export const ExampleFeatureGateLive = Layer.effect(
  ExampleFeatureGate,
  Effect.gen(function* buildGate() {
    const knobs = yield* LiveKnobs;
    const enabled = yield* knobs.bind(ExampleFeatureKnob);

    return ExampleFeatureGate.of((httpEffect) =>
      Effect.gen(function* gate() {
        if (!(yield* enabled)) {
          return yield* new NotesUnavailable();
        }

        return yield* httpEffect;
      }),
    );
  }),
);
