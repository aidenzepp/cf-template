# Docs site

## Decision

The docs site is deferred. Decided on 2026-11-10.

The first build ships documentation as committed markdown: `docs/`, `AGENTS.md` and `README.md`, with supdoc gating the links from those documents into the code. There is no docs website, no `apps/docs` package and no docs Worker.

The intended direction is a docs site on a standard framework, such as Astro or Nimbus, built the usual way, with its Markdown and MDX verified by supdoc inside that build: a supdoc check runs as part of the site's build and fails it on a stale link or code block, and the framework still renders the site. supdoc does not build the site; it plugs into the build the framework already has. Nimbus (`@cloudflare/nimbus-docs`) is one candidate framework, and its findings are the recipe and the costs below.

A later feature-request issue may bring a docs site back. It starts from the recipe and the costs below and proves everything under "What a future issue must prove".

## The proved Nimbus recipe

A Nimbus site was built once against this repository's shape: `@cloudflare/nimbus-docs` 0.19.4 scaffolded by `create-nimbus-docs` 0.8.3, on Astro 7.4.9, `@astrojs/react` 7.1.5 and Tailwind 4.3.5. What worked:

- **Hosting.** A static site on `Cloudflare.Website.Astro`, declared in `infra` beside the other Workers. A static site is a Worker serving the build output through Workers Static Assets, with no server adapter.
- **The API reference from the contract, with no copy.** Nimbus's `api[].spec` accepts an inline document. `OpenApi.fromApi(Api)` from `packages/contract`, passed inline, produced one reference page per operation (HTML and Markdown), `llms.txt` and a published `openapi.json`. No spec file is committed. Adding one endpoint to the contract and rebuilding produced one more page with no other edit: a contract edit shows after the next build.
- **`packages/ui` components as islands.** `@astrojs/react` 7.1.5 and one `react()` entry in Astro's `integrations` render `packages/ui` components as hydrated React islands. The site stylesheet needs one `@source` line pointing at `packages/ui/src`; without it, utilities used only in `packages/ui` are missing from the CSS.
- **One palette.** Both design systems define the same Tailwind theme names (`--color-background`, `--color-foreground`, `--color-card`, `--color-muted`, `--color-accent`, `--color-primary`, `--color-border`, `--color-ring`), and in one build the later `@theme` wins name by name, in both directions: Nimbus recolors the `packages/ui` components, and the `packages/ui` type scale resizes the Nimbus chrome. The fix is two edits in files the scaffolder copies into the repository for its owner to edit, and none in the CLI-owned `packages/ui` stylesheet:
  - a twelve-line bridge in the site's `globals.css` that points the Nimbus `--nb-*` roles at the `packages/ui` tokens in light and dark (`--nb-background: var(--background);` through `--nb-ring: var(--ring);`), while the Nimbus-only roles keep their own values;
  - one line in the layout's theme function, `root.classList.toggle("dark", mode === "dark")`, so the `.dark` class that `packages/ui` keys on follows the Nimbus `data-mode` attribute.

  The `packages/ui` type scale still restyles the Nimbus chrome; that was accepted as one design system.

- **The registry license.** The sortui license key is read only when a component is added through the shadcn CLI, never by `astro build`. Vendored components are committed source, so the site builds offline.

## The costs that deferred it

- **A second TypeScript.** `@cloudflare/nimbus-docs` 0.19.4 depends on `typescript` `^5.8.3` and calls the TypeScript 5 compiler API (`createSourceFile`, `createProgram`, `createCompilerHost`), which TypeScript 7 does not export. A second `typescript` would enter `bun.lock`, against the rule of one resolved version per singleton package.
- **House lint over a scaffold.** The repository's lint configuration reported about 1,300 findings on the scaffolded site, 49 of them PascalCase filenames (`BaseLayout.astro`, `Header.astro`). The site would need a second vendored lint and format exemption plus a filename-case exception.
- **A second toolchain.** The scaffold type-checks with `astro check` and its own TypeScript 5, beside the repository's `vp check`.
- **One more Worker per stage.** Every stage that deploys the site holds one more Worker script, which lowers the preview-stage capacity the deploy workflow computes.
- **Pre-1.0 pins.** Nimbus states that its public API can change between minor releases. `@astrojs/react` 7.1.6 failed to load on its release day (it imported a subpath its own pinned dependency does not export) while 7.1.5 worked, so exact pins and the release-age rule matter.

## What a future issue must prove

- **One TypeScript, or a named exception.** After `bun install`, `bun.lock` holds one `typescript`, or the maintainer has approved one named exception admitting a second version only as the docs package's own dependency, asserted by the singleton-version test.
- **The full gate over the site.** From a fresh clone, `bun run check`, `bun run build` and `bun run test` pass with the site present: lint, format and types over its files, knip over `.astro` and `.mdx`, the debt ratchet and supdoc.
- **An exemption scoped to what the scaffolder wrote.** Any lint and format exemption, and the filename-case exception with it, lists path by path the files the scaffolder wrote at the pinned version, never the site's whole source directory. First-party files (pages, islands, the token bridge) pass the house lint and format policy with no exemption.
- **Pull-out leaves nothing.** Removing the site with the blocks pull-out leaves no line that names it anywhere in the tree, shared configuration files included, and the gates pass on the pulled tree.
- **A portal-mounted island in light and dark.** One `packages/ui` component that mounts outside the island root (a Dialog or a Popover) hydrates, opens and reads the `packages/ui` token values in light and dark.
- **The color-token bridge, checked key by key.** The bridge is written in full against the pinned starter stylesheet, the two `@theme` key sets are diffed, and every shared key's value is asserted against the `packages/ui` value in light and dark.
- **Hand edits that survive a scaffold upgrade.** The two hand edits to scaffolded files, the bridge and the `.dark` line, sit inside marked blocks, so a scaffold upgrade can be re-applied and the edits kept.
- **Where the reference pages send requests.** Whether a reference page calls the API cross-origin (a request panel) is unknown. The issue shows that no request leaves the site's origin, or brings the choice back as a new decision.
- **The metered-usage line, measured.** Requests to static assets are free; any request that reaches the site's Worker script bills as a Workers request. Whether `Cloudflare.Website.Astro` puts a script in front of the assets is measured on a test stage and written into the block's `Meter:` line, never guessed.
