import { afterAll, beforeAll } from "vitest";
import { Miniflare } from "miniflare";
import fixture from "./fixture.sql?raw";

const started = Promise.withResolvers<Miniflare>();

/**
 * The local D1 binding of the running test file. The instance starts in this setup file's
 * `beforeAll` and is disposed in its `afterAll`, so call this only inside a test.
 */
export const rawDatabase = async () => {
  const miniflare = await started.promise;

  return await miniflare.getD1Database("DB");
};

beforeAll(async () => {
  const miniflare = new Miniflare({ d1Databases: ["DB"], modules: true, script: "" });

  const database = await miniflare.getD1Database("DB");

  await database.exec(fixture.trim());
  started.resolve(miniflare);
});

afterAll(async () => {
  const miniflare = await started.promise;

  await miniflare.dispose();
});
