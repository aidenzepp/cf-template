export const queried = (client: { query: (text: string) => void }) => client.query("select 1");
