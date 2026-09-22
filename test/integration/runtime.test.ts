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
  vi.doUnmock("@opentelemetry/api");
  vi.doUnmock("../../src/langfuse.js");
  vi.resetModules();
  vi.unstubAllGlobals();
  globalThis.langfuseOpencodeRuntimeState = undefined;
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
  test("creates one shared client for concurrent initialization", async () => {
    const client = { id: "shared-client" };
    let clientCreations = 0;

    vi.doMock("../../src/langfuse.js", () => ({
      createLangfuseClient: () =>
        Effect.gen(function* () {
          clientCreations += 1;
          yield* Effect.sleep("10 millis");
          return client;
        }),
    }));

    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    const { createLangfuseRuntime } = await import("../../src/runtime.js");

    const clients = await Effect.runPromise(
      Effect.all([createLangfuseRuntime({}), createLangfuseRuntime({})], {
        concurrency: "unbounded",
      }),
    );

    expect(clientCreations).toBe(1);
    expect(clients[0]).toBe(client);
    expect(clients[1]).toBe(client);

    vi.resetModules();
    const reloadedRuntime = await import("../../src/runtime.js");
    expect(
      await Effect.runPromise(reloadedRuntime.createLangfuseRuntime({})),
    ).toBe(client);
    expect(clientCreations).toBe(1);

    process.env.LANGFUSE_SECRET_KEY = "sk-changed";
    const error = await Effect.runPromise(
      Effect.flip(createLangfuseRuntime({})),
    );

    expect(error).toMatchObject({
      _tag: "ChangedLangfuseConfiguration",
    });
  });

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
