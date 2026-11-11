export const started = (handle: { withTransaction: (work: () => void) => void }) =>
  handle.withTransaction(() => undefined);
