export const forwarded = (env: { AUTH: { fetch: (request: Request) => Promise<Response> } }) =>
  env.AUTH.fetch(new Request("https://auth/session"));

export const called = (client: { $fetch: (path: string) => Promise<unknown> }) =>
  client.$fetch("/session");
