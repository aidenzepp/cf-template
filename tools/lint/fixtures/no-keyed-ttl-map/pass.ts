export const index = (keys: ReadonlyArray<string>) => new Map(keys.map((key) => [key, key]));

export const stamp = () => Date.now();
