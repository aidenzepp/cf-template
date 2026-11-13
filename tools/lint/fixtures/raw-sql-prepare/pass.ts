declare const db: { select: () => unknown };

export const passed = db.select();
