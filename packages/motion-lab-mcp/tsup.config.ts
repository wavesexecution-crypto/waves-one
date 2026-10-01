import { defineConfig } from "tsup";

/**
 * Motion Lab MCP server build — Node ESM stdio server.
 * The engine stays external and resolves at runtime through the
 * workspace link, so catalogue data is never duplicated here.
 */
export default defineConfig([
  {
    entry: { server: "src/server.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    target: "node18",
    platform: "node",
    external: ["@waves/motion"],
    banner: { js: "#!/usr/bin/env node" },
    outExtension() {
      return { js: ".mjs" };
    }
  },
  {
    entry: { backend: "src/backend.ts", "brand-film-publish": "src/brand-film-publish.ts", "seai-reel-publish": "src/seai-reel-publish.ts", "motion-lab-demo-publish": "src/motion-lab-demo-publish.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    target: "node18",
    platform: "node",
    external: ["@waves/motion", /^node:/],
    outExtension() {
      return { js: ".mjs" };
    }
  }
]);
