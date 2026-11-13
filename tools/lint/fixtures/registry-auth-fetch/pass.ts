export const listed = (client: { passkey: { list: () => Promise<unknown> } }) =>
  client.passkey.list();
