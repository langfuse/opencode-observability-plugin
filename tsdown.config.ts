import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
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
