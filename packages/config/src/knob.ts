import { Config, Context, Effect, Option, Predicate, Result, Schema } from "effect";

/**
 * The defect that `Knob.make` raises at construction when the schema lacks a required annotation.
 *
 * Annotations are not part of the schema's type, so the check runs when the module that declares
 * the knob loads, not when the compiler runs.
 */
export class MissingKnobAnnotationError extends Schema.TaggedError<MissingKnobAnnotationError>()(
  "MissingKnobAnnotationError",
  { annotation: Schema.Literals(["description", "default"]), key: Schema.String },
) {
  override get message(): string {
    return `Knob ${this.key} has no "${this.annotation}" annotation. Add it with Schema.annotate({ ${this.annotation}: ... }) where the knob is declared.`;
  }
}

/**
 * The defect that `Knob.encode` raises when a knob's schema is not a leaf and so has no one-string
 * form.
 */
class KnobNotLeafError extends Schema.TaggedError<KnobNotLeafError>()("KnobNotLeafError", {
  key: Schema.String,
}) {
  override get message(): string {
    return `Knob ${this.key} is not a leaf schema, so it has no one-string form.`;
  }
}

/**
 * A configuration knob: one annotated `Schema` turned into its key, default, tier (b) `Config`
 * and the string codec every tier shares.
 *
 * Tier (b) is the deploy-time value read through `Config`; tier (c) is a live source read through
 * {@link LiveKnobs}. `decode` and `encode` use the string-tree codec of the schema, so a value
 * means the same in `.env`, a CI variable and a live source. A knob's schema is a leaf schema
 * (a literal, boolean, number or string), so its string form is one string.
 *
 * Construct one with {@link Knob.make}.
 */
export class Knob<A> {
  /**
   * The environment-style name the knob is read under in every tier.
   */
  readonly key: string;
  /**
   * The value used when no tier supplies one, taken from the schema's `default` annotation.
   */
  readonly default: A;
  /**
   * The tier (b) reader: the schema at `key`, falling back to `default` when the key is absent.
   * An invalid supplied value fails through the error channel instead of falling back.
   */
  readonly config: Config.Config<A>;
  /**
   * Decode the string form of the knob, as read from a live source, into its value.
   */
  readonly decode: (raw: string) => Effect.Effect<A, Schema.SchemaError>;
  /**
   * Decode the string form synchronously, throwing the `Schema.SchemaError` when it is invalid. For
   * module-load validation, where a bad value must stop the load.
   */
  readonly decodeSync: (raw: string) => A;
  /**
   * Encode a knob value into its string form, as written to a live source.
   */
  readonly encode: (a: A) => Effect.Effect<string, Schema.SchemaError>;
  /**
   * Read an override of the knob from `<prefix><key>`, decoded by the knob's own schema: the value,
   * or `Option.none()` when the variable is absent. An invalid supplied value fails through the
   * error channel.
   */
  readonly override: (prefix: string) => Config.Config<Option.Option<A>>;

  private constructor(key: string, defaultValue: A, schema: Schema.Codec<A, unknown>) {
    const codec = Schema.toCodecStringTree(schema);

    this.key = key;
    this.default = defaultValue;
    this.config = Config.schema(schema, key).pipe(Config.withDefault(defaultValue));
    this.override = (prefix) => Config.option(Config.schema(schema, `${prefix}${key}`));
    this.decode = (raw) => Schema.decodeUnknownEffect(codec)(raw);
    this.decodeSync = Schema.decodeUnknownSync(codec);
    this.encode = (a) =>
      Schema.encodeEffect(codec)(a).pipe(
        Effect.flatMap((tree) =>
          Predicate.isString(tree)
            ? Effect.succeed(tree)
            : Effect.die(new KnobNotLeafError({ key })),
        ),
      );
  }

  /**
   * Construct a {@link Knob} from a schema annotated with `description` and `default`.
   *
   * `Config` does not read the `default` annotation, so this derives `Config.schema` plus
   * `Config.withDefault` from it: one annotated schema is the only place a knob states its default.
   *
   * @param key - The name the knob is read under in every tier.
   * @param schema - A leaf schema annotated with `description` and `default`.
   * @returns The knob for `key`.
   * @throws {MissingKnobAnnotationError} At module load, when `description` or `default` is absent
   *   from the schema.
   */
  static make<A>(key: string, schema: Schema.Codec<A, unknown>): Knob<A> {
    const annotations = Schema.resolveAnnotations(schema);

    const checked: Result.Result<A, MissingKnobAnnotationError> = Result.fromNullishOr(
      annotations?.description,
      () => new MissingKnobAnnotationError({ annotation: "description", key }),
    ).pipe(
      Result.flatMap(() =>
        Result.fromNullishOr(
          annotations?.default,
          () => new MissingKnobAnnotationError({ annotation: "default", key }),
        ),
      ),
    );

    // `Result.getOrThrow` raises the typed failure at module load.
    return new Knob(key, Result.getOrThrow(checked), schema);
  }
}

/**
 * The failure of a live source read, such as an unreachable store.
 */
export class LiveSourceError extends Schema.TaggedError<LiveSourceError>()("LiveSourceError", {
  cause: Schema.Unknown,
  source: Schema.String,
}) {
  override get message(): string {
    return `Live source ${this.source} could not be read.`;
  }
}

/**
 * A tier (c) value store that holds the string form of knobs by key.
 */
export interface LiveSource {
  /**
   * The store's name, used in log messages.
   */
  readonly name: string;
  /**
   * Read the string form of the value stored under `key`; `Option.none()` when it holds none.
   */
  readonly read: (key: string) => Effect.Effect<Option.Option<string>, LiveSourceError>;
}

/**
 * The shape of the {@link LiveKnobs} port.
 */
export interface LiveKnobsPort {
  /**
   * Resolve the tier (b) value of `knob` at construction and return the per-request reader.
   *
   * Construction fails with `Config.ConfigError` when the supplied tier (b) value is invalid, so a
   * Worker with a bad deploy-time value never takes traffic.
   */
  readonly bind: <A>(knob: Knob<A>) => Effect.Effect<Effect.Effect<A>, Config.ConfigError>;
}

/**
 * Annotate a log effect with the reason a knob resolved the way it did.
 *
 * @param effect - The log effect to annotate.
 * @param key - The knob's key.
 * @param reason - Why the knob resolved to the value it did.
 * @returns The log effect with `knob.<key>.reason` set.
 */
const withReason = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  key: string,
  reason: "no_adapter" | "schema_rejected",
): Effect.Effect<A, E, R> => effect.pipe(Effect.annotateLogs(`knob.${key}.reason`, reason));

/**
 * The port through which a Worker reads a knob after construction.
 *
 * Precedence is the schema default, then tier (b), then tier (c). The default value attaches no
 * live source: it binds tier (b) at construction, logs `knob.<KEY>.reason` as `no_adapter`, and
 * returns a reader that yields that value on every request.
 */
export const LiveKnobs = Context.Reference<LiveKnobsPort>("@workspace/config/LiveKnobs", {
  defaultValue: () => ({
    bind: <A>(knob: Knob<A>) =>
      knob.config.pipe(
        Effect.tap(() =>
          withReason(
            Effect.logInfo(`Knob ${knob.key} has no live adapter.`),
            knob.key,
            "no_adapter",
          ),
        ),
        Effect.map((value) => Effect.succeed(value)),
      ),
  }),
});

/**
 * Construct a {@link LiveKnobsPort} that reads tier (c) from `source`.
 *
 * An absent or empty live value, a failed read, and a value the knob's schema rejects all yield
 * the tier (b) value. A rejected value logs once at `Error`, annotated `knob.<KEY>.reason` as
 * `schema_rejected`, per distinct value. The set of rejected values belongs to the returned value,
 * so it lasts as long as the isolate that built it.
 *
 * @param source - The live store to read.
 * @returns The port value that provides {@link LiveKnobs}.
 */
export const fromSource = (source: LiveSource): LiveKnobsPort => {
  const rejected = new Set<string>();

  return {
    bind: <A>(knob: Knob<A>) =>
      Effect.gen(function* bind() {
        const base = yield* knob.config;

        const read: Effect.Effect<A> = Effect.gen(function* read() {
          const raw = yield* source
            .read(knob.key)
            .pipe(
              Effect.catchTag("LiveSourceError", (error) =>
                Effect.logWarning(
                  `Live source ${source.name} failed reading ${knob.key}.`,
                  error,
                ).pipe(Effect.as(Option.none<string>())),
              ),
            );

          if (Option.isNone(raw) || raw.value === "") {
            return base;
          }

          return yield* knob.decode(raw.value).pipe(
            Effect.catch(() => {
              const seen = `${knob.key}\u0000${raw.value}`;

              if (rejected.has(seen)) {
                return Effect.succeed(base);
              }

              rejected.add(seen);

              return withReason(
                Effect.logError("knob.live.rejected").pipe(
                  Effect.annotateLogs({ "knob.key": knob.key, "knob.source": source.name }),
                ),
                knob.key,
                "schema_rejected",
              ).pipe(Effect.as(base));
            }),
          );
        });

        yield* read;

        return read;
      }),
  };
};
