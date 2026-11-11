import { a } from "./a";
export const afterImport = a;
export function afterConst() {
  const single = 1;
  const multi = {
    key: single,
  };
  const afterMulti = multi;
  let multiLet = {
    key: afterMulti,
  };
  multiLet = afterMulti;
  var multiVar = {
    key: multiLet,
  };
  multiVar = multiLet;
  afterMulti.key;
  if (single) {
    afterMulti.key;
  }
  afterMulti.key;
  switch (single) {
    default:
      break;
  }
  try {
    afterMulti.key;
  } finally {
    afterMulti.key;
  }
  for (const n of [1]) {
    n;
  }
  while (single) {
    break;
  }
  do {
    afterMulti.key;
  } while (single);
  {
    afterMulti.key;
  }
  afterMulti.key;
  if (single) {
    return multiVar;
  }
  return single;
}
export type AfterFunction = string;
export interface AfterType {
  readonly key: string;
}
export class AfterInterface {}
export const afterClass = 1;
let top = 1;
top = 2;
function declared() {
  return top;
}
declared();
