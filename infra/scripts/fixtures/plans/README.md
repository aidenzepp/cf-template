# Plan fixtures

Every file here is derived from the alchemy 2.0.0-beta.85 source, not recorded from a run. Each is
the JSON form of the `resources` array that `Alchemist.plan` returns
(`node_modules/alchemy/src/Alchemist/Operations.ts:203` and `:230`), one row per resource as
`describeResource` builds it (`node_modules/alchemy/src/Plan.ts:292-305`):

- `fqn`, `logicalId`, `resourceType` and `action` (`create`, `update`, `adopted`, `replace`,
  `delete`, `orphaned` or `noop`, `src/Events.ts:67`).
- `bindings`: one `{ sid, action }` per binding (`src/Plan.ts:286-289`), action `create`, `update`,
  `delete` or `noop` (`src/Events.ts:55-58`).
- `providerMode`: the mode the provider resolved for, `"live"` on a deploy for a provider with live
  and local variants, `undefined` for a mode-agnostic one (`src/Plan.ts:498`, `:298`).
- `fromProviderMode`: the old generation's mode on a local-to-live (or live-to-local) `replace`,
  `undefined` on every other row, a first `create` included (`src/Plan.ts:299-304`).

`describeResource` writes `providerMode` and `fromProviderMode` as keys that are present but hold
`undefined`. JSON cannot carry `undefined`, so these files omit `fromProviderMode`, as
`JSON.stringify` of a real row does; `plan-prod.test.ts` decodes the in-memory form, with the key
present and `undefined`, separately. The logical ids, the resource types and the bindings are
stand-ins for this repository's stack.

- `all-noop.json`: every row `noop`.
- `d1-replace.json`: the app D1 database `replace`, one Worker `update`.
- `all-create.json`: every row `create`, a `prod` stage with no baseline.
- `first-create.json`: one Worker `create` with one binding, as a first deploy plans it.
- `kv-delete.json`: the knobs KV namespace `delete`, one Worker `update`.
- `unknown-action.json`: an action outside the known set, which fails decoding.

## Replacing them with a recording

`plan-prod.ts` does not print the raw rows. In CI it writes `renderSummary` (a table of `fqn`,
`resourceType`, `action` and class) to `$GITHUB_STEP_SUMMARY`, not to the log, so a prod run gives
no full-row recording. To record one, run the plan for a `test-<slug>` stage and write
`JSON.stringify(plan.resources, null, 2)` to a file, rename the stage-specific values to `prod`,
and replace the derived file of the same case. Keep every field the recording has.
