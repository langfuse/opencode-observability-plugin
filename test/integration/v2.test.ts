import { readFile } from "node:fs/promises";

import LangfusePlugin from "@langfuse/opencode-observability-plugin/v2";
import { Schema } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";

import SourcePlugin from "../../src/v2.js";

const runtime = vi.hoisted(() => ({
  traceUserPrompt: vi.fn(),
  setPendingToolDefinitions: vi.fn(),
  rememberToolCall: vi.fn(),
  traceToolStart: vi.fn(),
  traceToolError: vi.fn(),
  traceToolEnd: vi.fn(),
  rememberSessionParent: vi.fn(),
  startActiveGenerationStep: vi.fn(),
  traceGeneration: vi.fn(),
  traceFailedGenerationStep: vi.fn(),
  traceEvent: vi.fn(),
  endActiveToolObservations: vi.fn(),
  endActiveGenerationSteps: vi.fn(),
  endActiveTurnObservations: vi.fn(),
  clearSessionTraceState: vi.fn(),
  clearTraceState: vi.fn(),
  shutdown: vi.fn(),
}));

vi.mock("../../src/runtime.js", async () => {
  const { Effect } = await import("effect");

  return {
    createLangfuseRuntime: Effect.succeed({
      ...runtime,
      forceFlush: Effect.void,
    }),
    createShutdownOnce: () => runtime.shutdown,
  };
});

describe("OpenCode 2 package entrypoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("resolves as a plugin object", () => {
    expect(LangfusePlugin.id).toBe("langfuse.observability");
    expect(typeof LangfusePlugin.setup).toBe("function");
  });

  test("does not import the OpenCode 2 SDK at runtime", async () => {
    const output = await readFile(
      new URL("../../dist/v2/index.js", import.meta.url),
      "utf8",
    );

    expect(output).not.toContain('from "@opencode/plugin"');
    expect(output).not.toContain("from '@opencode/plugin'");
  });

  test("finalizes and flushes failed executions", async () => {
    const registration = { dispose: vi.fn(() => Promise.resolve()) };
    const contextInput: unknown = {
      session: { hook: vi.fn(() => Promise.resolve(registration)) },
      tool: { hook: vi.fn(() => Promise.resolve(registration)) },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield {
              type: "session.execution.failed",
              data: {
                sessionID: "session-1",
                error: { type: "TestError", message: "failed" },
              },
            };
          },
        }),
      },
    };
    const context = Schema.decodeUnknownSync(
      Schema.declare(
        (input): input is Parameters<typeof SourcePlugin.setup>[0] =>
          typeof input === "object" && input !== null,
      ),
    )(contextInput);

    const cleanup = await SourcePlugin.setup(context);
    expect(cleanup).toBeTypeOf("function");
    await cleanup?.();

    expect(runtime.endActiveToolObservations).toHaveBeenCalledWith("session-1");
    expect(runtime.endActiveGenerationSteps).toHaveBeenCalledWith("session-1");
    expect(runtime.endActiveTurnObservations).toHaveBeenCalledWith("session-1");
  });

  test("traces a complete session with prompt, text, reasoning, and tools", async () => {
    let prompt:
      | ((input: {
          sessionID: string;
          messageID: string;
          prompt: { text: string };
        }) => void)
      | undefined;
    let executeBefore:
      | ((input: {
          id: string;
          messageID: string;
          sessionID: string;
          tool: string;
          input: unknown;
        }) => void)
      | undefined;
    let releaseStep: (() => void) | undefined;
    const toolCalled = new Promise<void>((resolve) => {
      releaseStep = resolve;
    });
    const registration = { dispose: vi.fn(() => Promise.resolve()) };
    const contextInput: unknown = {
      session: {
        hook: vi.fn((name: string, handler: typeof prompt) => {
          if (name === "prompt") {
            prompt = handler;
          }
          return Promise.resolve(registration);
        }),
      },
      tool: {
        hook: vi.fn((name: string, handler: typeof executeBefore) => {
          if (name === "execute.before") {
            executeBefore = handler;
          }
          return Promise.resolve(registration);
        }),
      },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "session.step.started",
              created: 100,
              data: {
                sessionID: "session-1",
                assistantMessageID: "assistant-1",
                agent: "build",
                model: { id: "model-1", providerID: "provider-1" },
                snapshot: "snapshot-1",
              },
            };
            yield {
              type: "session.text.ended",
              created: 150,
              data: {
                sessionID: "session-1",
                assistantMessageID: "assistant-1",
                text: "Hello",
              },
            };
            yield {
              type: "session.reasoning.ended",
              created: 160,
              data: {
                sessionID: "session-1",
                assistantMessageID: "assistant-1",
                text: "Thinking",
              },
            };
            await toolCalled;
            yield {
              type: "session.step.ended",
              created: 200,
              data: {
                sessionID: "session-1",
                assistantMessageID: "assistant-1",
                finish: "tool-calls",
                cost: 0.01,
                tokens: {
                  input: 10,
                  output: 5,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
              },
            };
          },
        }),
      },
    };
    const context = Schema.decodeUnknownSync(
      Schema.declare(
        (input): input is Parameters<typeof SourcePlugin.setup>[0] =>
          typeof input === "object" && input !== null,
      ),
    )(contextInput);

    const cleanup = await SourcePlugin.setup(context);
    await vi.waitFor(() => expect(prompt).toBeTypeOf("function"));
    prompt?.({
      sessionID: "session-1",
      messageID: "user-1",
      prompt: { text: "Say hello" },
    });
    await vi.waitFor(() => expect(executeBefore).toBeTypeOf("function"));
    await vi.waitFor(() =>
      expect(runtime.startActiveGenerationStep).toHaveBeenCalled(),
    );
    executeBefore?.({
      id: "call-1",
      messageID: "assistant-1",
      sessionID: "session-1",
      tool: "read",
      input: { path: "README.md" },
    });
    releaseStep?.();

    await vi.waitFor(() =>
      expect(runtime.traceUserPrompt).toHaveBeenCalledWith({
        sessionID: "session-1",
        messageID: "user-1",
        content: [{ type: "text", text: "Say hello" }],
      }),
    );
    await vi.waitFor(() =>
      expect(runtime.traceGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          parentID: "user-1",
          output: [
            expect.objectContaining({
              content: "Hello",
              thinking: [{ type: "thinking", content: "Thinking" }],
              tool_calls: [
                {
                  id: "call-1",
                  name: "read",
                  arguments: JSON.stringify({ path: "README.md" }),
                },
              ],
            }),
          ],
        }),
      ),
    );
    await cleanup?.();
  });
});
