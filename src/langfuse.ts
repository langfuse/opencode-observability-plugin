import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { Hooks } from "@opencode-ai/plugin";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import type { Span as ApiSpan, Tracer } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
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
    this.traceState.pendingReasoningPartsByMessageId.clear();
    this.traceState.generationSpansByMessageId.clear();
    this.traceState.activeGenerationStepsByMessageId.clear();
    this.traceState.toolMessageIdsByCallId.clear();
    this.traceState.generationParentSpans.clear();
    this.traceState.turnObservationsByMessageId.clear();
    this.traceState.latestTurnObservationsBySession.clear();
    this.traceState.finalizedToolCallIds.clear();
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

  endActiveTurnObservations() {
    for (const observation of new Set(
      this.traceState.latestTurnObservationsBySession.values(),
    )) {
      observation.span.end();
    }

    this.traceState.turnObservationsByMessageId.clear();
    this.traceState.latestTurnObservationsBySession.clear();
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

  traceReasoning(input: {
    reasoningID: string;
    sessionID: string;
    timestamp: number;
    text: string;
    messageID?: string;
    source: string;
    parentSpan?: ApiSpan;
  }) {
    if (!input.text.trim()) {
      return;
    }

    const reasoningTraceKey = `${input.sessionID}:${input.reasoningID}`;

    if (this.traceState.tracedReasoningIds.has(reasoningTraceKey)) {
      return;
    }

    this.traceState.tracedReasoningIds.add(reasoningTraceKey);

    const parentSpan =
      input.parentSpan ??
      (input.messageID
        ? this.traceState.generationSpansByMessageId.get(input.messageID)
        : undefined);

    const generationParentSpan =
      parentSpan ??
      this.traceState.activeGenerationSteps.get(input.sessionID)?.span ??
      this.traceState.generationParentSpans.get(input.sessionID);

    this.traceEvent({
      id: `reasoning:${reasoningTraceKey}`,
      sessionID: input.sessionID,
      name: "opencode.generation.reasoning",
      timestamp: input.timestamp,
      output: { text: input.text },
      metadata: {
        reasoningID: input.reasoningID,
        messageID: input.messageID,
        source: input.source,
      },
      parentSpan: generationParentSpan,
    });
  }

  traceReasoningPart(part: MessagePart) {
    const completed = getCompletedReasoningTimestamp(part);

    if (!isCompletedReasoningPart(part) || completed === undefined) {
      return;
    }

    const generationSpan =
      this.traceState.generationSpansByMessageId.get(part.messageID) ??
      this.traceState.activeGenerationSteps.get(part.sessionID)?.span ??
      this.traceState.generationParentSpans.get(part.sessionID);

    if (!generationSpan) {
      const pending =
        this.traceState.pendingReasoningPartsByMessageId.get(part.messageID) ??
        new Map<string, CompletedReasoningPart>();
      pending.set(part.id, part);
      this.traceState.pendingReasoningPartsByMessageId.set(
        part.messageID,
        pending,
      );
      return;
    }

    this.traceReasoning({
      reasoningID: part.id,
      sessionID: part.sessionID,
      timestamp: completed,
      text: part.text,
      messageID: part.messageID,
      source: "message.part.updated",
      parentSpan: generationSpan,
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
        started: input.started,
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
          providerID: updatedStep.model?.providerID,
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
        started: input.started,
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

    this.withTurnParent(input.sessionID, undefined, () => {
      const span = this.traceState.tracer.startSpan("opencode.generation", {
        attributes: {
          "langfuse.observation.type": "generation",
          "session.id": input.sessionID,
          "langfuse.observation.model.name": input.model.id,
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
        started: input.started,
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
  }) {
    if (
      input.messageID &&
      this.traceState.tracedMessageIds.has(input.messageID)
    ) {
      return;
    }

    this.traceState.abortedSessions.delete(input.sessionID);

    const formattedInput = {
      role: "user" as const,
      parts: input.parts.map((part) => {
        if (part.type === "text") {
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

    const span = this.traceState.tracer.startSpan("opencode.turn", {
      attributes: {
        "langfuse.observation.type": "span",
        "langfuse.internal.is_app_root": true,
        "session.id": input.sessionID,
        "langfuse.observation.input": JSON.stringify(formattedInput),
        "langfuse.observation.metadata": JSON.stringify({
          messageID: input.messageID,
          agent: input.agent,
          providerID: input.model?.providerID,
          modelID: input.model?.modelID,
        }),
      },
    });

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
      const event = this.traceState.tracer.startSpan("opencode.message.user", {
        attributes: {
          "langfuse.observation.type": "event",
          "session.id": input.sessionID,
          "langfuse.observation.input": JSON.stringify(formattedInput),
          "langfuse.observation.metadata": JSON.stringify({
            messageID: input.messageID,
            agent: input.agent,
            providerID: input.model?.providerID,
            modelID: input.model?.modelID,
          }),
        },
      });

      event.end();
    });
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
      this.rememberToolCall({
        callID: part.callID,
        messageID: part.messageID,
      });
    }
  }

  rememberToolCall(input: { callID: string; messageID: string }) {
    this.traceState.toolMessageIdsByCallId.set(input.callID, input.messageID);
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

    const text = this.getAssistantText(input.messageID);
    const output = text ? { text } : undefined;
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
      this.flushPendingReasoning(input.messageID, step.span);

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

    this.withTurnParent(input.sessionID, input.parentID, () => {
      const span = this.traceState.tracer.startSpan("opencode.generation", {
        attributes: {
          "langfuse.observation.type": "generation",
          "session.id": input.sessionID,
          "langfuse.observation.model.name": input.modelID,
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
      this.flushPendingReasoning(input.messageID, span);
      span.end(new Date(input.completed));
    });
  }

  private flushPendingReasoning(messageID: string, parentSpan: ApiSpan) {
    const pending =
      this.traceState.pendingReasoningPartsByMessageId.get(messageID) ??
      new Map<string, CompletedReasoningPart>();
    this.traceState.pendingReasoningPartsByMessageId.delete(messageID);

    for (const part of pending.values()) {
      const completed = getCompletedReasoningTimestamp(part);

      if (completed === undefined) {
        continue;
      }

      this.traceReasoning({
        reasoningID: part.id,
        sessionID: part.sessionID,
        timestamp: completed,
        text: part.text,
        messageID: part.messageID,
        source: "message.part.updated",
        parentSpan,
      });
    }
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
  }) {
    this.traceState.activeToolObservations.get(input.callID)?.span.end();
    this.traceState.finalizedToolCallIds.delete(input.callID);
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
        });

        this.traceState.activeToolObservations.set(input.callID, {
          span,
          sessionID: input.sessionID,
          tool: input.tool,
        });
      },
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

    span.end();
    this.traceState.activeToolObservations.delete(input.callID);
    this.traceState.finalizedToolCallIds.add(input.callID);
    this.traceState.toolMessageIdsByCallId.delete(input.callID);
  }

  traceToolError(input: { callID: string; error: string; completed: number }) {
    if (this.traceState.finalizedToolCallIds.has(input.callID)) {
      return;
    }

    const span = this.traceState.activeToolObservations.get(input.callID)?.span;

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
      const span = this.traceState.tracer.startSpan("opencode.generation", {
        attributes: {
          "langfuse.observation.type": "generation",
          "session.id": sessionID,
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

  private getAssistantText(messageID: string) {
    return Array.from(
      this.traceState.assistantParts.get(messageID)?.values() ?? [],
    )
      .filter(
        (part): part is Extract<MessagePart, { type: "text" }> =>
          part.type === "text" && Boolean(part.text),
      )
      .map((part) => part.text)
      .join("");
  }

  private getSessionErrorMessage(error: SessionErrorInfo) {
    if ("message" in error && typeof error.message === "string") {
      return error.message;
    }

    if (
      "data" in error &&
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
  pendingReasoningPartsByMessageId: Map<
    string,
    Map<string, CompletedReasoningPart>
  >;
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
};

export type MessagePart = Extract<
  Parameters<NonNullable<Hooks["event"]>>[0]["event"],
  { type: "message.part.updated" }
>["properties"]["part"];

type CompletedReasoningPart = MessagePart & {
  id: string;
  sessionID: string;
  text: string;
  messageID: string;
  time: { completed?: number; end?: number };
};

function isCompletedReasoningPart(
  part: MessagePart,
): part is CompletedReasoningPart {
  return (
    part.type === "reasoning" &&
    typeof part.id === "string" &&
    typeof part.sessionID === "string" &&
    typeof part.messageID === "string" &&
    typeof part.text === "string" &&
    typeof getCompletedReasoningTimestamp(part) === "number"
  );
}

function getCompletedReasoningTimestamp(part: MessagePart) {
  const time = (part as { time?: { completed?: unknown; end?: unknown } }).time;

  if (typeof time?.completed === "number") {
    return time.completed;
  }

  if (typeof time?.end === "number") {
    return time.end;
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
  parts: FormattedMessagePart[];
};

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
  started?: number;
  snapshot?: string;
};

export class LangfuseClientService extends EffectContext.Tag(
  "LangfuseClientService",
)<LangfuseClientService, LangfuseClient>() {}

const makeUserIdSpanProcessor = (userId: string) =>
  ({
    onStart: (span: Span, _parentContext: unknown) => {
      span.setAttribute("langfuse.user.id", userId);
    },
    onEnd: (_span: ReadableSpan) => {},
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  }) satisfies SpanProcessor;

const makePluginVersionSpanProcessor = () =>
  ({
    onStart: (span: Span, _parentContext: unknown) => {
      span.setAttribute("langfuse.plugin.version", PLUGIN_VERSION);
    },
    onEnd: (_span: ReadableSpan) => {},
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  }) satisfies SpanProcessor;

// Langfuse's OTEL processor may auto-mark exported spans as app roots, this overrides that.
const makeAppRootSpanProcessor = (tracerName: string) =>
  ({
    onStart: (span: Span, _parentContext: unknown) => {
      if (span.instrumentationScope.name !== tracerName) {
        return;
      }

      span.setAttribute(
        "langfuse.internal.is_app_root",
        span.name === "opencode.turn",
      );
    },
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
      pendingReasoningPartsByMessageId: new Map<
        string,
        Map<string, CompletedReasoningPart>
      >(),
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
      spanProcessors: [
        makePluginVersionSpanProcessor(),
        ...(input.userId ? [makeUserIdSpanProcessor(input.userId)] : []),
        processor,
        makeAppRootSpanProcessor(traceState.tracerName),
      ],
    });
    let isShutdown = false;

    yield* Effect.sync(() => provider.register());

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
