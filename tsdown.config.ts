import { defineConfig } from "tsdown";

import packageJson from "./package.json" with { type: "json" };

export default defineConfig({
  entry: {
    "v1/index": "src/v1.ts",
    "v2/index": "src/v2.ts",
  },
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
    codeSplitting: true,
  },
});
