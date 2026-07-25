import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@scribe-drop/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url),
      ),
      "@scribe-drop/domain": fileURLToPath(
        new URL("./packages/domain/src/index.ts", import.meta.url),
      ),
      "@scribe-drop/observability": fileURLToPath(
        new URL("./packages/observability/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    coverage: {
      enabled: false,
    },
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    passWithNoTests: false,
    reporters: ["default"],
  },
});
