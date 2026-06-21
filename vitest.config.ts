import { createVitestConfig } from "@rxtx4816/cockpit-plugin-base-react/vitest.config.base";

export default createVitestConfig({
  setupFiles: ["./src/test/setup.ts"],
  coverage: {
    exclude: [
      "src/test/**",
      "src/**/*.test.{ts,tsx}",
      "src/index.tsx",
      "src/api/types.ts",
      "src/api/index.ts",
    ],
  },
});
