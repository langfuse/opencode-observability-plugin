import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  test("loads every built entrypoint without external runtime packages", () => {
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        import { isBuiltin, registerHooks } from "node:module";
        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (!isBuiltin(specifier) && !specifier.startsWith(".") && !specifier.startsWith("file:")) {
              throw new Error("Unexpected external dependency: " + specifier);
            }
            return nextResolve(specifier, context);
          },
        });
        for (const entry of process.argv.slice(1)) await import(entry);
      `,
      ...["index.js", "v1/index.js", "v2/index.js"].map(
        (entry) => new URL(`../../dist/${entry}`, import.meta.url).href,
      ),
    ]);
  });

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

  test("loads config file tags and lets plugin options override them", async () => {
    const clientInputs: { tags?: string[] }[] = [];
    const client = { id: "tags-client" };

    vi.doMock("../../src/langfuse.js", () => ({
      createLangfuseClient: (input: { tags?: string[] }) => {
        clientInputs.push(input);
        return Effect.succeed(client);
      },
    }));

    temporaryHome = await mkdtemp(join(process.cwd(), ".test-runtime-"));
    process.env.HOME = temporaryHome;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    const configDirectory = join(temporaryHome, ".config", "opencode");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "opencode-langfuse.json"),
      JSON.stringify({
        publicKey: "pk-config",
        secretKey: "sk-config",
        tags: ["from-config"],
      }),
    );

    const { createLangfuseRuntime } = await import("../../src/runtime.js");

    await Effect.runPromise(createLangfuseRuntime({}));
    globalThis.langfuseOpencodeRuntimeState = undefined;
    await Effect.runPromise(createLangfuseRuntime({ tags: ["from-options"] }));

    expect(clientInputs.map((input) => input.tags)).toEqual([
      ["from-config"],
      ["from-options"],
    ]);
  });

  test("decodes the tags plugin option", async () => {
    const { decodePluginTags } = await import("../../src/runtime.js");

    expect(decodePluginTags({ tags: ["a", "b"] })).toEqual(["a", "b"]);
    expect(decodePluginTags({})).toBeUndefined();
    expect(decodePluginTags(undefined)).toBeUndefined();
    expect(decodePluginTags({ tags: "not-an-array" })).toBeUndefined();
    expect(decodePluginTags({ tags: ["", "valid"] })).toBeUndefined();
    expect(decodePluginTags({ tags: [] })).toEqual([]);
    expect(decodePluginTags({ tags: ["a"], unknownKey: 1 })).toEqual(["a"]);
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
