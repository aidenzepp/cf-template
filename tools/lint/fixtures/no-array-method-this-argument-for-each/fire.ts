export const visit = (xs: ReadonlyArray<number>, seen: Array<number>) =>
  xs.forEach(function remember(this: Array<number>, x) {
    this.push(x);
  }, seen);
