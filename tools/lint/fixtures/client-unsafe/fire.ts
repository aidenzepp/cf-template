export const queried = (client: { unsafe: (text: string) => void }) => client.unsafe("select 1");
