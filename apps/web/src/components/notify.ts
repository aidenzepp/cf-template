import { toast } from "sonner";

/**
 * Raises one outcome as a toast.
 *
 * @param show - The Sonner call that renders the outcome.
 * @returns The function that raises it.
 */
const raise =
  (show: typeof toast.success) =>
  (title: string, description?: string): void => {
    show(title, description === undefined ? undefined : { description });
  };

/**
 * The only way a screen raises a status toast, so no route imports `sonner` (lint enforces it).
 * Each outcome takes a short title that says what happened and an optional description that says
 * what to do next. The one `<Toaster>` in `routes/__root.tsx` renders them, and Sonner announces
 * each to screen readers through its live region.
 */
export const notify = {
  /**
   * What failed and what to do.
   */
  error: raise(toast.error),
  /**
   * A neutral fact the person may want to know.
   */
  info: raise(toast.info),
  /**
   * An action finished.
   */
  success: raise(toast.success),
} as const;
