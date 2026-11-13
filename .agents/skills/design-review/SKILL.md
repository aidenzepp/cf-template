---
name: design-review
description: Look at the rendered pages a change touches in light and dark, judge them against the rubric, and record one verdict line for the pull request body. Use before opening a pull request that touches `apps/web` or `packages/ui`.
---

# Design Review

The skill records the look of a change. It advises and does not gate. It makes no model call from CI: the session that ran it judges the images.

## Scope

Deterministic checks (token colors, spacing, overflow, target size, contrast) belong to the browser tier, `bun run test:browser`. Do not judge them here. The rubric holds only what a look can judge.

## Procedure

1. List the pages the change touches under `apps/web` or `packages/ui`.
2. Build and start the app locally through the browser tier. `bun run test:browser` builds `web` and starts the harness; its `scan` command (`test/browser/support/browser-harness.ts`) opens each page in light and dark. Write no new capture script.
3. On Linux, `scan` returns full-page PNG screenshots at 390 and 1280 px for each scheme. Other platforms return none: run the capture on Linux, or record the verdict as `concerns` with that reason.
4. Read [rubric.md](rubric.md). Judge every captured image against each sentence.
5. Write the verdict: `pass` when every sentence holds on every image, `concerns` when one fails on a minor point or an image is missing, `fail` when a sentence clearly fails.

## Record

One line, exactly:

```text
design-review: <40-hex head sha> <pass|concerns|fail> <reason>
```

The sha is `git rev-parse HEAD` of the branch as pushed, and the reason is one short sentence. The line goes in the pull request body. A new commit makes the line stale; run the skill again. For a Hand's pull request the Hand runs the skill and reports the line, and the Mind pastes it into the body.

## Where later rubric items come from

The rubric starts with five sentences and gains none until the style decision in #270 sets the guidance part of `DESIGN.md` (`tools/design-md/guidance.md`). Each guidance rule then enters with its category named:

1. A rule a screenshot can judge becomes a rubric sentence, written as a checkable sentence.
2. A rule code can check becomes a lint rule (#268 for an import ban, a new lint issue otherwise), not rubric prose.
3. A rule that fits neither stays guidance only. The skill may cite it and does not score it.

Do not add rubric content from any other source.
