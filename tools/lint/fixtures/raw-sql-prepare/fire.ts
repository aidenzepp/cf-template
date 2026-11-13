declare const env: { DB: { prepare: (query: string) => unknown } };

export const fired = env.DB.prepare("delete from user");
