import { defineConfig } from "vite-plus";

// The cloud suite: tier 3 and tier 4 against the fixed, serialized `test-ci` stage. It never sets
// `ALCHEMY_TEST_DEV`, and its global setup refuses to start without `ALCHEMY_TEST_STAGE=test-ci`.
export default defineConfig({
  test: {
    allowOnly: false,
    fileParallelism: false,
    globalSetup: ["test/cloud/global-setup.ts"],
    include: ["test/cloud/**/*.cloud.ts", "test/e2e/**/*.e2e.ts"],
    // Each test makes real requests to a deployed stage, such as a sign-in and a Durable Object write;
    // the notes test passed in 4.5 s once and timed out at Vitest's 5 s default on run 43553665249.
    testTimeout: 30_000,
  },
});
