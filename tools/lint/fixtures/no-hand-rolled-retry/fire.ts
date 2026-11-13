declare const call: () => Promise<boolean>;

export const retry = async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await call()) {
      return true;
    }
  }

  return false;
};
