export const started = (handle: { transaction: (work: () => void) => void }) =>
  handle.transaction(() => undefined);
