import { createVitestConfig } from "@rxtx4816/cockpit-plugin-base-react/vitest.config.base";

export default createVitestConfig({
  setupFiles: ["./src/test/setup.ts"],
});
