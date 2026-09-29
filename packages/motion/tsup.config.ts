import { defineConfig } from "tsup";

/**
 * Waves Motion Engine build — v1.
 *
 * v1 ships a single library entry (`src/index.ts`), which is the actual
 * implemented surface (engine + animation + springs + easing + properties +
 * stagger + types). The `react` / `next` / `schema` / `testing` / `inspector`
 * entries and the `src/cli` bundle were stale configuration carried into this
 * workspace snapshot: none of those source files exist, nothing in `src/` or
 * `test/` imports them, and the 34-test v1 contract covers only the core
 * engine. They are intentionally not built here — do not re-add them as
 * empty placeholders.
 */
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    target: "es2022",
    platform: "neutral",
    external: ["react", "react-dom", "react/jsx-runtime"],
    outExtension({ format }) {
      return { js: format === "esm" ? ".mjs" : ".cjs" };
    }
  }
]);
