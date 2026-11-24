import { Effect, FileSystem, Path } from "effect";
import type { BrowserContext } from "playwright";
import { HYDRATED, Harness, promised, runInHarness } from "./browser-harness.ts";

/**
 * The half steps of Tailwind's spacing scale that stock shadcn uses: 0.5, 1.5, 2.5 and 3.5 units.
 */
const HALF_STEPS: ReadonlyArray<number> = [0.5, 1.5, 2.5, 3.5];

/**
 * The last whole step of the scale, in units: `p-96`, 24 rem at the default unit. Tailwind 4
 * accepts any multiple and defines no end, so the end is the largest step of Tailwind 3's scale.
 */
const LAST_STEP = 96;

/**
 * The spacing steps, in CSS px, a padding, margin or gap may take: 0, every whole multiple of the
 * `--spacing` unit up to {@link LAST_STEP}, and the {@link HALF_STEPS}. The unit is read from
 * `packages/ui/node_modules/tailwindcss/theme.css`, the theme the app builds with (0.25 rem, 4 px,
 * so the steps run 0, 2, 4, 6, 8, 10, 12, 14, 16, then every 4 px to 384). Arbitrary values are
 * banned by the lint preset, so a value off this scale, such as 13 px, is a finding.
 *
 * @param theme - The text of Tailwind's `theme.css`.
 * @returns The steps in CSS px, or an empty list when the theme has no unit in rem.
 */
const spacingSteps = (theme: string) => {
  const { rem: unit } = /--spacing:\s*(?<rem>[\d.]+)rem\s*;/u.exec(theme)?.groups ?? {};

  if (unit === undefined) {
    return [];
  }

  const px = Number(unit) * 16;

  return [
    0,
    ...Array.from({ length: LAST_STEP }, (_, index) => (index + 1) * px),
    ...HALF_STEPS.map((half) => half * px),
  ];
};

/**
 * The viewport widths, in CSS px, the audit runs at: a phone and a laptop.
 */
const WIDTHS = [390, 1280] as const;

/**
 * The viewport height, in CSS px, at every width.
 */
const HEIGHT = 900;

/**
 * One rule a visible element broke: the rule, the element and the offending value.
 */
interface Finding {
  readonly element: string;
  readonly rule: "color" | "spacing" | "radius" | "scroll" | "target";
  readonly value: string;
}

/**
 * The result of one audit: the theme the page rendered and what it broke.
 */
interface Audit {
  readonly dark: boolean;
  readonly findings: ReadonlyArray<Finding>;
}

/**
 * What the in-page audit reads: the theme colors of both themes, the theme's radius token values
 * as CSS text, and the spacing steps.
 */
interface AuditInput {
  readonly dark: ReadonlyArray<string>;
  readonly light: ReadonlyArray<string>;
  readonly radii: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<number>;
}

/**
 * A theme color line of the `colors:` block of `DESIGN.md`: ` name: "value"`.
 */
const COLOR_LINE = /^ {2}(?<name>[\w-]+): "(?<value>[^"]+)"$/u;

/**
 * The theme colors of `DESIGN.md`, the file the generator writes from
 * `packages/ui/src/styles/globals.css`. A `-dark` name is the dark theme's value of the token.
 *
 * @param text - The text of `DESIGN.md`.
 * @returns The light and dark theme colors.
 */
const themeColors = (text: string) => {
  const lines = text.split("\n");
  const start = lines.indexOf("colors:") + 1;
  const end = lines.findIndex((line, index) => index >= start && !line.startsWith("  "));

  const entries = lines
    .slice(start, end)
    .flatMap((line) => (COLOR_LINE.exec(line)?.groups === undefined ? [] : [line]))
    .map((line) => COLOR_LINE.exec(line)?.groups ?? { name: "", value: "" });

  return {
    dark: entries.filter(({ name }) => name.endsWith("-dark")).map(({ value }) => value),
    light: entries.filter(({ name }) => !name.endsWith("-dark")).map(({ value }) => value),
  };
};

/**
 * A `--radius-*` token declaration of the theme block of `globals.css`: `--radius-sm: ...;`. The
 * `:root` base `--radius` has no step name, so it does not match.
 */
const RADIUS_TOKEN = /--radius-[\w-]+:\s*(?<value>[^;]+);/gu;

/**
 * The values of the radius tokens (`--radius-sm` to `--radius-4xl`) that the Tailwind theme block
 * of `packages/ui/src/styles/globals.css` declares, as CSS text such as `calc(var(--radius) *
 * 0.6)`. The audit reads this file, not the `rounded:` block of `DESIGN.md`, because the
 * generator leaves `--radius-lg` (`var(--radius)`) out of that block. The page resolves each value
 * against its own `--radius`, so the audit never repeats the theme's arithmetic.
 *
 * @param css - The text of `globals.css`.
 * @returns The value of each radius token, in declaration order.
 */
const themeRadii = (css: string) =>
  [...css.matchAll(RADIUS_TOKEN)].flatMap(({ groups }) => {
    const { value = "" } = groups ?? {};

    return value.trim() === "" ? [] : [value.trim()];
  });

// The DOM the in-page audit reads, declared here rather than through the `dom` lib: the lib would
// change the global types of every file the root `tsconfig.json` checks.

/**
 * The bounding box of an element, in CSS px.
 */
interface Box {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

/**
 * A value of the Typed OM: a single length such as `CSSUnitValue { value: 52, unit: "px" }` has a
 * unit and a value; a keyword (`auto`, `normal`) or a math value has neither.
 */
type TypedValue =
  | { readonly unit: string; readonly value: number }
  | { readonly unit?: undefined; readonly value?: string };

/**
 * The part of a DOM element the in-page audit reads.
 */
interface Element {
  readonly checkVisibility: (options: { readonly visibilityProperty: boolean }) => boolean;
  readonly children: Iterable<Element>;
  readonly classList: Iterable<string> & { readonly contains: (token: string) => boolean };
  readonly computedStyleMap: () => {
    readonly get: (property: string) => TypedValue | undefined;
  };
  readonly contains: (other: Element) => boolean;
  readonly getBoundingClientRect: () => Box;
  readonly getClientRects: () => { readonly length: number };
  readonly localName: string;
  readonly matches: (selector: string) => boolean;
  readonly namespaceURI: string | null;
  readonly parentElement: Element | null;
  readonly textContent: string;
}

/**
 * A `div` the in-page audit creates to let the page resolve a CSS value.
 */
interface Probe extends Element {
  readonly remove: () => void;
  readonly style: { cssText: string };
}

/**
 * The part of a computed style the in-page audit reads.
 */
interface Style {
  readonly backgroundColor: string;
  readonly boxShadow: string;
  readonly color: string;
  readonly display: string;
  readonly fill: string;
  readonly getPropertyValue: (property: string) => string;
  readonly outlineColor: string;
  readonly outlineStyle: string;
  readonly outlineWidth: string;
  readonly stroke: string;
  readonly textDecorationColor: string;
  readonly textDecorationLine: string;
}

declare const document: {
  readonly body: Element & {
    readonly append: (child: Probe) => void;
    readonly insertAdjacentHTML: (position: "beforeend", html: string) => void;
    readonly querySelectorAll: (selector: string) => Iterable<Element>;
  };
  readonly createElement: (tag: "div") => Probe;
  readonly documentElement: Element & {
    readonly clientWidth: number;
    readonly scrollWidth: number;
  };
};

declare const getComputedStyle: (element: Element) => Style;

// The in-page audit. Playwright serializes it into the page as one script (`inPageScript`), so each
// function below reads only its arguments and the other in-page functions, by name.

/**
 * A computed length in CSS px, such as `52px`.
 *
 * @param text - The computed length.
 * @returns The number of px.
 */
const pixels = (text: string) => Number(text.replace(/px$/u, ""));

/**
 * A short CSS path of an element, for a finding: up to four steps from `body`.
 *
 * @param element - The element.
 * @returns The path, such as `body:nth-child(2) > p:nth-child(4)`.
 */
const nameOf = (element: Element) => {
  const steps: Array<string> = [];
  let current: Element | null = element;

  while (current !== null && current !== document.documentElement && steps.length < 4) {
    const parent: Element | null = current.parentElement;
    const index = parent === null ? 0 : [...parent.children].indexOf(current) + 1;
    const classes = [...current.classList].slice(0, 3).map((item) => `.${item}`);

    steps.unshift(`${current.localName}${classes.join("")}:nth-child(${index})`);
    current = parent;
  }

  return steps.join(" > ");
};

/**
 * One channel of a computed color: a number, a percentage of `scale`, or `none`.
 *
 * @param text - The channel.
 * @param scale - What 100% is.
 * @returns The channel's value.
 */
const channel = (text: string, scale: number) => {
  if (text === "none") {
    return 0;
  }

  return text.endsWith("%") ? (Number(text.slice(0, -1)) / 100) * scale : Number(text);
};

/**
 * Linear sRGB channels in OKLab, after Björn Ottosson's matrices.
 *
 * @param rgb - The linear red, green and blue, 0 to 1.
 * @returns The OKLab lightness, a and b.
 */
const linearToOklab = ([r, g, b]: readonly [number, number, number]) => {
  const long = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const medium = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const short = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return [
    0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  ] as const;
};

/**
 * Gamma-encoded sRGB channels in OKLab.
 *
 * @param parts - The red, green and blue channels as computed.
 * @param scale - What the full channel is: 255 for `rgb()`, 1 for `color(srgb ...)`.
 * @returns The OKLab lightness, a and b.
 */
const srgbToOklab = (parts: ReadonlyArray<string>, scale: number) => {
  const [r = 0, g = 0, b = 0] = parts.map((part) => {
    const value = channel(part, scale) / scale;

    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return linearToOklab([r, g, b]);
};

/**
 * A computed color in OKLab, with its alpha. Chromium computes `rgb()`, `oklch()`, `oklab()` and
 * `color(srgb ...)`.
 *
 * @param text - The computed color.
 * @returns The OKLab lightness, a, b and alpha, or nothing for another form.
 */
const toOklab = (text: string) => {
  const groups = /^(?<fn>rgba?|oklch|oklab|color)\((?<body>.*)\)$/u.exec(text.trim())?.groups;
  const [main = "", slash] = (groups?.body ?? "").split("/");
  const parts = main.replaceAll(",", " ").trim().split(/\s+/u);
  const space = groups?.fn === "color" ? parts.shift() : groups?.fn;
  const alphaText = slash?.trim() ?? parts[3];
  const alpha = alphaText === undefined ? 1 : channel(alphaText, 1);
  const [first = "0", second = "0", third = "0"] = parts;

  if (space === "oklab") {
    return [channel(first, 1), channel(second, 0.4), channel(third, 0.4), alpha];
  }

  if (space === "oklch") {
    const chroma = channel(second, 0.4);
    const hue = (channel(third, 1) * Math.PI) / 180;

    return [channel(first, 1), chroma * Math.cos(hue), chroma * Math.sin(hue), alpha];
  }

  return space === "rgb" || space === "rgba" || space === "srgb"
    ? [...srgbToOklab([first, second, third], space === "srgb" ? 1 : 255), alpha]
    : undefined;
};

/**
 * Whether a computed color is tokened: transparent, or a theme color of the active theme with at
 * most its alpha changed, which is what `bg-primary/90` and other `color-mix` variants resolve to.
 *
 * @param text - The computed color.
 * @param theme - The theme colors of the active theme, in OKLab.
 * @returns True when the color is tokened.
 */
const isTokened = (text: string, theme: ReadonlyArray<ReadonlyArray<number>>) => {
  const lab = toOklab(text);

  if (lab === undefined) {
    return false;
  }

  const [lightness, a, b, alpha] = lab;

  return (
    alpha === 0 ||
    theme.some(
      ([tokenLightness = 0, tokenA = 0, tokenB = 0]) =>
        Math.hypot(lightness - tokenLightness, a - tokenA, b - tokenB) < 0.005,
    )
  );
};

/**
 * The colors an element paints: its text and background, and each border, outline, decoration,
 * shadow and SVG paint it draws.
 *
 * @param element - The element.
 * @returns The property and computed color of each paint.
 */
const paintsOf = (element: Element) => {
  const style = getComputedStyle(element);

  const paints: Array<readonly [string, string]> = [
    ["color", style.color],
    ["background-color", style.backgroundColor],
  ];

  for (const side of ["top", "right", "bottom", "left"]) {
    const line = style.getPropertyValue(`border-${side}-style`);

    if (pixels(style.getPropertyValue(`border-${side}-width`)) > 0 && line !== "none") {
      paints.push([`border-${side}-color`, style.getPropertyValue(`border-${side}-color`)]);
    }
  }

  if (style.outlineStyle !== "none" && pixels(style.outlineWidth) > 0) {
    paints.push(["outline-color", style.outlineColor]);
  }

  if (style.textDecorationLine !== "none") {
    paints.push(["text-decoration-color", style.textDecorationColor]);
  }

  for (const shadow of style.boxShadow.match(/(?:rgba?|oklch|oklab|color)\([^)]*\)/gu) ?? []) {
    paints.push(["box-shadow", shadow]);
  }

  const svgPaints =
    element.namespaceURI === "http://www.w3.org/2000/svg" ? [style.fill, style.stroke] : [];

  for (const [index, value] of svgPaints.entries()) {
    if (value !== "none" && !value.startsWith("url(")) {
      paints.push([index === 0 ? "fill" : "stroke", value]);
    }
  }

  return paints;
};

/**
 * The paddings, margins and gaps of an element off the spacing steps. `auto`, `normal` and
 * percentages are not lengths and are not checked.
 *
 * @param element - The element.
 * @param steps - The spacing steps, in CSS px.
 * @returns Each offending property and value.
 */
const offSetSpacing = (element: Element, steps: ReadonlyArray<number>) => {
  const map = element.computedStyleMap();

  return [
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "row-gap",
    "column-gap",
  ].flatMap((property) => {
    const value = map.get(property);

    if (value?.unit !== "px") {
      return [];
    }

    const px = value.value;

    return steps.includes(Math.round(Math.abs(px) * 100) / 100) ? [] : [`${property} ${px}px`];
  });
};

/**
 * The pixel value of each radius token, as the page computes it. A probe element takes each token
 * value (`calc(var(--radius) * 0.6)`, `var(--radius)`), so `--radius` resolves as it does for a
 * real element and the numbers match what Chromium computes for `rounded-sm` to `rounded-4xl`.
 *
 * @param values - The radius token values, as CSS text.
 * @returns The value of each token in CSS px.
 */
const radiusSteps = (values: ReadonlyArray<string>) => {
  const probe = document.createElement("div");

  document.body.append(probe);

  const steps = values.map((value) => {
    probe.style.cssText = `border-top-left-radius: ${value}`;

    return pixels(getComputedStyle(probe).getPropertyValue("border-top-left-radius"));
  });

  probe.remove();

  return steps;
};

/**
 * Whether one computed radius, the horizontal or vertical half of a corner, is tokened: `0`, a
 * token value, or at least the element's longer side, which only a pill or circle reaches
 * (`rounded-full` computes to `3.35544e+07px` in Chromium, which `Number` reads). A percentage
 * cannot be compared with a token, so `50%` or more counts as full-round, as does `0%`, and any
 * other percentage is not tokened. A value that is not a number is not tokened.
 *
 * @param radius - The computed radius, in px or `%`.
 * @param steps - The pixel value of each radius token.
 * @param longer - The longer side of the element's box, in CSS px.
 * @returns True when the radius is tokened.
 */
const isTokenedRadius = (radius: string, steps: ReadonlyArray<number>, longer: number) => {
  if (radius.endsWith("%")) {
    const percent = Number(radius.slice(0, -1));

    return percent === 0 || percent >= 50;
  }

  const px = pixels(radius);

  return px === 0 || px >= longer || steps.some((step) => Math.abs(px - step) < 0.005);
};

/**
 * The corners of an element whose computed radius is not tokened.
 *
 * @param element - The element.
 * @param steps - The pixel value of each radius token.
 * @returns Each offending property and computed value.
 */
const offTokenRadii = (element: Element, steps: ReadonlyArray<number>) => {
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  const longer = Math.max(box.width, box.height);

  return ["top-left", "top-right", "bottom-right", "bottom-left"].flatMap((corner) => {
    const property = `border-${corner}-radius`;
    const value = style.getPropertyValue(property);

    // A corner computes to one radius, or two for an elliptical corner: horizontal, then vertical.
    return value
      .trim()
      .split(/\s+/u)
      .every((radius) => isTokenedRadius(radius, steps, longer))
      ? []
      : [`${property} ${value}`];
  });
};

/**
 * Sideways scroll: each element that ends past the viewport while its parent does not, or the
 * document when no element does.
 *
 * @param elements - The visible elements.
 * @returns A finding per element past the viewport.
 */
const scrollFindings = (elements: ReadonlyArray<Element>) => {
  const viewport = document.documentElement.clientWidth;
  const { scrollWidth } = document.documentElement;

  if (scrollWidth <= viewport) {
    return [];
  }

  const past = (element: Element | null) => {
    const box = element?.getBoundingClientRect();

    return box !== undefined && (box.right > viewport + 0.5 || box.left < -0.5);
  };

  const culprits = elements.filter((element) => past(element) && !past(element.parentElement));

  return (culprits.length > 0 ? culprits : [document.documentElement]).map((element) => ({
    element: nameOf(element),
    rule: "scroll" as const,
    value: `scrollWidth ${scrollWidth}px at a ${viewport}px viewport`,
  }));
};

/**
 * Whether the 24 px circle centered on an undersized target meets another target, or the circle of
 * another undersized target: the spacing exception of WCAG 2.2 2.5.8 does not apply.
 *
 * @param index - The undersized target.
 * @param targets - Every target.
 * @param boxes - The bounding box of each target.
 * @returns True when the target is crowded.
 */
const isCrowded = (index: number, targets: ReadonlyArray<Element>, boxes: ReadonlyArray<Box>) => {
  const element = targets[index];
  const box = boxes[index];

  if (element === undefined || box === undefined) {
    return false;
  }

  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;

  return targets.some((other, otherIndex) => {
    const otherBox = boxes[otherIndex];

    if (otherIndex === index || otherBox === undefined || other.contains(element)) {
      return false;
    }

    if (element.contains(other)) {
      return false;
    }

    if (otherBox.width < 24 || otherBox.height < 24) {
      const otherX = otherBox.left + otherBox.width / 2;
      const otherY = otherBox.top + otherBox.height / 2;

      return Math.hypot(x - otherX, y - otherY) < 24;
    }

    const dx = Math.max(otherBox.left - x, 0, x - otherBox.right);
    const dy = Math.max(otherBox.top - y, 0, y - otherBox.bottom);

    return Math.hypot(dx, dy) < 12;
  });
};

/**
 * WCAG 2.2 2.5.8 Target Size (Minimum): a target is at least 24 by 24 CSS px, unless the spacing
 * exception ({@link isCrowded}) or the inline exception (a target in a sentence) applies. The
 * equivalent, user agent and essential exceptions need a human judgment and are not automated.
 *
 * @param elements - The visible elements.
 * @returns A finding per undersized target no exception covers.
 */
const targetFindings = (elements: ReadonlyArray<Element>) => {
  const targets = elements.filter(
    (element) =>
      element.matches(
        'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="slider"], [tabindex]:not([tabindex="-1"])',
      ) && !element.matches(":disabled"),
  );

  const boxes = targets.map((element) => element.getBoundingClientRect());

  return targets.flatMap((element, index) => {
    const box = boxes[index];
    const parentText = element.parentElement?.textContent.trim().length ?? 0;

    const inline =
      getComputedStyle(element).display === "inline" &&
      parentText > element.textContent.trim().length;

    if (box === undefined || (box.width >= 24 && box.height >= 24) || inline) {
      return [];
    }

    return isCrowded(index, targets, boxes)
      ? [
          {
            element: nameOf(element),
            rule: "target" as const,
            value: `${box.width}x${box.height}px`,
          },
        ]
      : [];
  });
};

/**
 * The audit of the visible elements of the page at the current viewport width.
 *
 * @param input - The theme colors, the radius token values and the spacing steps.
 * @returns What the visible elements broke.
 */
const auditInPage = (input: AuditInput) => {
  const dark = document.documentElement.classList.contains("dark");

  const theme = (dark ? input.dark : input.light).flatMap((value) => {
    const lab = toOklab(value);

    return lab === undefined ? [] : [lab];
  });

  const radii = radiusSteps(input.radii);

  const elements = [document.body, ...document.body.querySelectorAll("*")].filter(
    (element) =>
      element.checkVisibility({ visibilityProperty: true }) && element.getClientRects().length > 0,
  );

  const styled = elements.flatMap((element) => {
    const untokened = paintsOf(element).filter(([, value]) => !isTokened(value, theme));
    const offSet = offSetSpacing(element, input.steps);
    const offRadii = offTokenRadii(element, radii);

    return [
      ...(untokened.length > 0
        ? [
            {
              element: nameOf(element),
              rule: "color" as const,
              value: untokened.map(([property, value]) => `${property} ${value}`).join("; "),
            },
          ]
        : []),
      ...(offSet.length > 0
        ? [{ element: nameOf(element), rule: "spacing" as const, value: offSet.join("; ") }]
        : []),
      ...(offRadii.length > 0
        ? [{ element: nameOf(element), rule: "radius" as const, value: offRadii.join("; ") }]
        : []),
    ];
  });

  return [...styled, ...scrollFindings(elements), ...targetFindings(elements)];
};

/**
 * The in-page functions, in the order the script declares them.
 */
const IN_PAGE = [
  pixels,
  nameOf,
  channel,
  linearToOklab,
  srgbToOklab,
  toOklab,
  isTokened,
  paintsOf,
  offSetSpacing,
  radiusSteps,
  isTokenedRadius,
  offTokenRadii,
  scrollFindings,
  isCrowded,
  targetFindings,
  auditInPage,
] as const;

/**
 * The script `page.evaluate` runs: the in-page functions, declared by name, then the audit.
 *
 * @param input - The theme colors, the radius token values and the spacing steps.
 * @returns The script.
 */
const inPageScript = (input: AuditInput) =>
  `(() => {\n${IN_PAGE.map((fn) => `const ${fn.name} = ${fn.toString()};`).join("\n")}\nreturn auditInPage(${JSON.stringify(input)});\n})()`;

/**
 * Open `target` in a second tab, wait for React to hydrate it, optionally add `inject` to its
 * body, and audit it at each width of {@link WIDTHS}.
 *
 * @param context - The Playwright browser context of the test run.
 * @param target - A path on the harness, or a full URL.
 * @param cookie - A `name=value` cookie to send to the harness.
 * @param colorScheme - The `prefers-color-scheme` to emulate.
 * @param inject - HTML added at the end of the body before the audit, for a violation fixture.
 * @returns The theme the page rendered and what its visible elements broke.
 */
const audit = Effect.fn("audit")(function* audit(
  context: BrowserContext,
  target: string,
  cookie: string | undefined,
  colorScheme: "light" | "dark",
  inject: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("../../../", import.meta.url));
  const colors = themeColors(yield* fs.readFileString(path.join(root, "DESIGN.md")));

  const steps = spacingSteps(
    yield* fs.readFileString(
      path.join(root, "packages", "ui", "node_modules", "tailwindcss", "theme.css"),
    ),
  );

  if (steps.length === 0) {
    return yield* Effect.die("tailwindcss/theme.css has no `--spacing` unit in rem.");
  }

  const radii = themeRadii(
    yield* fs.readFileString(path.join(root, "packages", "ui", "src", "styles", "globals.css")),
  );

  if (radii.length === 0) {
    return yield* Effect.die("globals.css declares no `--radius-*` token.");
  }

  const isPath = target.startsWith("/");
  const { origin } = isPath ? yield* Harness : { origin: "" };

  return yield* Effect.gen(function* inPage() {
    const page = yield* Effect.acquireRelease(
      promised("Opening a tab", () => context.newPage()),
      (opened) => Effect.promise(() => opened.close()),
    );

    yield* promised("Emulating the color scheme", () => page.emulateMedia({ colorScheme }));
    yield* promised("Clearing cookies", () => context.clearCookies());

    if (cookie !== undefined) {
      const [name = "", value = ""] = cookie.split("=");

      yield* promised("Setting the cookie", () =>
        context.addCookies([{ name, url: origin, value }]),
      );
    }

    yield* promised("Loading the page", () => page.goto(isPath ? `${origin}${target}` : target));

    if (isPath) {
      yield* promised("Waiting for hydration", () => page.waitForFunction(HYDRATED));
    }

    if (inject !== undefined) {
      yield* promised("Adding the fixture", () =>
        page.evaluate((html) => {
          document.body.insertAdjacentHTML("beforeend", html);
        }, inject),
      );
    }

    const input: AuditInput = { ...colors, radii, steps };
    const seen = new Map<string, Finding>();

    for (const width of WIDTHS) {
      yield* promised(`Resizing to ${width}px`, () =>
        page.setViewportSize({ height: HEIGHT, width }),
      );

      const findings = yield* promised(`Auditing at ${width}px`, () =>
        page.evaluate<ReadonlyArray<Finding>>(inPageScript(input)),
      );

      for (const finding of findings) {
        seen.set(`${finding.rule} ${finding.element} ${finding.value}`, finding);
      }
    }

    const dark = yield* promised("Reading the theme class", () =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    );

    return { dark, findings: [...seen.values()] } satisfies Audit;
  }).pipe(Effect.scoped);
});

/**
 * The `audit` browser command, at the Vitest boundary: Vitest calls a plain function and awaits
 * its Promise.
 *
 * @param context - The Playwright browser context of the test run.
 * @param target - A path on the harness, or a full URL.
 * @param cookie - A `name=value` cookie to send to the harness.
 * @param colorScheme - The `prefers-color-scheme` to emulate.
 * @param inject - HTML added at the end of the body before the audit, for a violation fixture.
 * @returns A promise of the audit.
 */
export const auditPage = (
  context: BrowserContext,
  target: string,
  cookie: string | undefined,
  colorScheme: "light" | "dark",
  inject: string | undefined,
) => runInHarness(audit(context, target, cookie, colorScheme, inject));
