export const queried = (db: { get: (text: string) => void }) => db.get("select 1");
