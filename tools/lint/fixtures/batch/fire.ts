export const written = (handle: { batch: (steps: readonly string[]) => void }) =>
  handle.batch(["insert"]);
