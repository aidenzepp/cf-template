export const listed = (client: { $fetch: (path: string) => Promise<unknown> }) =>
  client.$fetch("/passkey/list-user-passkeys");
