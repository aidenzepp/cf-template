const cache = new Map<string, number>();

export const remember = (key: string, value: number) => {
  cache.set(key, value);
};
