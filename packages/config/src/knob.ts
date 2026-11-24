import { Config, Effect, Predicate, Result, Schema } from "effect";
import type { Option } from "effect";

/**
 * The defect that `Knob.make` raises at construction when the schema lacks a required annotation.
 *
 * Annotations are not part of the schema's type, so the check runs when the module that declares
 * the knob loads, not when the compiler runs.
 */
export class MissingKnobAnnotationError extends Schema.TaggedError<
  MissingKnobAnnotationError,
  { readonly brand: unique symbol }
>()("MissingKnobAnnotationError", {
  annotation: Schema.Literals(["description", "default"]),
  key: Schema.String,
}) {
  override get message() {
    return `Knob ${this.key} has no "${this.annotation}" annotation. Add it with Schema.annotate({ ${this.annotation}: ... }) where the knob is declared.`;
  }
}

/**
 * The defect that `Knob.encode` raises when a knob's schema is not a leaf and so has no one-string
 * form.
 */
class KnobNotLeafError extends Schema.TaggedError<
  KnobNotLeafError,
  { readonly brand: unique symbol }
>()("KnobNotLeafError", {
  key: Schema.String,
}) {
  override get message() {
    return `Knob ${this.key} is not a leaf schema, so it has no one-string form.`;
  }
}

/**
 * A configuration knob: one annotated `Schema` turned into its key, default, tier (b) `Config`
 * and the string codec every tier shares.
 *
 * Tier (b) is the deploy-time value read through `Config`; tier (c) is a live source read through
 * `LiveKnobs`. `decode` and `encode` use the string-tree codec of the schema, so a value
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
    this.decode = (raw) => Schema.decodeEffect(codec)(raw);
    this.decodeSync = Schema.decodeUnknownSync(codec);
    this.encode = (a) =>
      Schema.encodeEffect(codec)(a).pipe(
        Effect.filterOrElse(Predicate.isString, () => Effect.die(new KnobNotLeafError({ key }))),
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
  static make<A>(key: string, schema: Schema.Codec<A, unknown>) {
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
