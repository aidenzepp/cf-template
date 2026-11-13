import { Toaster } from "@workspace/ui/components/ui/sonner";

/**
 * The one `<Toaster>` of the app, with its position set here because the vendored
 * `sonner.tsx` is never hand-edited. Sonner owns the live region and turns animation off under
 * `prefers-reduced-motion`.
 *
 * @param props - The toaster's props.
 * @param props.theme - The resolved color theme of the page.
 * @returns The toaster.
 */
export const StatusToaster = ({ theme }: { readonly theme: "light" | "dark" }) => (
  <Toaster position="bottom-right" theme={theme} />
);
