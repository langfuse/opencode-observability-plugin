import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { Hooks } from "@opencode-ai/plugin";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import type { Span as ApiSpan, Tracer } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { Context as EffectContext, Effect } from "effect";

import { PLUGIN_VERSION } from "./version.js";

export class LangfuseClient {
  readonly baseUrl: string;
  readonly forceFlush: Effect.Effect<void, unknown>;
  readonly shutdown: Effect.Effect<void, unknown>;
  private readonly traceState: LangfuseTraceState;

  constructor(input: {
    baseUrl: string;
    traceState: LangfuseTraceState;
    forceFlush: Effect.Effect<void, unknown>;
    shutdown: Effect.Effect<void, unknown>;
  }) {
    this.baseUrl = input.baseUrl;
    this.traceState = input.traceState;
    this.forceFlush = input.forceFlush;
    this.shutdown = input.shutdown;
  }

  clearTraceState() {
    this.traceState.assistantParts.clear();
    this.traceState.abortedSessions.clear();
    this.traceState.tracedEventIds.clear();
    this.traceState.tracedReasoningIds.clear();
    this.traceState.generationSpansByMessageId.clear();
    this.traceState.activeGenerationStepsByMessageId.clear();
    this.traceState.toolMessageIdsByCallId.clear();
    this.traceState.generationParentSpans.clear();
    this.traceState.generationInputsBySession.clear();
    this.traceState.toolResultSourceMessageIdsBySession.clear();
    this.traceState.turnObservationsByMessageId.clear();
    this.traceState.latestTurnObservationsBySession.clear();
    this.traceState.finalizedToolCallIds.clear();
    this.traceState.sessionParentIds.clear();
  }

  clearSessionTraceState(sessionID: string) {
    const sessionMessageIds = new Set<string>();

    for (const [messageID, parts] of this.traceState.assistantParts) {
      if (
        Array.from(parts.values()).some((part) => part.sessionID === sessionID)
      ) {
        sessionMessageIds.add(messageID);
        this.traceState.assistantParts.delete(messageID);
      }
    }

    for (const [messageID, step] of this.traceState
      .activeGenerationStepsByMessageId) {
      if (step.sessionID === sessionID) {
        sessionMessageIds.add(messageID);
        this.traceState.activeGenerationStepsByMessageId.delete(messageID);
      }
    }

    for (const [messageID, observation] of this.traceState
      .turnObservationsByMessageId) {
      if (observation.sessionID === sessionID) {
        sessionMessageIds.add(messageID);
        this.traceState.turnObservationsByMessageId.delete(messageID);
      }
    }

    for (const messageID of sessionMessageIds) {
      this.traceState.tracedMessageIds.delete(messageID);
      this.traceState.tracedGenerationIds.delete(messageID);
      this.traceState.generationSpansByMessageId.delete(messageID);
    }

    for (const [callID, messageID] of this.traceState.toolMessageIdsByCallId) {
      if (sessionMessageIds.has(messageID)) {
        this.traceState.toolMessageIdsByCallId.delete(callID);
      }
    }

    for (const reasoningID of this.traceState.tracedReasoningIds) {
      if (reasoningID.startsWith(`${sessionID}:`)) {
        this.traceState.tracedReasoningIds.delete(reasoningID);
      }
    }

    this.traceState.abortedSessions.delete(sessionID);
    this.traceState.activeGenerationSteps.delete(sessionID);
    this.traceState.generationParentSpans.delete(sessionID);
    this.traceState.generationInputsBySession.delete(sessionID);
    this.traceState.toolResultSourceMessageIdsBySession.delete(sessionID);
    this.traceState.latestTurnObservationsBySession.delete(sessionID);
  }

  endActiveToolObservations(sessionID?: string, error?: SessionErrorInfo) {
    for (const [callID, observation] of this.traceState
      .activeToolObservations) {
      if (sessionID && observation.sessionID !== sessionID) {
        continue;
      }

      if (error && error.name !== "MessageAbortedError") {
        const message = this.getSessionErrorMessage(error);

        observation.span.setStatus({
          code: SpanStatusCode.ERROR,
          message,
        });
        observation.span.recordException({ message, name: error.name });
      }

      observation.span.end();
      this.traceState.activeToolObservations.delete(callID);
      this.traceState.finalizedToolCallIds.add(callID);
      this.traceState.toolMessageIdsByCallId.delete(callID);
    }
  }

  endActiveGenerationSteps(sessionID?: string, error?: SessionErrorInfo) {
    const activeSteps = new Set([
      ...this.traceState.activeGenerationSteps.values(),
      ...this.traceState.activeGenerationStepsByMessageId.values(),
    ]);

    for (const step of activeSteps) {
      if (sessionID && step.sessionID !== sessionID) {
        continue;
      }

      if (error && error.name !== "MessageAbortedError") {
        const message = this.getSessionErrorMessage(error);

        step.span.setStatus({
          code: SpanStatusCode.ERROR,
          message,
        });
        step.span.recordException({ message, name: error.name });
      }

      step.span.end();
    }

    for (const [activeSessionID, step] of this.traceState
      .activeGenerationSteps) {
      if (!sessionID || step.sessionID === sessionID) {
        this.traceState.activeGenerationSteps.delete(activeSessionID);
        this.traceState.generationParentSpans.delete(activeSessionID);
      }
    }

    for (const [messageID, step] of this.traceState
      .activeGenerationStepsByMessageId) {
      if (!sessionID || step.sessionID === sessionID) {
        this.traceState.activeGenerationStepsByMessageId.delete(messageID);
      }
    }
  }

  endActiveTurnObservations(sessionID?: string) {
    const observations = new Set([
      ...this.traceState.latestTurnObservationsBySession.values(),
      ...this.traceState.turnObservationsByMessageId.values(),
    ]);

    for (const observation of observations) {
      if (sessionID && observation.sessionID !== sessionID) {
        continue;
      }

      observation.span.end();
    }

    for (const [messageID, observation] of this.traceState
      .turnObservationsByMessageId) {
      if (!sessionID || observation.sessionID === sessionID) {
        this.traceState.turnObservationsByMessageId.delete(messageID);
      }
    }

    for (const [activeSessionID, observation] of this.traceState
      .latestTurnObservationsBySession) {
      if (!sessionID || observation.sessionID === sessionID) {
        this.traceState.latestTurnObservationsBySession.delete(activeSessionID);
      }
    }
  }

  rememberSessionParent(input: {
    sessionID: string;
    parentSessionID?: string;
  }) {
    if (input.parentSessionID) {
      this.traceState.sessionParentIds.set(
        input.sessionID,
        input.parentSessionID,
      );
    } else {
      this.traceState.sessionParentIds.delete(input.sessionID);
    }
  }

  traceEvent(input: {
    id: string;
    sessionID: string;
    name: string;
    timestamp: number;
    input?: unknown;
    output?: unknown;
    metadata?: unknown;
    parentSpan?: ApiSpan;
  }) {
    if (this.traceState.tracedEventIds.has(input.id)) {
      return;
    }

    this.traceState.tracedEventIds.add(input.id);

    const startEvent = () => {
      const span = this.traceState.tracer.startSpan(input.name, {
        attributes: {
          "langfuse.observation.type": "event",
          "session.id": input.sessionID,
          ...(input.input === undefined
            ? {}
            : { "langfuse.observation.input": JSON.stringify(input.input) }),
          ...(input.output === undefined
            ? {}
            : { "langfuse.observation.output": JSON.stringify(input.output) }),
          "langfuse.observation.metadata": JSON.stringify(input.metadata),
        },
        startTime: new Date(input.timestamp),
      });

      span.end(new Date(input.timestamp));
    };

    if (input.parentSpan) {
      context.with(
        trace.setSpan(context.active(), input.parentSpan),
        startEvent,
      );
      return;
    }

    this.withObservationParent(input.sessionID, startEvent);
  }

  rememberReasoning(input: {
    reasoningID: string;
    sessionID: string;
    timestamp: number;
    text: string;
    messageID?: string;
  }) {
    if (!input.text.trim()) {
      return;
    }

    const reasoningTraceKey = `${input.sessionID}:${input.reasoningID}`;

    if (this.traceState.tracedReasoningIds.has(reasoningTraceKey)) {
      return;
    }

    this.traceState.tracedReasoningIds.add(reasoningTraceKey);

    if (!input.messageID) {
      return;
    }

    const parts =
      this.traceState.assistantParts.get(input.messageID) ??
      new Map<string, MessagePart>();
    parts.set(input.reasoningID, {
      id: input.reasoningID,
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "reasoning",
      text: input.text,
      time: { start: input.timestamp, end: input.timestamp },
    });
    this.traceState.assistantParts.set(input.messageID, parts);
  }

  traceReasoningPart(part: MessagePart) {
    if (
      part.type !== "reasoning" ||
      typeof part.id !== "string" ||
      typeof part.sessionID !== "string" ||
      typeof part.messageID !== "string" ||
      typeof part.text !== "string"
    ) {
      return;
    }

    const completed = getCompletedReasoningTimestamp(part);

    if (completed === undefined) {
      return;
    }

    this.rememberReasoning({
      reasoningID: part.id,
      sessionID: part.sessionID,
      timestamp: completed,
      text: part.text,
      messageID: part.messageID,
    });
  }

  startActiveGenerationStep(input: {
    sessionID: string;
    assistantMessageID?: string;
    agent: string;
    model: NonNullable<ActiveGenerationStep["model"]>;
    started: number;
    snapshot?: string;
  }) {
    const messageID = input.assistantMessageID;
    const existingMessageStep = messageID
      ? this.traceState.activeGenerationStepsByMessageId.get(messageID)
      : undefined;
    const existingStep = this.traceState.activeGenerationSteps.get(
      input.sessionID,
    );

    if (
      messageID &&
      !existingMessageStep &&
      this.traceState.generationSpansByMessageId.has(messageID)
    ) {
      return;
    }

    if (existingMessageStep && messageID) {
      const updatedStep = {
        ...existingMessageStep,
        agent: input.agent,
        model: {
          ...input.model,
          variant: input.model.variant ?? existingMessageStep.model?.variant,
        },
        snapshot: input.snapshot ?? existingMessageStep.snapshot,
      };

      existingMessageStep.span.setAttribute(
        "langfuse.observation.model.name",
        input.model.id,
      );
      existingMessageStep.span.setAttribute(
        "langfuse.observation.metadata",
        JSON.stringify({
          agent: updatedStep.agent,
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Existing violation tracked for incremental cleanup.
          providerID: updatedStep.model?.providerID,
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Existing violation tracked for incremental cleanup.
          variant: updatedStep.model?.variant,
          snapshot: updatedStep.snapshot,
        }),
      );
      this.traceState.activeGenerationStepsByMessageId.set(
        messageID,
        updatedStep,
      );

      if (!existingStep || existingStep.messageID === messageID) {
        this.traceState.activeGenerationSteps.set(input.sessionID, updatedStep);
      }

      return;
    }

    if (existingStep && !existingStep.messageID && messageID) {
      const updatedStep = {
        ...existingStep,
        sessionID: input.sessionID,
        messageID,
        agent: input.agent,
        model: {
          ...input.model,
          variant: input.model.variant ?? existingStep.model?.variant,
        },
        snapshot: input.snapshot ?? existingStep.snapshot,
      };

      existingStep.span.setAttribute(
        "langfuse.observation.model.name",
        input.model.id,
      );
      existingStep.span.setAttribute(
        "langfuse.observation.metadata",
        JSON.stringify({
          agent: input.agent,
          providerID: input.model.providerID,
          variant: input.model.variant,
          snapshot: input.snapshot,
        }),
      );
      this.traceState.activeGenerationSteps.set(input.sessionID, updatedStep);
      this.traceState.activeGenerationStepsByMessageId.set(
        messageID,
        updatedStep,
      );
      this.traceState.generationSpansByMessageId.set(
        messageID,
        existingStep.span,
      );

      return;
    }

    if (!messageID && existingStep) {
      return;
    }

    if (!this.getTurnObservation(input.sessionID, undefined)) {
      return;
    }

    const generationInput = this.consumeGenerationInput(input.sessionID);

    this.withTurnParent(input.sessionID, undefined, () => {
      const span = this.traceState.tracer.startSpan("opencode.generation", {
        attributes: {
          "langfuse.observation.type": "generation",
          "session.id": input.sessionID,
          "langfuse.observation.model.name": input.model.id,
          ...(generationInput
            ? {
                "langfuse.observation.input": JSON.stringify(generationInput),
              }
            : {}),
          "langfuse.observation.metadata": JSON.stringify({
            agent: input.agent,
            providerID: input.model.providerID,
            variant: input.model.variant,
            snapshot: input.snapshot,
          }),
        },
        startTime: new Date(input.started),
      });

      this.traceState.activeGenerationSteps.set(input.sessionID, {
        sessionID: input.sessionID,
        messageID,
        agent: input.agent,
        model: input.model,
        span,
        snapshot: input.snapshot,
      });
      if (messageID) {
        const step = this.traceState.activeGenerationSteps.get(input.sessionID);
        if (step) {
          this.traceState.activeGenerationStepsByMessageId.set(messageID, step);
          this.traceState.generationSpansByMessageId.set(messageID, span);
        }
      }
      this.traceState.generationParentSpans.set(input.sessionID, span);
    });
  }

  traceUserMessage(input: {
    sessionID: string;
    messageID?: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
    parts: MessagePart[];
    tools?: ToolDefinition[];
  }) {
    if (
      input.messageID &&
      this.traceState.tracedMessageIds.has(input.messageID)
    ) {
      return;
    }

    this.traceState.abortedSessions.delete(input.sessionID);

    const formattedMessage = {
      role: "user" as const,
      content: input.parts.map((part) => {
        if (part.type === "text") {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Existing violation tracked for incremental cleanup.
          return { type: part.type, text: part.text ?? "" };
        }

        if (part.type === "file") {
          return {
            type: part.type,
            filename: part.filename,
            url: part.url,
          };
        }

        if (part.type === "agent") {
          return { type: part.type, name: part.name };
        }

        if (part.type === "subtask") {
          return {
            type: part.type,
            prompt: part.prompt,
            agent: part.agent,
          };
        }

        if (part.type === "tool") {
          return {
            type: part.type,
            tool: part.tool,
            title: "title" in part.state ? part.state.title : undefined,
          };
        }

        return { type: part.type };
      }),
    };
    const generationInput = [
      {
        ...formattedMessage,
        ...(input.tools?.length ? { tools: input.tools } : {}),
      },
    ];

    this.traceState.generationInputsBySession.set(
      input.sessionID,
      generationInput,
    );

    if (input.messageID) {
      this.traceState.tracedMessageIds.add(input.messageID);
    }

    const previousTurn = this.traceState.latestTurnObservationsBySession.get(
      input.sessionID,
    );

    if (previousTurn) {
      previousTurn.span.end();
      this.traceState.latestTurnObservationsBySession.delete(input.sessionID);
    }

    this.traceState.generationParentSpans.delete(input.sessionID);

    const parentSessionID = this.traceState.sessionParentIds.get(
      input.sessionID,
    );
    const parentSpan = this.getSessionParentSpan(input.sessionID);
    const startTurn = () => {
      const span = this.traceState.tracer.startSpan("opencode.turn", {
        attributes: {
          "langfuse.observation.type": "agent",
          "langfuse.internal.is_app_root": !parentSpan,
          "session.id": input.sessionID,
          "langfuse.observation.input": JSON.stringify([formattedMessage]),
          "langfuse.observation.metadata": JSON.stringify({
            messageID: input.messageID,
            agent: input.agent,
            providerID: input.model?.providerID,
            modelID: input.model?.modelID,
            parentSessionID,
          }),
        },
      });

      if (parentSpan) {
        span.setAttribute("langfuse.internal.is_app_root", false);
      }

      const observation = {
        span,
        sessionID: input.sessionID,
        messageID: input.messageID,
      } satisfies TurnObservation;

      if (input.messageID) {
        this.traceState.turnObservationsByMessageId.set(
          input.messageID,
          observation,
        );
      }

      this.traceState.latestTurnObservationsBySession.set(
        input.sessionID,
        observation,
      );

      context.with(trace.setSpan(context.active(), span), () => {
        const event = this.traceState.tracer.startSpan(
          "opencode.message.user",
          {
            attributes: {
              "langfuse.observation.type": "event",
              "session.id": input.sessionID,
              "langfuse.observation.input": JSON.stringify([formattedMessage]),
              "langfuse.observation.metadata": JSON.stringify({
                messageID: input.messageID,
                agent: input.agent,
                providerID: input.model?.providerID,
                modelID: input.model?.modelID,
                parentSessionID,
              }),
            },
          },
        );

        event.end();
      });
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Existing violation tracked for incremental cleanup.
    parentSpan
      ? context.with(trace.setSpan(context.active(), parentSpan), startTurn)
      : startTurn();
  }

  rememberAssistantPart(part: MessagePart) {
    if (!part.id || !part.messageID) {
      return;
    }

    const parts =
      this.traceState.assistantParts.get(part.messageID) ??
      new Map<string, MessagePart>();

    parts.set(part.id, part);
    this.traceState.assistantParts.set(part.messageID, parts);

    if (part.type === "tool") {
      this.traceState.toolMessageIdsByCallId.set(part.callID, part.messageID);
    }
  }

  rememberToolCall(input: {
    callID: string;
    messageID: string;
    sessionID: string;
    tool: string;
    args: Record<string, unknown>;
  }) {
    this.traceState.toolMessageIdsByCallId.set(input.callID, input.messageID);

    const parts =
      this.traceState.assistantParts.get(input.messageID) ??
      new Map<string, MessagePart>();
    parts.set(`tool:${input.callID}`, {
      id: `tool:${input.callID}`,
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "tool",
      callID: input.callID,
      tool: input.tool,
      state: { status: "pending", input: input.args, raw: "" },
    });
    this.traceState.assistantParts.set(input.messageID, parts);
  }

  traceGeneration(input: {
    sessionID: string;
    messageID: string;
    parentID: string;
    modelID: string;
    providerID: string;
    agent?: string;
    mode: string;
    created: number;
    completed: number;
    finish?: string;
    cost: number;
    tokens: {
      total?: number;
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
  }) {
    if (this.traceState.abortedSessions.has(input.sessionID)) {
      return;
    }

    if (this.traceState.tracedGenerationIds.has(input.messageID)) {
      return;
    }

    this.traceState.tracedGenerationIds.add(input.messageID);

    const output = this.getAssistantMessage(input.messageID);
    const turn = this.getTurnObservation(input.sessionID, input.parentID);

    if (input.mode !== "compaction") {
      turn?.span.setAttribute(
        "langfuse.observation.output",
        JSON.stringify(output),
      );
    }
    const activeStep = this.traceState.activeGenerationSteps.get(
      input.sessionID,
    );
    const step =
      this.traceState.activeGenerationStepsByMessageId.get(input.messageID) ??
      (activeStep?.messageID === input.messageID || !activeStep?.messageID
        ? activeStep
        : undefined);

    if (step) {
      step.span.setAttribute("langfuse.observation.model.name", input.modelID);
      step.span.setAttribute(
        "langfuse.observation.output",
        JSON.stringify(output),
      );
      step.span.setAttribute(
        "langfuse.observation.usage_details",
        JSON.stringify({
          input: input.tokens.input,
          output: input.tokens.output,
          reasoning: input.tokens.reasoning,
          cache_read: input.tokens.cache.read,
          cache_write: input.tokens.cache.write,
          total:
            input.tokens.total ??
            input.tokens.input + input.tokens.output + input.tokens.reasoning,
        }),
      );
      step.span.setAttribute(
        "langfuse.observation.cost_details",
        JSON.stringify({ total: input.cost }),
      );
      step.span.setAttribute(
        "langfuse.observation.metadata",
        JSON.stringify({
          messageID: input.messageID,
          parentID: input.parentID,
          agent: input.agent,
          providerID: input.providerID,
          mode: input.mode,
          finish: input.finish,
          variant: step.model?.variant,
          snapshot: step.snapshot,
        }),
      );

      this.traceState.generationSpansByMessageId.set(
        input.messageID,
        step.span,
      );
      step.span.end(new Date(input.completed));
      this.traceState.activeGenerationStepsByMessageId.delete(input.messageID);

      if (activeStep === step) {
        this.traceState.activeGenerationSteps.delete(input.sessionID);
      }

      return;
    }

    if (!turn) {
      return;
    }

    const generationInput = this.consumeGenerationInput(input.sessionID);

    this.withTurnParent(input.sessionID, input.parentID, () => {
      const span = this.traceState.tracer.startSpan("opencode.generation", {
        attributes: {
          "langfuse.observation.type": "generation",
          "session.id": input.sessionID,
          "langfuse.observation.model.name": input.modelID,
          ...(generationInput
            ? {
                "langfuse.observation.input": JSON.stringify(generationInput),
              }
            : {}),
          "langfuse.observation.output": JSON.stringify(output),
          "langfuse.observation.usage_details": JSON.stringify({
            input: input.tokens.input,
            output: input.tokens.output,
            reasoning: input.tokens.reasoning,
            cache_read: input.tokens.cache.read,
            cache_write: input.tokens.cache.write,
            total:
              input.tokens.total ??
              input.tokens.input + input.tokens.output + input.tokens.reasoning,
          }),
          "langfuse.observation.cost_details": JSON.stringify({
            total: input.cost,
          }),
          "langfuse.observation.metadata": JSON.stringify({
            messageID: input.messageID,
            parentID: input.parentID,
            agent: input.agent,
            providerID: input.providerID,
            mode: input.mode,
            finish: input.finish,
          }),
        },
        startTime: new Date(input.created),
      });

      this.traceState.generationParentSpans.set(input.sessionID, span);
      this.traceState.generationSpansByMessageId.set(input.messageID, span);
      span.end(new Date(input.completed));
    });
  }

  traceFailedGenerationStep(input: {
    id: string;
    sessionID: string;
    assistantMessageID?: string;
    completed: number;
    error: { message: string };
  }) {
    if (this.traceState.tracedGenerationIds.has(input.id)) {
      return;
    }

    this.traceState.tracedGenerationIds.add(input.id);

    const activeStep = this.traceState.activeGenerationSteps.get(
      input.sessionID,
    );
    const step = input.assistantMessageID
      ? (this.traceState.activeGenerationStepsByMessageId.get(
          input.assistantMessageID,
        ) ??
        (activeStep?.messageID === input.assistantMessageID ||
        !activeStep?.messageID
          ? activeStep
          : undefined))
      : activeStep;

    if (step) {
      step.span.setAttribute(
        "langfuse.observation.output",
        JSON.stringify({ error: input.error }),
      );
      step.span.setAttribute(
        "langfuse.observation.metadata",
        JSON.stringify({
          agent: step.agent,
          providerID: step.model?.providerID,
          variant: step.model?.variant,
          snapshot: step.snapshot,
        }),
      );
      step.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: input.error.message,
      });
      step.span.recordException(input.error);
      step.span.end(new Date(input.completed));
      const messageID = input.assistantMessageID ?? step.messageID;
      if (messageID) {
        this.traceState.activeGenerationStepsByMessageId.delete(messageID);
      }

      if (activeStep === step) {
        this.traceState.activeGenerationSteps.delete(input.sessionID);
      }

      return;
    }

    if (!this.getTurnObservation(input.sessionID, undefined)) {
      return;
    }

    this.withTurnParent(input.sessionID, undefined, () => {
      const span = this.traceState.tracer.startSpan(
        "opencode.generation.failed",
        {
          attributes: {
            "langfuse.observation.type": "generation",
            "session.id": input.sessionID,
            "langfuse.observation.output": JSON.stringify({
              error: input.error,
            }),
          },
          startTime: new Date(input.completed),
        },
      );

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: input.error.message,
      });
      span.recordException(input.error);
      this.traceState.generationParentSpans.set(input.sessionID, span);
      span.end(new Date(input.completed));
    });
  }

  traceSessionError(input: { sessionID: string; error?: SessionErrorInfo }) {
    this.endActiveToolObservations(input.sessionID, input.error);
    this.endActiveGenerationSteps(input.sessionID, input.error);

    if (input.error?.name === "MessageAbortedError") {
      this.traceState.abortedSessions.add(input.sessionID);
    }

    const turn = this.getTurnObservation(input.sessionID, undefined);

    if (!turn) {
      this.traceState.generationParentSpans.delete(input.sessionID);

      return;
    }

    if (input.error) {
      turn.span.setAttribute(
        "langfuse.observation.output",
        JSON.stringify({ error: input.error }),
      );

      if (input.error.name !== "MessageAbortedError") {
        const message = this.getSessionErrorMessage(input.error);

        turn.span.setStatus({
          code: SpanStatusCode.ERROR,
          message,
        });
        turn.span.recordException({ message, name: input.error.name });
      }
    }

    turn.span.end();

    if (turn.messageID) {
      this.traceState.turnObservationsByMessageId.delete(turn.messageID);
    }

    this.traceState.latestTurnObservationsBySession.delete(input.sessionID);
    this.traceState.generationParentSpans.delete(input.sessionID);
  }

  traceToolStart(input: {
    sessionID: string;
    callID: string;
    tool: string;
    args: unknown;
    messageID?: string;
    started?: number;
  }) {
    if (
      this.traceState.finalizedToolCallIds.has(input.callID) ||
      this.traceState.activeToolObservations.has(input.callID)
    ) {
      return;
    }

    this.ensureGenerationParent(input.sessionID);

    this.withObservationParent(
      input.sessionID,
      () => {
        const span = this.traceState.tracer.startSpan(input.tool, {
          attributes: {
            "langfuse.observation.type": "tool",
            "session.id": input.sessionID,
            "langfuse.observation.input": JSON.stringify(input.args),
            "langfuse.observation.metadata": JSON.stringify({
              callID: input.callID,
              tool: input.tool,
            }),
          },
          ...(input.started === undefined
            ? {}
            : { startTime: new Date(input.started) }),
        });

        this.traceState.activeToolObservations.set(input.callID, {
          span,
          sessionID: input.sessionID,
          tool: input.tool,
        });
      },
      input.messageID ??
        this.traceState.toolMessageIdsByCallId.get(input.callID),
    );
  }

  traceToolEnd(input: {
    sessionID: string;
    callID: string;
    tool: string;
    args: unknown;
    title: string;
    output: string;
    messageID?: string;
    started?: number;
    completed?: number;
  }) {
    if (this.traceState.finalizedToolCallIds.has(input.callID)) {
      return;
    }

    if (!this.traceState.activeToolObservations.has(input.callID)) {
      this.traceToolStart({
        sessionID: input.sessionID,
        callID: input.callID,
        tool: input.tool,
        args: input.args,
        messageID: input.messageID,
        started: input.started,
      });
    }

    const span = this.traceState.activeToolObservations.get(input.callID)?.span;

    if (!span) {
      return;
    }

    span.setAttribute(
      "langfuse.observation.output",
      JSON.stringify({ title: input.title, output: input.output }),
    );
    span.setAttribute(
      "langfuse.observation.metadata",
      JSON.stringify({
        callID: input.callID,
        tool: input.tool,
      }),
    );

    span.end(
      input.completed === undefined ? undefined : new Date(input.completed),
    );
    this.rememberToolResult({
      sessionID: input.sessionID,
      callID: input.callID,
      tool: input.tool,
      content: input.output,
      messageID: input.messageID,
    });
    this.traceState.activeToolObservations.delete(input.callID);
    this.traceState.finalizedToolCallIds.add(input.callID);
    this.traceState.toolMessageIdsByCallId.delete(input.callID);
  }

  traceToolError(input: {
    callID: string;
    error: string;
    completed: number;
    sessionID?: string;
    tool?: string;
    args?: unknown;
    messageID?: string;
    started?: number;
  }) {
    if (this.traceState.finalizedToolCallIds.has(input.callID)) {
      return;
    }

    if (
      !this.traceState.activeToolObservations.has(input.callID) &&
      input.sessionID &&
      input.tool
    ) {
      this.traceToolStart({
        sessionID: input.sessionID,
        callID: input.callID,
        tool: input.tool,
        args: input.args,
        messageID: input.messageID,
        started: input.started,
      });
    }

    const observation = this.traceState.activeToolObservations.get(
      input.callID,
    );
    const span = observation?.span;

    if (!span) {
      return;
    }

    span.setAttribute(
      "langfuse.observation.output",
      JSON.stringify({ error: input.error }),
    );
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: input.error,
    });
    span.recordException({ message: input.error });
    span.end(new Date(input.completed));
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Existing violation tracked for incremental cleanup.
    if (observation) {
      this.rememberToolResult({
        sessionID: observation.sessionID,
        callID: input.callID,
        tool: input.tool ?? observation.tool,
        content: input.error,
        messageID: input.messageID,
      });
    }
    this.traceState.activeToolObservations.delete(input.callID);
    this.traceState.finalizedToolCallIds.add(input.callID);
    this.traceState.toolMessageIdsByCallId.delete(input.callID);
  }

  private ensureGenerationParent(sessionID: string) {
    if (
      this.traceState.activeGenerationSteps.has(sessionID) ||
      this.traceState.generationParentSpans.has(sessionID)
    ) {
      return;
    }

    if (!this.getTurnObservation(sessionID, undefined)) {
      return;
    }

    this.withTurnParent(sessionID, undefined, () => {
      const generationInput = this.consumeGenerationInput(sessionID);
      const span = this.traceState.tracer.startSpan("opencode.generation", {
        attributes: {
          "langfuse.observation.type": "generation",
          "session.id": sessionID,
          ...(generationInput
            ? {
                "langfuse.observation.input": JSON.stringify(generationInput),
              }
            : {}),
        },
      });

      this.traceState.activeGenerationSteps.set(sessionID, {
        sessionID,
        span,
      });
      this.traceState.generationParentSpans.set(sessionID, span);
    });
  }

  private withTurnParent<T>(
    sessionID: string,
    messageID: string | undefined,
    fn: () => T,
  ) {
    const parentSpan = this.getTurnObservation(sessionID, messageID)?.span;

    return parentSpan
      ? context.with(trace.setSpan(context.active(), parentSpan), fn)
      : fn();
  }

  private getTurnObservation(sessionID: string, messageID: string | undefined) {
    return (
      (messageID
        ? this.traceState.turnObservationsByMessageId.get(messageID)
        : undefined) ??
      this.traceState.latestTurnObservationsBySession.get(sessionID)
    );
  }

  private getSessionParentSpan(sessionID: string) {
    const parentSessionID = this.traceState.sessionParentIds.get(sessionID);

    if (!parentSessionID) {
      return undefined;
    }

    return (
      this.traceState.activeGenerationSteps.get(parentSessionID)?.span ??
      this.traceState.generationParentSpans.get(parentSessionID) ??
      this.traceState.latestTurnObservationsBySession.get(parentSessionID)?.span
    );
  }

  private withObservationParent<T>(
    sessionID: string,
    fn: () => T,
    messageID?: string,
  ) {
    const parentSpan =
      (messageID
        ? this.traceState.generationSpansByMessageId.get(messageID)
        : undefined) ??
      this.traceState.activeGenerationSteps.get(sessionID)?.span ??
      this.traceState.generationParentSpans.get(sessionID);

    return parentSpan
      ? context.with(trace.setSpan(context.active(), parentSpan), fn)
      : fn();
  }

  private getAssistantMessage(messageID: string) {
    const parts = Array.from(
      this.traceState.assistantParts.get(messageID)?.values() ?? [],
    );
    const content = parts
      .filter(
        (part): part is Extract<MessagePart, { type: "text" }> =>
          part.type === "text" && Boolean(part.text),
      )
      .map((part) => part.text)
      .join("");
    const thinking = parts
      .filter(
        (part): part is Extract<MessagePart, { type: "reasoning" }> =>
          part.type === "reasoning" && Boolean(part.text),
      )
      .map((part) => ({ type: "thinking" as const, content: part.text }));
    const toolCallsById = new Map(
      parts
        .filter(
          (part): part is Extract<MessagePart, { type: "tool" }> =>
            part.type === "tool",
        )
        .map((part) => [part.callID, part] as const),
    );
    const toolCalls = Array.from(toolCallsById.values()).map((part) => ({
      id: part.callID,
      name: part.tool,
      arguments: JSON.stringify(part.state.input),
    }));

    if (!content && thinking.length === 0 && toolCalls.length === 0) {
      return undefined;
    }

    return [
      {
        role: "assistant" as const,
        ...(content ? { content } : {}),
        ...(thinking.length ? { thinking } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
    ];
  }

  private consumeGenerationInput(sessionID: string) {
    const input = this.traceState.generationInputsBySession.get(sessionID);
    const sourceMessageID =
      this.traceState.toolResultSourceMessageIdsBySession.get(sessionID);
    this.traceState.generationInputsBySession.delete(sessionID);
    this.traceState.toolResultSourceMessageIdsBySession.delete(sessionID);

    if (!sourceMessageID) {
      return input;
    }

    return [
      ...(this.getAssistantMessage(sourceMessageID) ?? []),
      ...(input ?? []),
    ];
  }

  private rememberToolResult(input: {
    sessionID: string;
    callID: string;
    tool: string;
    content: string;
    messageID?: string;
  }) {
    const messageID =
      input.messageID ??
      this.traceState.toolMessageIdsByCallId.get(input.callID);
    const toolResults =
      this.traceState.generationInputsBySession.get(input.sessionID) ?? [];
    toolResults.push({
      role: "tool",
      name: input.tool,
      tool_call_id: input.callID,
      content: input.content,
    });
    this.traceState.generationInputsBySession.set(input.sessionID, toolResults);

    if (messageID) {
      this.traceState.toolResultSourceMessageIdsBySession.set(
        input.sessionID,
        messageID,
      );
    }
  }

  private getSessionErrorMessage(error: SessionErrorInfo) {
    if ("message" in error && typeof error.message === "string") {
      return error.message;
    }

    if (
      "data" in error &&
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Existing violation tracked for incremental cleanup.
      error.data &&
      typeof error.data === "object" &&
      "message" in error.data &&
      typeof error.data.message === "string"
    ) {
      return error.data.message;
    }

    return error.name;
  }
}

export type LangfuseTraceState = {
  tracerName: string;
  tracer: Tracer;
  abortedSessions: Set<string>;
  tracedMessageIds: Set<string>;
  tracedGenerationIds: Set<string>;
  tracedEventIds: Set<string>;
  tracedReasoningIds: Set<string>;
  generationSpansByMessageId: Map<string, ApiSpan>;
  activeGenerationStepsByMessageId: Map<string, ActiveGenerationStep>;
  toolMessageIdsByCallId: Map<string, string>;
  assistantParts: Map<string, Map<string, MessagePart>>;
  turnObservationsByMessageId: Map<string, TurnObservation>;
  latestTurnObservationsBySession: Map<string, TurnObservation>;
  activeToolObservations: Map<string, ToolObservation>;
  finalizedToolCallIds: Set<string>;
  activeGenerationSteps: Map<string, ActiveGenerationStep>;
  generationParentSpans: Map<string, ApiSpan>;
  generationInputsBySession: Map<string, ChatMlMessage[]>;
  toolResultSourceMessageIdsBySession: Map<string, string>;
  sessionParentIds: Map<string, string>;
};

export type MessagePart = Extract<
  Parameters<NonNullable<Hooks["event"]>>[0]["event"],
  { type: "message.part.updated" }
>["properties"]["part"];

function getCompletedReasoningTimestamp(part: MessagePart) {
  if (!("time" in part) || !part.time || typeof part.time !== "object") {
    return undefined;
  }

  if ("completed" in part.time && typeof part.time.completed === "number") {
    return part.time.completed;
  }

  if ("end" in part.time && typeof part.time.end === "number") {
    return part.time.end;
  }

  return undefined;
}

export type FormattedMessagePart =
  | { type: string; text: string }
  | { type: string; filename?: string; url?: string }
  | { type: string; name?: string }
  | { type: string; prompt?: string; agent?: string }
  | { type: string; tool?: string; title?: string }
  | { type: string };

export type SessionError = Extract<
  Parameters<NonNullable<Hooks["event"]>>[0]["event"],
  { type: "session.error" }
>["properties"]["error"];

export type SessionErrorInfo = NonNullable<SessionError>;

export type UserMessageInput = {
  role: "user";
  content: FormattedMessagePart[];
  tools?: ToolDefinition[];
};

export type ToolDefinition = {
  name: string;
  description?: string;
  parameters?: object;
};

type ChatMlMessage =
  | UserMessageInput
  | {
      role: "tool";
      name: string;
      tool_call_id: string;
      content: string;
    }
  | NonNullable<ReturnType<LangfuseClient["getAssistantMessage"]>>[number];

export type TurnObservation = {
  span: ApiSpan;
  sessionID: string;
  messageID?: string;
};

export type ToolObservation = {
  span: ApiSpan;
  sessionID: string;
  tool: string;
};

export type ActiveGenerationStep = {
  sessionID: string;
  messageID?: string;
  agent?: string;
  model?: {
    id: string;
    providerID: string;
    variant?: string;
  };
  span: ApiSpan;
  snapshot?: string;
};

export class LangfuseClientService extends EffectContext.Tag(
  "LangfuseClientService",
)<LangfuseClientService, LangfuseClient>() {}

const makeUserIdSpanProcessor = (userId: string) =>
  ({
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Existing violation tracked for incremental cleanup.
    onStart: (span: Span, _parentContext: unknown) => {
      span.setAttribute("langfuse.user.id", userId);
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function -- Existing violation tracked for incremental cleanup.
    onEnd: (_span: ReadableSpan) => {},
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  }) satisfies SpanProcessor;

const makePluginVersionSpanProcessor = () =>
  ({
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Existing violation tracked for incremental cleanup.
    onStart: (span: Span, _parentContext: unknown) => {
      span.setAttribute("langfuse.plugin.version", PLUGIN_VERSION);
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function -- Existing violation tracked for incremental cleanup.
    onEnd: (_span: ReadableSpan) => {},
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  }) satisfies SpanProcessor;

// Langfuse's OTEL processor may auto-mark exported spans as app roots, this overrides that.
const makeAppRootSpanProcessor = (tracerName: string) =>
  ({
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Existing violation tracked for incremental cleanup.
    onStart: (span: Span, _parentContext: unknown) => {
      if (span.instrumentationScope.name !== tracerName) {
        return;
      }

      span.setAttribute(
        "langfuse.internal.is_app_root",
        span.name === "opencode.turn",
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function -- Existing violation tracked for incremental cleanup.
    onEnd: (_span: ReadableSpan) => {},
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  }) satisfies SpanProcessor;

export const createLangfuseClient = (input: {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment: string;
  userId?: string;
  serviceName?: string;
}) =>
  Effect.gen(function* () {
    const tracerName = "opencode-langfuse-plugin";
    const traceState: LangfuseTraceState = {
      tracerName,
      tracer: trace.getTracer(tracerName, PLUGIN_VERSION),
      abortedSessions: new Set<string>(),
      tracedMessageIds: new Set<string>(),
      tracedGenerationIds: new Set<string>(),
      tracedEventIds: new Set<string>(),
      tracedReasoningIds: new Set<string>(),
      generationSpansByMessageId: new Map<string, ApiSpan>(),
      activeGenerationStepsByMessageId: new Map<string, ActiveGenerationStep>(),
      toolMessageIdsByCallId: new Map<string, string>(),
      assistantParts: new Map<string, Map<string, MessagePart>>(),
      turnObservationsByMessageId: new Map<string, TurnObservation>(),
      latestTurnObservationsBySession: new Map<string, TurnObservation>(),
      activeToolObservations: new Map<string, ToolObservation>(),
      finalizedToolCallIds: new Set<string>(),
      activeGenerationSteps: new Map<string, ActiveGenerationStep>(),
      generationParentSpans: new Map<string, ApiSpan>(),
      generationInputsBySession: new Map<string, ChatMlMessage[]>(),
      toolResultSourceMessageIdsBySession: new Map<string, string>(),
      sessionParentIds: new Map<string, string>(),
    };

    const processor = new LangfuseSpanProcessor({
      publicKey: input.publicKey,
      secretKey: input.secretKey,
      baseUrl: input.baseUrl,
      environment: input.environment,
      shouldExportSpan: ({ otelSpan }) =>
        otelSpan.instrumentationScope.name === traceState.tracerName,
    });

    const provider = new NodeTracerProvider({
      // Honor OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES, which a bare
      // NodeTracerProvider does not read on its own. Merged-in attributes win,
      // so a configured serviceName overrides the environment.
      resource: defaultResource()
        .merge(detectResources({ detectors: [envDetector] }))
        .merge(
          input.serviceName
            ? resourceFromAttributes({ "service.name": input.serviceName })
            : null,
        ),
      spanProcessors: [
        makePluginVersionSpanProcessor(),
        ...(input.userId ? [makeUserIdSpanProcessor(input.userId)] : []),
        processor,
        makeAppRootSpanProcessor(traceState.tracerName),
      ],
    });
    let isShutdown = false;

    yield* Effect.sync(() => {
      provider.register();
    });

    return new LangfuseClient({
      baseUrl: input.baseUrl,
      traceState,
      forceFlush: Effect.tryPromise(() =>
        isShutdown ? Promise.resolve() : processor.forceFlush(),
      ),
      shutdown: Effect.gen(function* () {
        if (isShutdown) {
          return;
        }

        isShutdown = true;
        yield* Effect.tryPromise(() => processor.forceFlush()).pipe(
          Effect.catchAll(() => Effect.void),
        );
        yield* Effect.tryPromise(() => provider.shutdown());
      }),
    });
  });
