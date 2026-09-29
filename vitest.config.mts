import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@waves/motion": path.join(root, "packages/motion/src/index.ts")
    }
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: [
      "packages/motion/test/**/*.test.ts",
      "packages/motion/test/**/*.test.tsx",
      "apps/motion-lab/src/lib/**/*.test.ts",
      "packages/motion-lab-mcp/src/**/*.test.ts"
    ],
    reporters: ["default"],
    restoreMocks: true,
    clearMocks: true
  }
});
