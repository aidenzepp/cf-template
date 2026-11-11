/**
 * The placeholder `api` Worker: a fixed `200` text response until its block replaces it.
 */
export default {
  fetch: (): Response => new Response("api"),
};
