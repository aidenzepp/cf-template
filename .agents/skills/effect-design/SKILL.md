---
name: effect-design
description: Apply this repository's native-capability review and local Effect rulings. Use when writing or reviewing Effect code, streams, channels, Schema codecs, services, or a custom adapter. Effect structure and style come from the installed Effect guide, not from this skill.
---

# Effect design

Before writing or reviewing Effect code:

1. Read `node_modules/effect/AGENTS.md` and the `ai-docs` example it links for the API you are changing. When that example has a `fixtures` directory, follow those files for directory roles and code shape. Name directories and files in kebab-case. For an API the guide does not cover, read the matching source in `node_modules/effect/src` at the pinned version. When this skill and that guide disagree about Effect style, follow the installed guide.
2. Run the native-capability review.
3. Apply the local rulings. Effect's guide does not make them.

## Native capability review

Apply this review before implementing an effectful operation, including a one-line `Effect.sync`, `Effect.try`, `Effect.promise`, or `Effect.tryPromise`. Those constructors integrate an API. They do not show that Effect lacks the operation.

1. State the contract: accepted input, output, failures, limits, lifecycle, and guarantees.
2. Inspect the owning code and the versions pinned in `package.json`.
3. Check the installed Effect module and its neighbors, such as `effect/Schema`, `Stream`, `Channel`, `Config`, and the platform packages. One missed symbol is not a gap.
4. Use the Effect API that meets the contract. Preserve streaming limits, cancellation, the error channel, and resource lifetime.
5. When custom glue remains, name the API you checked and the requirement it does not meet. "I did not find an API" without that evidence is not a gap. Put the same rationale in the implementation handoff.

For a pull stream, consume each element's nested content before advancing. Collecting handles and reading them later drops that content.

## Local rulings

- Directories and files use kebab-case. `unicorn/filename-case` enforces filenames and `workspace/kebab-case-paths` enforces directories. Effect fixtures use PascalCase file names such as `Api.ts` and `Users.ts`; this repository uses `api.ts` and `users.ts`.
- Inside a generator, keep `if`, `??`, or a ternary for a value check when a combinator would add no typed failure, resource, span, or dependency. Effect's guide still decides how to attach those four.
- Caller-facing errors follow `.agents/skills/error-messages/SKILL.md`. Name the specific failure and the repair. Keep upstream causes available for diagnosis without making them the public contract.
