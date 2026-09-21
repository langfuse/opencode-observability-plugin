import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { Effect, Layer, Option, Schema } from "effect";

import {
  LangfuseClientService,
  buildSessionHistory,
  type ToolDefinition,
} from "./langfuse.js";
import { OpencodeClientService } from "./opencode.js";
import { createLangfuseRuntime } from "./runtime.js";
import {
  McpContentSchema,
  McpToolResultSchema,
  NativeToolResultSchema,
  type OpencodeEvent,
} from "./schema.js";
import { log } from "./utils.js";

const refreshSessionHistory = (sessionID: string) =>
  Effect.gen(function* () {
    const opencode = yield* OpencodeClientService;
    const langfuse = yield* LangfuseClientService;
    const response = yield* Effect.tryPromise({
      try: () => opencode.session.messages({ path: { id: sessionID } }),
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) =>
        log(
          "info",
          `Reading the conversation of session ${sessionID} failed: ${formatHookError(error)}`,
        ).pipe(Effect.as(undefined)),
      ),
    );

    if (response === undefined) {
      return;
    }

    if (response.data === undefined) {
      yield* log(
        "info",
        `OpenCode returned no messages for session ${sessionID}; keeping the previous conversation snapshot`,
      );
      return;
    }

    langfuse.setSessionHistory(sessionID, buildSessionHistory(response.data));
  });

const eventHook = (event: OpencodeEvent) =>
  Effect.gen(function* () {
    const langfuse = yield* LangfuseClientService;

    const finalizeSessionTracing = (sessionID?: string) => {
      langfuse.endActiveToolObservations(sessionID);
      langfuse.endActiveGenerationSteps(sessionID);
      langfuse.endActiveTurnObservations(sessionID);

      if (sessionID !== undefined && sessionID !== "") {
        langfuse.clearSessionTraceState(sessionID);
      } else {
        langfuse.clearTraceState();
      }
    };

    if (event.type === "session.idle") {
      yield* log("info", "Flushing spans");
      finalizeSessionTracing(event.properties.sessionID);

      yield* langfuse.forceFlush;
    }

    if (event.type === "server.instance.disposed") {
      finalizeSessionTracing();

      // The tracer provider is process-wide and cannot be registered twice,
      // so an instance disposal must not tear it down (see runtime.ts).
      yield* langfuse.forceFlush;
    }

    if (event.type === "session.created" || event.type === "session.updated") {
      langfuse.rememberSessionParent({
        sessionID: event.properties.info.id,
        parentSessionID: event.properties.info.parentID,
      });
    }

    if (event.type === "session.deleted") {
      langfuse.rememberSessionParent({
        sessionID: event.properties.info.id,
      });
    }

    if (event.type === "session.error" && event.properties.sessionID != null) {
      langfuse.traceSessionError({
        sessionID: event.properties.sessionID,
        error: event.properties.error,
      });
    }

    if (event.type === "message.part.updated") {
      const part = event.properties.part;

      langfuse.rememberAssistantPart(part);
      langfuse.traceReasoningPart(part);

      if (part.type === "tool" && part.state.status === "running") {
        langfuse.traceToolStart({
          sessionID: part.sessionID,
          messageID: part.messageID,
          callID: part.callID,
          tool: part.tool,
          args: part.state.input,
          started: part.state.time.start,
        });
      }

      if (part.type === "tool" && part.state.status === "completed") {
        langfuse.traceToolEnd({
          sessionID: part.sessionID,
          messageID: part.messageID,
          callID: part.callID,
          tool: part.tool,
          args: part.state.input,
          title: part.state.title,
          output: part.state.output,
          started: part.state.time.start,
          completed: part.state.time.end,
        });
      }

      if (part.type === "tool" && part.state.status === "error") {
        langfuse.traceToolError({
          sessionID: part.sessionID,
          messageID: part.messageID,
          callID: part.callID,
          tool: part.tool,
          args: part.state.input,
          error: part.state.error,
          started: part.state.time.start,
          completed: part.state.time.end,
        });
      }
    }

    if (event.type === "session.next.step.started") {
      yield* refreshSessionHistory(event.properties.sessionID);
      langfuse.startActiveGenerationStep({
        sessionID: event.properties.sessionID,
        assistantMessageID:
          "assistantMessageID" in event.properties
            ? event.properties.assistantMessageID
            : undefined,
        agent: event.properties.agent,
        model: event.properties.model,
        started: event.properties.timestamp,
        snapshot: event.properties.snapshot,
      });
    }

    if (event.type === "session.next.step.failed") {
      langfuse.traceFailedGenerationStep({
        id: event.id,
        sessionID: event.properties.sessionID,
        assistantMessageID:
          "assistantMessageID" in event.properties
            ? event.properties.assistantMessageID
            : undefined,
        completed: event.properties.timestamp,
        error: event.properties.error,
      });
    }

    if (
      event.type === "session.next.tool.called" &&
      "assistantMessageID" in event.properties
    ) {
      langfuse.rememberToolCall({
        callID: event.properties.callID,
        messageID: event.properties.assistantMessageID,
        sessionID: event.properties.sessionID,
        tool: event.properties.tool,
        args: event.properties.input,
      });
    }

    if (event.type === "session.next.retried") {
      langfuse.traceEvent({
        id: event.id,
        sessionID: event.properties.sessionID,
        name: "opencode.generation.retry",
        timestamp: event.properties.timestamp,
        output: event.properties.error,
        metadata: {
          attempt: event.properties.attempt,
        },
      });
    }

    if (
      event.type === "session.next.reasoning.ended" &&
      "assistantMessageID" in event.properties
    ) {
      langfuse.rememberReasoning({
        reasoningID: event.properties.reasoningID,
        sessionID: event.properties.sessionID,
        timestamp: event.properties.timestamp,
        text: event.properties.text,
        messageID: event.properties.assistantMessageID,
      });
    }

    if (event.type === "session.next.compaction.ended") {
      const metadata =
        "messageID" in event.properties
          ? {
              messageID: event.properties.messageID,
              reason: event.properties.reason,
              recent: event.properties.recent,
            }
          : { include: event.properties.include };

      langfuse.traceEvent({
        id: event.id,
        sessionID: event.properties.sessionID,
        name: "opencode.generation.compaction",
        timestamp: event.properties.timestamp,
        output: { text: event.properties.text },
        metadata,
      });
    }

    if (event.type === "message.updated") {
      const message = event.properties.info;

      if (message.role !== "assistant") {
        return;
      }

      if (!langfuse.hasSessionHistory(message.sessionID)) {
        yield* refreshSessionHistory(message.sessionID);
      }

      langfuse.startActiveGenerationStep({
        sessionID: message.sessionID,
        assistantMessageID: message.id,
        agent: message.mode,
        model: {
          id: message.modelID,
          providerID: message.providerID,
        },
        started: message.time.created,
      });

      if (message.time.completed === undefined) {
        return;
      }

      langfuse.traceGeneration({
        sessionID: message.sessionID,
        messageID: message.id,
        parentID: message.parentID,
        modelID: message.modelID,
        providerID: message.providerID,
        agent: message.mode,
        mode: message.mode,
        created: message.time.created,
        completed: message.time.completed,
        finish: message.finish,
        cost: message.cost,
        tokens: message.tokens,
      });
    }
  });

const formatHookError = (error: unknown) => {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const flattenMcpContent = (content: readonly unknown[]) => {
  const textParts: string[] = [];

  for (const part of content) {
    const decoded = Schema.decodeUnknownOption(McpContentSchema)(part);
    if (Option.isNone(decoded)) {
      continue;
    }

    if (decoded.value.type === "text") {
      textParts.push(decoded.value.text);
      continue;
    }

    if (decoded.value.type === "resource" && "text" in decoded.value.resource) {
      textParts.push(decoded.value.resource.text);
    }
  }

  return textParts.join("\n\n");
};

const normalizeToolResult = (tool: string, output: unknown) => {
  const nativeResult = Schema.decodeUnknownOption(NativeToolResultSchema)(
    output,
  );
  if (Option.isSome(nativeResult)) {
    return {
      title: nativeResult.value.title,
      output: nativeResult.value.output,
      isError: false,
      unexpected: false,
    };
  }

  const mcpResult = Schema.decodeUnknownOption(McpToolResultSchema)(output);
  if (Option.isSome(mcpResult)) {
    return {
      title: tool,
      output: flattenMcpContent(mcpResult.value.content),
      isError: mcpResult.value.isError === true,
      unexpected: false,
    };
  }
  if (output === undefined || output === null) {
    return { title: tool, output: "", isError: false, unexpected: false };
  }

  return { title: tool, output: "", isError: false, unexpected: true };
};

const main = Effect.gen(function* () {
  const opencode = yield* OpencodeClientService;

  const langfuse = yield* createLangfuseRuntime({}).pipe(
    Effect.catchTag("MissingLangfuseCredentials", (error) =>
      log("warn", `[Tracing disabled] ${error.message}`).pipe(
        Effect.as(undefined),
      ),
    ),
  );

  if (!langfuse) {
    return {};
  }

  yield* log("info", `OTEL tracing initialized → ${langfuse.baseUrl}`);

  const hooksLayer = Layer.merge(
    Layer.succeed(OpencodeClientService, opencode),
    Layer.succeed(LangfuseClientService, langfuse),
  );

  const finalizeTracing = Effect.sync(() => {
    langfuse.endActiveToolObservations();
    langfuse.endActiveGenerationSteps();
    langfuse.endActiveTurnObservations();
    langfuse.clearTraceState();
  });
  const toolDefinitions = new Map<string, Promise<ToolDefinition[]>>();

  const runHook = (
    hookName: string,
    effect: Effect.Effect<
      unknown,
      unknown,
      OpencodeClientService | LangfuseClientService
    >,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.catchAllDefect((defect) =>
          log(
            "error",
            `Langfuse hook "${hookName}" failed: ${formatHookError(defect)}`,
          ).pipe(Effect.catchAll(() => Effect.void)),
        ),
        Effect.catchAll((error) =>
          log(
            "error",
            `Langfuse hook "${hookName}" failed: ${formatHookError(error)}`,
          ).pipe(Effect.catchAll(() => Effect.void)),
        ),
        Effect.asVoid,
        Effect.provide(hooksLayer),
      ),
    );

  const hooks: Hooks = {
    dispose: () =>
      runHook(
        "dispose",
        finalizeTracing.pipe(
          Effect.zipRight(
            Effect.tryPromise({
              try: () => Effect.runPromise(langfuse.forceFlush),
              catch: (error) => error,
            }),
          ),
        ),
      ),

    event: ({ event }) => runHook("event", eventHook(event)),

    "chat.message": (input, output) =>
      runHook(
        "chat.message",
        Effect.gen(function* () {
          let tools: ToolDefinition[] | undefined;

          if (input.model) {
            const enabledTools = output.message.tools;
            const cacheKey = JSON.stringify([
              input.model.providerID,
              input.model.modelID,
              enabledTools,
            ]);
            let pendingTools = toolDefinitions.get(cacheKey);

            if (!pendingTools) {
              pendingTools = opencode.tool
                .list({
                  query: {
                    provider: input.model.providerID,
                    model: input.model.modelID,
                  },
                })
                .then(({ data }) =>
                  (data ?? [])
                    .filter((tool) => enabledTools?.[tool.id] !== false)
                    .map((tool) => ({
                      name: tool.id,
                      description: tool.description,
                      ...(typeof tool.parameters === "object" &&
                      tool.parameters !== null &&
                      !Array.isArray(tool.parameters)
                        ? {
                            parameters: tool.parameters,
                          }
                        : {}),
                    })),
                )
                .catch(() => {
                  toolDefinitions.delete(cacheKey);
                  return [];
                });
              toolDefinitions.set(cacheKey, pendingTools);
            }

            tools = yield* Effect.promise(() => pendingTools);
          }

          yield* Effect.sync(() => {
            langfuse.traceUserMessage({
              sessionID: input.sessionID,
              messageID: input.messageID,
              agent: input.agent,
              model: input.model,
              parts: output.parts,
              tools,
            });
          });
        }),
      ),

    "tool.execute.before": (input, output) =>
      runHook(
        "tool.execute.before",
        Effect.try({
          try: () => {
            langfuse.traceToolStart({
              sessionID: input.sessionID,
              callID: input.callID,
              tool: input.tool,
              args: output.args,
            });
          },
          catch: (error) => error,
        }),
      ),

    "tool.execute.after": (input, output) =>
      runHook(
        "tool.execute.after",
        Effect.gen(function* () {
          const normalized = normalizeToolResult(input.tool, output);

          if (normalized.unexpected) {
            yield* log(
              "warn",
              `Tool "${input.tool}" returned an unrecognized result shape; recording empty output`,
            );
          }

          if (normalized.isError) {
            yield* Effect.sync(() => {
              langfuse.traceToolError({
                sessionID: input.sessionID,
                callID: input.callID,
                tool: input.tool,
                args: input.args,
                error:
                  normalized.output ||
                  `MCP tool "${input.tool}" returned an error`,
                completed: Date.now(),
              });
            });
            return;
          }

          yield* Effect.try({
            try: () => {
              langfuse.traceToolEnd({
                sessionID: input.sessionID,
                callID: input.callID,
                tool: input.tool,
                args: input.args,
                title: normalized.title,
                output: normalized.output,
              });
            },
            catch: (error) => error,
          });
        }),
      ),
  };

  return hooks;
});

const LangfusePlugin: Plugin = async ({ client }) => {
  const clientLayer = Layer.succeed(OpencodeClientService, client);

  return Effect.runPromise(main.pipe(Effect.provide(clientLayer)));
};

export default LangfusePlugin;
