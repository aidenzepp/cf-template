Meter: KV

# knobs-kv

The tier (c) adapter of the `LiveKnobs` port, over one Workers KV namespace per stage.

- `KnobsKvLive` provides `LiveKnobs`. Each Worker reads each key at most once per 30 s per isolate,
  with `cacheTtl: 30` on the read, and falls back to the deploy-time value when a key is absent,
  unreadable or fails its knob schema.
- `knobsNamespace(stack, stage)` declares the namespace, titled `<stack>-<stage>-knobs` by
  `knobsNamespaceTitle`. The `prod` namespace is retained when its resource is deleted, and a
  retained namespace is still billed.
- The Workers bind the namespace read-only. Writes belong to `tools/knob`, never to a Worker.

The package exports only `./live`.
