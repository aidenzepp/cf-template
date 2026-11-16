import { Effect, Schema } from "effect";

/**
 * A theme value cannot become an email-safe value. The message names the token or value and the
 * form that is accepted.
 */
export class EmailTokenError extends Schema.TaggedError<
  EmailTokenError,
  { readonly brand: unique symbol }
>()("EmailTokenError", { message: Schema.String }) {}

/**
 * The `oklch()` forms the theme stylesheet writes: `oklch(L C H)` and `oklch(L C H / A)`, where `L`
 * and `A` are a number or a percentage and `H` is a number of degrees.
 */
const OKLCH =
  /^oklch\(\s*(?<lightness>(?:\d+(?:\.\d+)?|\.\d+)%?)\s+(?<chroma>(?:\d+(?:\.\d+)?|\.\d+))\s+(?<hue>(?:\d+(?:\.\d+)?|\.\d+))(?:deg)?(?:\s*\/\s*(?<alpha>(?:\d+(?:\.\d+)?|\.\d+)%?))?\s*\)$/iu;

/**
 * An opaque six-digit hex color, the only form a surface may take.
 */
const HEX = /^#[\da-f]{6}$/u;

/**
 * Read a number that may carry a percent sign.
 *
 * @param text - The number as written, such as `0.5` or `10%`.
 * @returns The number, with a percentage divided by 100.
 */
const fraction = (text: string): number =>
  text.endsWith("%") ? Number(text.slice(0, -1)) / 100 : Number(text);

/**
 * Encode a linear-light channel as an sRGB channel, clamped to the gamut.
 *
 * @param linear - The linear-light channel value.
 * @returns The gamma-encoded channel in `0..1`.
 */
const encode = (linear: number): number => {
  const clamped = Math.min(1, Math.max(0, linear));

  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
};

/**
 * Convert an OKLab color to gamma-encoded sRGB channels. The matrices are Björn Ottosson's OKLab
 * definition; a channel outside the sRGB gamut is clamped, which gives the hex Tailwind publishes
 * for its own `oklch()` palette (`red-600` is `#e7000b`).
 *
 * The math lives here because no dependency the repository declares converts `oklch()`: `postcss`
 * parses the value without evaluating it, and `lightningcss` is installed only as a transitive
 * dependency of the toolchain.
 *
 * @param lightness - The OKLab lightness, `0..1`.
 * @param chroma - The OKLCH chroma.
 * @param hue - The OKLCH hue in degrees.
 * @returns The red, green and blue channels in `0..1`.
 * @see https://bottosson.github.io/posts/oklab/
 */
const toSrgb = (lightness: number, chroma: number, hue: number): ReadonlyArray<number> => {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
};

/**
 * Write channels in `0..1` as a lowercase six-digit hex color.
 *
 * @param channels - The red, green and blue channels.
 * @returns The `#rrggbb` text, each channel rounded to the nearest of 255.
 */
const toHex = (channels: ReadonlyArray<number>): string =>
  `#${channels
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, channel)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/**
 * Convert an `oklch()` color to an opaque six-digit sRGB hex color, which every email client
 * reads. A color with alpha below 1 is composited over `surface` in gamma-encoded sRGB, the way a
 * browser blends it, because partial-alpha colors are not read by every client.
 *
 * Gmail drops every inline style on an element that uses `oklch()`, and Outlook, Yahoo and AOL read
 * neither `oklch()` nor CSS variables, so a block writes only the hex this function returns.
 * Channels outside the sRGB gamut are clamped.
 *
 * @param value - The color as written in the theme: `oklch(L C H)` or `oklch(L C H / A)`.
 * @param surface - The opaque `#rrggbb` color the value sits on; required when the value has an
 *   alpha below 1 and ignored otherwise.
 * @returns The lowercase `#rrggbb` color, or an {@link EmailTokenError} naming the value when it is
 *   not one of the accepted forms, or when it has alpha and `surface` is missing or not `#rrggbb`.
 * @see https://www.caniemail.com/features/css-modern-color/
 */
export const oklchToHex = (
  value: string,
  surface?: string,
): Effect.Effect<string, EmailTokenError> => {
  const parts = OKLCH.exec(value.trim())?.groups;

  if (parts === undefined) {
    return Effect.fail(
      new EmailTokenError({
        message: `cannot read "${value}" as a color; write it as oklch(L C H) or oklch(L C H / A)`,
      }),
    );
  }

  const { alpha, chroma, hue, lightness } = parts;
  const srgb = toSrgb(fraction(lightness), Number(chroma), Number(hue));
  const opacity = alpha === undefined ? 1 : Math.min(1, fraction(alpha));

  if (opacity === 1) {
    return Effect.succeed(toHex(srgb));
  }

  if (surface === undefined || !HEX.test(surface)) {
    return Effect.fail(
      new EmailTokenError({
        message: `"${value}" has alpha, so it needs an opaque #rrggbb surface to sit on; got ${surface === undefined ? "none" : `"${surface}"`}`,
      }),
    );
  }

  const under = [1, 3, 5].map(
    (start) => Number.parseInt(surface.slice(start, start + 2), 16) / 255,
  );

  return Effect.succeed(
    toHex(srgb.map((channel, index) => channel * opacity + (under[index] ?? 0) * (1 - opacity))),
  );
};
