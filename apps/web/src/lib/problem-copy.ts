/**
 * What the `/problems/<slug>` page says for each `type` the contract declares on its problems:
 * `NoteNotFound`, `NoteQuotaExceeded`, `NotesUnavailable`, `SessionRequired` and `AuthUnavailable`.
 * The text is authored here; nothing a problem body carries is rendered.
 */
export const PROBLEM_COPY: ReadonlyMap<string, string> = new Map([
  ["/problems/auth-unavailable", "Sign-in is unavailable right now. Try again in a moment."],
  ["/problems/note-not-found", "That note does not exist, or it is not yours."],
  ["/problems/note-quota-exceeded", "You have reached the limit of notes. Delete one to add more."],
  ["/problems/notes-unavailable", "Notes are not available."],
  ["/problems/session-required", "Sign in to continue."],
]);

/**
 * The text of a problem page whose slug has no entry in {@link PROBLEM_COPY}.
 */
export const PROBLEM_FALLBACK_TITLE = "Something went wrong";

/**
 * The text of a problem page.
 *
 * @param slug - The `$slug` of `/problems/$slug`.
 * @returns The copy for `type: "/problems/<slug>"`, or {@link PROBLEM_FALLBACK_TITLE} when none is
 *   declared.
 */
export const problemCopy = (slug: string): string =>
  PROBLEM_COPY.get(`/problems/${slug}`) ?? PROBLEM_FALLBACK_TITLE;
