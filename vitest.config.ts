import { createVitestConfig } from "@rxtx4816/cockpit-plugin-base-react/vitest.config.base";
import { ensureNotices } from "./scripts/ensure-notices.mjs";

// AppFooter imports the generated notices JSON, which only a full build produces.
// Seed it here rather than only from a pretest hook, so a bare `npx vitest` or an
// IDE-launched run resolves the import too.
await ensureNotices();

export default createVitestConfig({
  setupFiles: ["./src/test/setup.ts"],
});
