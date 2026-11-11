const seen: number[] = [];

seen.push(1);

export const total = (values: readonly number[]) => {
  const cache = new Map<string, number>();

  cache.set("sum", values.length);

  return cache;
};

export const shadowed = (seen: number[]) => {
  seen.push(2);

  return seen;
};
