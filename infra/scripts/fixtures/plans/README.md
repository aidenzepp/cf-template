# Plan fixtures

Every file here is inferred, not recorded. Each is a `PlannedResource[]` written from the issue #44
text and the `PlannedResource` schema in Alchemy's `src/Events.ts` (fields `fqn`, `logicalId`,
`resourceType`, `action`, `bindings`; actions `create`, `update`, `adopted`, `replace`, `delete`,
`orphaned`, `noop`). The logical ids and the empty `bindings` arrays are stand-ins. The S-43 oracle
replaces them with plans recorded from a `test-<slug>` stage, renamed to `prod`.

- `all-noop.json`: every row `noop`.
- `d1-replace.json`: the app D1 database `replace`, one Worker `update`.
- `all-create.json`: every row `create`, a `prod` stage with no baseline.
- `kv-delete.json`: the knobs KV namespace `delete`, one Worker `update`.
- `unknown-action.json`: an action outside the schema, which fails decoding.
