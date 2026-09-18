import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalEnvironment = {
  home: process.env.HOME,
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
};

let temporaryHome: string | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalEnvironment.home === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalEnvironment.home;
  }
  if (originalEnvironment.publicKey === undefined) {
    delete process.env.LANGFUSE_PUBLIC_KEY;
  } else {
    process.env.LANGFUSE_PUBLIC_KEY = originalEnvironment.publicKey;
  }
  if (originalEnvironment.secretKey === undefined) {
    delete process.env.LANGFUSE_SECRET_KEY;
  } else {
    process.env.LANGFUSE_SECRET_KEY = originalEnvironment.secretKey;
  }

  if (temporaryHome !== undefined) {
    await rm(temporaryHome, { recursive: true, force: true });
    temporaryHome = undefined;
  }
});

describe("Langfuse runtime", () => {
  test("does not accept empty environment credentials", async () => {
    vi.stubGlobal("__PLUGIN_VERSION__", "test");
    const { createLangfuseRuntime } = await import("../../src/runtime.js");
    temporaryHome = await mkdtemp(join(process.cwd(), ".test-runtime-"));
    process.env.HOME = temporaryHome;
    process.env.LANGFUSE_PUBLIC_KEY = "";
    process.env.LANGFUSE_SECRET_KEY = "";

    const error = await Effect.runPromise(
      Effect.flip(createLangfuseRuntime({})),
    );

    expect(error).toMatchObject({
      _tag: "MissingLangfuseCredentials",
      message: "Missing Langfuse credentials",
    });
  });
});
