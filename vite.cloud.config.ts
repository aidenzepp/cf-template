import { defineConfig } from "vite-plus";

// The cloud suite: tier 3 and tier 4 against the fixed, serialized `test-ci` stage. It never sets
// `ALCHEMY_TEST_DEV`, and its global setup refuses to start without `ALCHEMY_TEST_STAGE=test-ci`.
export default defineConfig({
  test: {
    allowOnly: false,
    fileParallelism: false,
    globalSetup: ["test/cloud/global-setup.ts"],
    include: ["test/cloud/**/*.cloud.ts", "test/e2e/**/*.e2e.ts"],
  },
});
