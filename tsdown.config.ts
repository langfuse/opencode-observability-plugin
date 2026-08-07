import { defineConfig } from "tsdown";

import packageJson from "./package.json" with { type: "json" };

export default defineConfig({
  entry: ["src/index.ts"],
  define: {
    __PLUGIN_VERSION__: JSON.stringify(packageJson.version),
  },
  format: ["esm"],
  platform: "node",
  dts: false,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  deps: {
    neverBundle: ["@opentelemetry/api"],
    onlyBundle: false,
  },
  outputOptions: {
    codeSplitting: false,
  },
});
