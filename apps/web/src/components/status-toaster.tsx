import { useAtomValue } from "@effect/atom-react";
import { Toaster } from "@workspace/ui/components/ui/sonner";
import { useIsMobile } from "@workspace/ui/hooks/use-mobile";
import { resolvedThemeAtom } from "../lib/appearance.ts";

/**
 * The one `<Toaster>` of the app, with its position and colors set here because the vendored
 * `sonner.tsx` is never hand-edited. Sonner owns the live region and turns animation off under
 * `prefers-reduced-motion`. On a phone it sits at the top, because the bottom is where the open
 * sidebar sheet keeps the account row.
 *
 * @returns The toaster.
 */
export const StatusToaster = () => {
  const isMobile = useIsMobile();
  const theme = useAtomValue(resolvedThemeAtom);

  return <Toaster position={isMobile ? "top-center" : "bottom-right"} richColors theme={theme} />;
};
