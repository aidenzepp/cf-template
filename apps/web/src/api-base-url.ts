/**
 * The base URL of the `API` service binding. The binding ignores it and it is never resolved; it
 * only gives requests an absolute URL.
 */
export const SERVER_API_BASE_URL = "http://api.internal";

/**
 * The base URL of the browser's API calls: the origin of the page, so each request is same-origin
 * and goes through the `/api/*` forward of `web`. It reads `location` when called, in the browser.
 *
 * @returns The origin of the current page.
 */
export const browserApiBaseUrl = (): string => location.origin;
