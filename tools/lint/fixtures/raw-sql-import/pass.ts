import { and, eq, notExists } from "drizzle-orm";

export const passed = [and, eq, notExists];
