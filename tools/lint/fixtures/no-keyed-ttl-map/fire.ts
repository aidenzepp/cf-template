export const makeCache = () => {
  const entries = new Map<string, number>();

  return (key: string) => {
    const hit = entries.get(key);

    if (hit === undefined || Date.now() - hit > 1000) {
      entries.set(key, Date.now());
    }
  };
};
