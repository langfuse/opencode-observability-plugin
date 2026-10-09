import { readFile } from "node:fs/promises";

import CombinedPlugin from "@langfuse/opencode-observability-plugin";
import LangfusePlugin from "@langfuse/opencode-observability-plugin/v2";
import { Schema } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";

import SourcePlugin from "../../src/v2.js";

const runtime = vi.hoisted(() => ({
  createLangfuseRuntime: vi.fn(),
  traceUserPrompt: vi.fn(),
  setGenerationInputSnapshot: vi.fn(),
  rememberToolCall: vi.fn(),
  traceToolStart: vi.fn(),
  traceToolError: vi.fn(),
  traceToolEnd: vi.fn(),
  rememberSessionParent: vi.fn(),
  startActiveGenerationStep: vi.fn(),
  traceGeneration: vi.fn(),
  traceFailedGenerationStep: vi.fn(),
  traceSessionError: vi.fn(),
  traceEvent: vi.fn(),
  endActiveToolObservations: vi.fn(),
  endActiveGenerationSteps: vi.fn(),
  endActiveTurnObservations: vi.fn(),
  clearSessionTraceState: vi.fn(),
  clearTraceState: vi.fn(),
  forceFlush: vi.fn(),
}));

vi.mock("../../src/runtime.js", async () => {
  const { Effect } = await import("effect");

  return {
    createLangfuseRuntime: (input: { opencodeVersion?: string }) => {
      runtime.createLangfuseRuntime(input);
      return Effect.succeed({
        ...runtime,
        forceFlush: Effect.sync(runtime.forceFlush),
      });
    },
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

  test("exposes both OpenCode plugin APIs from the default entrypoint", () => {
    expect(CombinedPlugin.id).toBe("langfuse.observability");
    expect(typeof CombinedPlugin.setup).toBe("function");
    expect(typeof CombinedPlugin.server).toBe("function");
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
      app: { version: "2.0.4" },
      session: { hook: vi.fn(() => Promise.resolve(registration)) },
      tool: { hook: vi.fn(() => Promise.resolve(registration)) },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
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
              type: "session.execution.failed",
              data: {
                sessionID: "session-1",
                error: { type: "TestError", message: "failed" },
              },
            };
            yield {
              type: "session.step.ended",
              created: 200,
              data: {
                sessionID: "session-1",
                assistantMessageID: "assistant-1",
                finish: "stop",
                cost: 0,
                tokens: {
                  input: 0,
                  output: 0,
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
    expect(cleanup).toBeTypeOf("function");
    await cleanup?.();

    expect(runtime.createLangfuseRuntime).toHaveBeenCalledWith({
      opencodeVersion: "2.0.4",
    });
    expect(runtime.traceSessionError).toHaveBeenCalledWith({
      sessionID: "session-1",
      error: { name: "TestError", message: "failed" },
    });
    expect(runtime.traceGeneration).not.toHaveBeenCalled();
  });

  test("keeps the shared runtime alive when an instance is disposed and re-created", async () => {
    const registration = { dispose: vi.fn(() => Promise.resolve()) };
    const contextInput: unknown = {
      app: { version: "2.0.4" },
      session: { hook: vi.fn(() => Promise.resolve(registration)) },
      tool: { hook: vi.fn(() => Promise.resolve(registration)) },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield* [];
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

    const firstCleanup = await SourcePlugin.setup(context);
    await firstCleanup?.();
    const secondCleanup = await SourcePlugin.setup(context);
    await secondCleanup?.();

    expect(runtime.createLangfuseRuntime).toHaveBeenCalledTimes(2);
    expect(runtime.forceFlush).toHaveBeenCalledTimes(2);
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
      app: { version: "2.0.4" },
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
    await vi.waitFor(() => {
      expect(prompt).toBeTypeOf("function");
    });
    prompt?.({
      sessionID: "session-1",
      messageID: "user-1",
      prompt: { text: "Say hello" },
    });
    await vi.waitFor(() => {
      expect(executeBefore).toBeTypeOf("function");
    });
    await vi.waitFor(() => {
      expect(runtime.startActiveGenerationStep).toHaveBeenCalled();
    });
    executeBefore?.({
      id: "call-1",
      messageID: "assistant-1",
      sessionID: "session-1",
      tool: "read",
      input: { path: "README.md" },
    });
    releaseStep?.();

    await vi.waitFor(() => {
      expect(runtime.traceUserPrompt).toHaveBeenCalledWith({
        sessionID: "session-1",
        messageID: "user-1",
        content: [{ type: "text", text: "Say hello" }],
      });
    });
    await vi.waitFor(() => {
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
      );
    });
    await cleanup?.();
  });

  test.each([
    {
      tool: "skill",
      input: { id: "build-project" },
    },
    {
      tool: "task",
      input: { subagent_type: "developer", prompt: "Fix the build" },
    },
    {
      tool: "subagent",
      input: { agent: "ts-reviewer", prompt: "Review the build" },
    },
  ])(
    "forwards semantic $tool input for observation naming",
    async (toolCall) => {
      let executeBefore: ((input: unknown) => void) | undefined;
      let executeAfter: ((input: unknown) => void) | undefined;
      const registration = { dispose: vi.fn(() => Promise.resolve()) };
      const contextInput: unknown = {
        app: { version: "2.0.4" },
        session: { hook: vi.fn(() => Promise.resolve(registration)) },
        tool: {
          hook: vi.fn((name: string, handler: (input: unknown) => void) => {
            if (name === "execute.before") {
              executeBefore = handler;
            }
            if (name === "execute.after") {
              executeAfter = handler;
            }
            return Promise.resolve(registration);
          }),
        },
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              await Promise.resolve();
              yield* [];
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
      expect(executeBefore).toBeTypeOf("function");
      expect(executeAfter).toBeTypeOf("function");

      const input = {
        id: `${toolCall.tool}-call`,
        messageID: "assistant-1",
        sessionID: "session-1",
        tool: toolCall.tool,
        input: toolCall.input,
      };
      executeBefore?.(input);
      executeAfter?.({
        ...input,
        status: "success",
        result: { content: "ok" },
      });

      expect(runtime.traceToolStart).toHaveBeenCalledWith({
        sessionID: "session-1",
        messageID: "assistant-1",
        callID: `${toolCall.tool}-call`,
        tool: toolCall.tool,
        args: toolCall.input,
      });
      expect(runtime.traceToolEnd).toHaveBeenCalledWith({
        sessionID: "session-1",
        messageID: "assistant-1",
        callID: `${toolCall.tool}-call`,
        tool: toolCall.tool,
        args: toolCall.input,
        title: toolCall.tool,
        output: "ok",
      });

      await cleanup?.();
    },
  );

  test("captures the complete model input from each context hook", async () => {
    let context:
      | ((input: {
          sessionID: string;
          system: unknown[];
          messages: unknown[];
          tools: Record<
            string,
            { description: string; input: Record<string, unknown> }
          >;
        }) => void)
      | undefined;
    const registration = { dispose: vi.fn(() => Promise.resolve()) };
    const contextInput: unknown = {
      app: { version: "2.0.4" },
      session: {
        hook: vi.fn((name: string, handler: typeof context) => {
          if (name === "context") {
            context = handler;
          }
          return Promise.resolve(registration);
        }),
      },
      tool: { hook: vi.fn(() => Promise.resolve(registration)) },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield* [];
          },
        }),
      },
    };
    const pluginContext = Schema.decodeUnknownSync(
      Schema.declare(
        (input): input is Parameters<typeof SourcePlugin.setup>[0] =>
          typeof input === "object" && input !== null,
      ),
    )(contextInput);

    const cleanup = await SourcePlugin.setup(pluginContext);
    await vi.waitFor(() => {
      expect(context).toBeTypeOf("function");
    });

    const system = [{ type: "text", text: "System instructions" }];
    const messages = [
      { role: "user", content: [{ type: "text", text: "Earlier message" }] },
      { role: "assistant", content: [{ type: "text", text: "Earlier reply" }] },
    ];
    context?.({
      sessionID: "session-1",
      system,
      messages,
      tools: {
        read: {
          description: "Read a file",
          input: { type: "object", properties: {} },
        },
      },
    });

    expect(runtime.setGenerationInputSnapshot).toHaveBeenCalledWith(
      "session-1",
      {
        system,
        messages,
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    );

    await cleanup?.();
  });
});
