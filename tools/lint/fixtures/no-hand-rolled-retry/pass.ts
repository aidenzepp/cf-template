declare const call: (index: number) => Promise<boolean>;

export const all = async (items: ReadonlyArray<number>) => {
  for (let index = 0; index < items.length; index += 1) {
    await call(index);
  }
};
