/**
 * The seeded style violations: HTML the `audit` command adds to the end of the body of `/`, one
 * per rule. Each element resets the user agent styles with `all: unset` so it breaks only its own
 * rule, and so it breaks it once.
 */
export const VIOLATIONS = [
  {
    // `p-13`: Tailwind compiles it to this padding, 52 px, off the spacing steps.
    html: '<div style="all: unset; display: block; padding: calc(var(--spacing) * 13)"></div>',
    name: "a p-13 element",
    rule: "spacing",
  },
  {
    html: '<p style="all: unset; display: block; color: #123456">literal</p>',
    name: "a literal #123456 color",
    rule: "color",
  },
  {
    // A 300 px wide child, offset so it ends at 420 px: past a 390 px viewport, inside 1280 px.
    html: '<div style="all: unset; display: block; position: relative; left: 120px; width: 300px; height: 16px"></div>',
    name: "a 300 px wide child at 390 px",
    rule: "scroll",
  },
  {
    // The 16 px button sits against a 32 px button, so the spacing exception of 2.5.8 does not
    // apply; the 32 px button meets the minimum.
    html: '<div style="all: unset; display: block"><button style="all: unset; display: inline-block; width: 16px; height: 16px"></button><button style="all: unset; display: inline-block; width: 32px; height: 32px"></button></div>',
    name: "a 16 px button",
    rule: "target",
  },
] as const;
