import { Effect, Option } from "effect";
import { useEffect, useState } from "react";
import { readLastMethod } from "../../lib/last-method.ts";
import type { OpenStore, SignInMethod } from "../../lib/last-method.ts";
import type { fork as Fork } from "../../runtime.ts";

/**
 * The browser's `localStorage`, opened when the record is read or written.
 */
export const browserStore: OpenStore = () => window.localStorage;

/**
 * The method the last successful sign-in on this device used. The server render and the first
 * client render have no record, so the badge appears after hydration without a mismatch.
 *
 * @param fork - The web runtime's `fork`, injected so this module never loads the runtime.
 * @returns The method, or `undefined` when there is no record.
 */
export const useLastMethod = (fork: typeof Fork): SignInMethod | undefined => {
  const [method, setMethod] = useState<SignInMethod | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();

    fork(
      readLastMethod(browserStore).pipe(
        Effect.flatMap((last) =>
          Effect.sync(() => {
            setMethod(Option.getOrUndefined(last));
          }),
        ),
      ),
      { signal: controller.signal },
    );

    return () => {
      controller.abort();
    };
  }, [fork]);

  return method;
};
