import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { Hooks } from "@opencode-ai/plugin";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import type { Span as ApiSpan, Tracer } from "@opentelemetry/api";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
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
  private readonly traceState: LangfuseTraceState;
  private readonly assistantParents = new Map<
    string,
    { sessionID: string; parentID: string }
  >();

  constructor(input: {
    baseUrl: string;
    traceState: LangfuseTraceState;
    forceFlush: Effect.Effect<void, unknown>;
  }) {
    this.baseUrl = input.baseUrl;
    this.traceState = input.traceState;
    this.forceFlush = input.forceFlush;
  }

  clearTraceState() {
    this.assistantParents.clear();
    this.traceState.assistantParts.clear();
    this.traceState.abortedSessions.clear();
    this.traceState.tracedEventIds.clear();
    this.traceState.tracedReasoningIds.clear();
    this.traceState.generationSpansByMessageId.clear();
    this.traceState.activeGenerationStepsByMessageId.clear();
    this.traceState.toolMessageIdsByCallId.clear();
    this.traceState.generationParentSpans.clear();
    this.traceState.generationInputsBySession.clear();
    this.traceState.generationInputSnapshotsBySession.clear();
    this.traceState.turnObservationsByMessageId.clear();
    this.traceState.latestTurnObservationsBySession.clear();
    this.traceState.finalizedToolCallIds.clear();
    this.traceState.sessionParentIds.clear();
    this.traceState.sessionHistories.clear();
    this.traceState.pendingUserMessageIdsBySession.clear();
  }

  clearSessionTraceState(sessionID: string) {
    for (const [messageID, parent] of this.assistantParents) {
      if (parent.sessionID === sessionID) {
        this.assistantParents.delete(messageID);
      }
    }
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
    this.traceState.generationInputSnapshotsBySession.delete(sessionID);
    this.traceState.latestTurnObservationsBySession.delete(sessionID);
    this.traceState.sessionHistories.delete(sessionID);
    this.traceState.pendingUserMessageIdsBySession.delete(sessionID);
  }

  endActiveToolObservations(sessionID?: string, error?: SessionErrorInfo) {
    for (const [callID, observation] of this.traceState
      .activeToolObservations) {
      if (sessionID != null && observation.sessionID !== sessionID) {
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
      if (sessionID != null && step.sessionID !== sessionID) {
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
      if (sessionID == null || step.sessionID === sessionID) {
        this.traceState.activeGenerationSteps.delete(activeSessionID);
        this.traceState.generationParentSpans.delete(activeSessionID);
      }
    }

    for (const [messageID, step] of this.traceState
      .activeGenerationStepsByMessageId) {
      if (sessionID == null || step.sessionID === sessionID) {
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
      if (sessionID != null && observation.sessionID !== sessionID) {
        continue;
      }

      observation.span.end();
    }

    for (const [messageID, observation] of this.traceState
      .turnObservationsByMessageId) {
      if (sessionID == null || observation.sessionID === sessionID) {
        this.traceState.turnObservationsByMessageId.delete(messageID);
      }
    }

    for (const [activeSessionID, observation] of this.traceState
      .latestTurnObservationsBySession) {
      if (sessionID == null || observation.sessionID === sessionID) {
        this.traceState.latestTurnObservationsBySession.delete(activeSessionID);
      }
    }
  }

  rememberSessionParent(input: {
    sessionID: string;
    parentSessionID?: string;
  }) {
    if (input.parentSessionID != null) {
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

    if (input.messageID == null) {
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
    const existingMessageStep =
      messageID != null
        ? this.traceState.activeGenerationStepsByMessageId.get(messageID)
        : undefined;
    const existingStep = this.traceState.activeGenerationSteps.get(
      input.sessionID,
    );

    if (
      messageID != null &&
      !existingMessageStep &&
      this.traceState.generationSpansByMessageId.has(messageID)
    ) {
      return;
    }

    if (existingMessageStep && messageID != null) {
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
          providerID: updatedStep.model.providerID,
          variant: updatedStep.model.variant,
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

    if (existingStep && existingStep.messageID == null && messageID != null) {
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

    if (messageID == null && existingStep) {
      return;
    }

    if (!this.getTurnObservation(input.sessionID, undefined)) {
      return;
    }

    const generationInput = this.consumeGenerationInput(
      input.sessionID,
      input.assistantMessageID,
    );

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
      if (messageID != null) {
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
    this.traceFormattedUserMessage({
      ...input,
      content: input.parts.map(formatUserMessagePart),
    });
  }

  traceUserPrompt(input: {
    sessionID: string;
    messageID?: string;
    content: FormattedMessagePart[];
    tools?: ToolDefinition[];
  }) {
    this.traceFormattedUserMessage(input);
  }

  setPendingToolDefinitions(sessionID: string, tools: ToolDefinition[]) {
    const messages = this.traceState.generationInputsBySession.get(sessionID);
    if (!messages || tools.length === 0) {
      return;
    }

    this.traceState.generationInputsBySession.set(
      sessionID,
      withToolDefinitions(messages, tools),
    );
  }

  setGenerationInputSnapshot(sessionID: string, input: unknown) {
    this.traceState.generationInputSnapshotsBySession.set(sessionID, input);
  }

  private traceFormattedUserMessage(input: {
    sessionID: string;
    messageID?: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
    content: FormattedMessagePart[];
    tools?: ToolDefinition[];
  }) {
    if (
      input.messageID != null &&
      this.traceState.tracedMessageIds.has(input.messageID)
    ) {
      return;
    }

    this.traceState.abortedSessions.delete(input.sessionID);

    const formattedMessage = { role: "user" as const, content: input.content };
    const generationInput = [
      {
        ...formattedMessage,
        ...((input.tools?.length ?? 0) > 0 ? { tools: input.tools } : {}),
      },
    ];

    this.traceState.generationInputsBySession.set(
      input.sessionID,
      generationInput,
    );

    if (input.messageID != null) {
      this.traceState.tracedMessageIds.add(input.messageID);
      this.traceState.pendingUserMessageIdsBySession.set(
        input.sessionID,
        input.messageID,
      );
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

      if (input.messageID != null) {
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

    if (parentSpan) {
      context.with(trace.setSpan(context.active(), parentSpan), startTurn);
    } else {
      startTurn();
    }
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
    output?: unknown;
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
    this.assistantParents.set(input.messageID, {
      sessionID: input.sessionID,
      parentID: input.parentID,
    });

    const output = input.output ?? this.getAssistantMessage(input.messageID);
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
      (activeStep?.messageID === input.messageID ||
      activeStep?.messageID == null
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

    const generationInput = this.consumeGenerationInput(
      input.sessionID,
      input.messageID,
    );

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
    const step =
      input.assistantMessageID != null
        ? (this.traceState.activeGenerationStepsByMessageId.get(
            input.assistantMessageID,
          ) ??
          (activeStep?.messageID === input.assistantMessageID ||
          activeStep?.messageID == null
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
      if (messageID != null) {
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

    if (turn.messageID != null) {
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
      JSON.stringify({
        role: "tool",
        name: input.tool,
        tool_call_id: input.callID,
        content: input.output,
      } satisfies ChatMlMessage),
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
      input.sessionID != null &&
      input.tool != null
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
      JSON.stringify({
        role: "tool",
        name: input.tool ?? observation.tool,
        tool_call_id: input.callID,
        content: input.error,
      } satisfies ChatMlMessage),
    );
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: input.error,
    });
    span.recordException({ message: input.error });
    span.end(new Date(input.completed));
    this.rememberToolResult({
      sessionID: observation.sessionID,
      callID: input.callID,
      tool: input.tool ?? observation.tool,
      content: input.error,
      messageID: input.messageID,
    });
    this.traceState.activeToolObservations.delete(input.callID);
    this.traceState.finalizedToolCallIds.add(input.callID);
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
      (messageID != null
        ? this.traceState.turnObservationsByMessageId.get(messageID)
        : undefined) ??
      this.traceState.latestTurnObservationsBySession.get(sessionID)
    );
  }

  private getSessionParentSpan(sessionID: string) {
    const parentSessionID = this.traceState.sessionParentIds.get(sessionID);

    if (parentSessionID == null) {
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
      (messageID != null
        ? this.traceState.generationSpansByMessageId.get(messageID)
        : undefined) ??
      this.traceState.activeGenerationSteps.get(sessionID)?.span ??
      this.traceState.generationParentSpans.get(sessionID);

    return parentSpan
      ? context.with(trace.setSpan(context.active(), parentSpan), fn)
      : fn();
  }

  private getAssistantMessage(messageID: string) {
    return buildAssistantMessage(
      Array.from(this.traceState.assistantParts.get(messageID)?.values() ?? []),
    );
  }

  setSessionHistory(sessionID: string, history: SessionHistory) {
    this.traceState.sessionHistories.set(sessionID, history);
  }

  hasSessionHistory(sessionID: string) {
    return this.traceState.sessionHistories.has(sessionID);
  }

  private getHistoryPrefix(sessionID: string, assistantMessageID?: string) {
    const history = this.traceState.sessionHistories.get(sessionID);

    if (!history) {
      return [];
    }

    if (assistantMessageID == null) {
      return history.messages;
    }

    const startIndex =
      history.assistantMessages.get(assistantMessageID)?.startIndex;

    return startIndex == null
      ? history.messages
      : history.messages.slice(0, startIndex);
  }

  // True only when the snapshot provably holds that message. A failed refresh
  // leaves the previous snapshot in place, and that one predates the request.
  private snapshotHolds(sessionID: string, messageID: string | undefined) {
    if (messageID == null) {
      return false;
    }

    return (
      this.traceState.sessionHistories
        .get(sessionID)
        ?.messageIds.has(messageID) === true
    );
  }

  private consumeGenerationInput(
    sessionID: string,
    assistantMessageID?: string,
  ) {
    const snapshot =
      this.traceState.generationInputSnapshotsBySession.get(sessionID);
    this.traceState.generationInputSnapshotsBySession.delete(sessionID);
    const pending = this.traceState.generationInputsBySession.get(sessionID);
    this.traceState.generationInputsBySession.delete(sessionID);
    const sourceMessageIds = new Set<string>();
    for (const message of pending ?? []) {
      if (message.role !== "tool") {
        continue;
      }
      const messageID = this.traceState.toolMessageIdsByCallId.get(
        message.tool_call_id,
      );
      if (messageID != null) {
        sourceMessageIds.add(messageID);
      }
      this.traceState.toolMessageIdsByCallId.delete(message.tool_call_id);
    }
    if (snapshot !== undefined) {
      return snapshot;
    }

    const pendingUserMessageID =
      this.traceState.pendingUserMessageIdsBySession.get(sessionID);

    const unplacedToolCallIds = new Set<string>();
    const prefix = (() => {
      const storedPrefix = this.getHistoryPrefix(sessionID, assistantMessageID);
      if (sourceMessageIds.size === 0) {
        return storedPrefix;
      }

      const history = this.traceState.sessionHistories.get(sessionID);
      const rebuiltMessages = new Map<string, ChatMlMessage[]>();
      // Live message order is independent of the order tools finish in.
      const orderedSourceMessageIds = new Set([
        ...Array.from(this.traceState.assistantParts.keys()).filter(
          (messageID) => sourceMessageIds.has(messageID),
        ),
        ...sourceMessageIds,
      ]);
      for (const sourceMessageID of orderedSourceMessageIds) {
        const source = history?.assistantMessages.get(sourceMessageID);
        const liveParts = Array.from(
          this.traceState.assistantParts.get(sourceMessageID)?.values() ?? [],
        );
        const parts = [...(source?.parts ?? [])];
        let previousIndex: number | undefined;

        // Tool hooks and message events use different part IDs for the same call.
        // Step markers anchor live deltas without collapsing sequential calls
        // into one assistant message or losing snapshot-only parts after a restart.
        const partKey = (part: MessagePart) =>
          part.type === "tool" ? `tool:${part.callID}` : part.id;
        for (const [liveIndex, part] of liveParts.entries()) {
          const storedIndex = parts.findIndex(
            (stored) => partKey(stored) === partKey(part),
          );
          if (storedIndex >= 0) {
            const stored = parts[storedIndex];
            previousIndex = storedIndex;
            if (
              stored.type === "tool" &&
              part.type === "tool" &&
              (stored.state.status === "completed" ||
                stored.state.status === "error") &&
              (part.state.status === "pending" ||
                part.state.status === "running")
            ) {
              continue;
            }
            if (
              (stored.type === "text" || stored.type === "reasoning") &&
              (part.type === "text" || part.type === "reasoning") &&
              stored.text.startsWith(part.text)
            ) {
              continue;
            }
            parts[storedIndex] = part;
            continue;
          }

          const insertionIndex = (() => {
            if (previousIndex !== undefined) {
              if (part.type === "step-start") {
                // Snapshot-only parts still belong to the preceding step.
                const searchStartIndex = previousIndex + 1;
                const nextStepIndex = parts.findIndex(
                  (stored, index) =>
                    index >= searchStartIndex && stored.type === "step-start",
                );
                return nextStepIndex < 0 ? parts.length : nextStepIndex;
              }
              return previousIndex + 1;
            }
            const nextKeys = new Set(
              liveParts.slice(liveIndex + 1).map(partKey),
            );
            const nextStoredIndex = parts.findIndex((stored) =>
              nextKeys.has(partKey(stored)),
            );
            if (nextStoredIndex >= 0) {
              return nextStoredIndex;
            }
            return parts.length;
          })();
          parts.splice(insertionIndex, 0, part);
          previousIndex = insertionIndex;
        }

        const rebuilt = buildSessionHistory([
          { info: { id: sourceMessageID, role: "assistant" }, parts },
        ]).messages;
        rebuiltMessages.set(sourceMessageID, rebuilt);
      }

      const replacements: (Pick<
        NonNullable<ReturnType<SessionHistory["assistantMessages"]["get"]>>,
        "startIndex" | "endIndex"
      > & { messages: ChatMlMessage[] })[] = [];
      for (const [messageID, source] of history?.assistantMessages ?? []) {
        const rebuilt = rebuiltMessages.get(messageID);
        if (!rebuilt || source.endIndex > storedPrefix.length) {
          continue;
        }
        replacements.push({ ...source, messages: rebuilt });
        rebuiltMessages.delete(messageID);
      }
      for (const [messageID, rebuilt] of rebuiltMessages) {
        const parentID = this.assistantParents.get(messageID)?.parentID;
        const parentIndex =
          parentID == null ? undefined : history?.userMessages.get(parentID);
        const userCount = storedPrefix.filter(
          (message) => message.role === "user",
        ).length;
        if (parentIndex === undefined && userCount > 1) {
          // Without a parent anchor, assigning this group to a turn would be a guess.
          for (const message of rebuilt) {
            if (message.role === "assistant") {
              for (const call of message.tool_calls ?? []) {
                unplacedToolCallIds.add(call.id);
              }
            }
          }
          continue;
        }
        const nextUserIndex =
          parentIndex === undefined
            ? -1
            : storedPrefix.findIndex(
                (message, index) =>
                  index > parentIndex && message.role === "user",
              );
        const insertionIndex =
          nextUserIndex < 0 ? storedPrefix.length : nextUserIndex;
        replacements.push({
          startIndex: insertionIndex,
          endIndex: insertionIndex,
          messages: rebuilt,
        });
      }
      const merged: ChatMlMessage[] = [];
      let cursor = 0;
      for (const replacement of replacements.sort(
        (a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex,
      )) {
        merged.push(
          ...storedPrefix.slice(cursor, replacement.startIndex),
          ...replacement.messages,
        );
        cursor = replacement.endIndex;
      }
      merged.push(...storedPrefix.slice(cursor));
      return merged;
    })();

    if (prefix.length === 0 && pending === undefined) {
      return undefined;
    }

    // Taking the user message from both sources would list it twice, so it
    // comes from the live buffer only when the snapshot does not hold it -
    // after a failed refresh, or when the store had not caught up yet. The
    // buffer's copy already carries this request's tool definitions.
    const pendingUserMessages = this.snapshotHolds(
      sessionID,
      pendingUserMessageID,
    )
      ? []
      : (pending ?? []).filter((message) => message.role === "user");
    const existingToolResultIds = new Set(
      prefix
        .filter((message) => message.role === "tool")
        .map((message) => message.tool_call_id),
    );
    const combined = [...prefix];
    for (const message of pending ?? []) {
      if (
        message.role !== "tool" ||
        unplacedToolCallIds.has(message.tool_call_id) ||
        existingToolResultIds.has(message.tool_call_id)
      ) {
        continue;
      }
      existingToolResultIds.add(message.tool_call_id);
      const assistantIndex = combined.findIndex(
        (assistant) =>
          assistant.role === "assistant" &&
          assistant.tool_calls?.some(
            (call) => call.id === message.tool_call_id,
          ) === true,
      );
      if (assistantIndex < 0) {
        combined.push(message);
        continue;
      }
      let resultIndex = assistantIndex + 1;
      while (combined[resultIndex]?.role === "tool") {
        resultIndex++;
      }
      combined.splice(resultIndex, 0, message);
    }
    combined.push(...pendingUserMessages);

    if (pendingUserMessages.length > 0) {
      return combined;
    }

    // Tool definitions describe this request, not the stored conversation, so
    // they ride on its newest user message.
    const tools = pending?.find(
      (message): message is Extract<ChatMlMessage, { role: "user" }> =>
        message.role === "user" && "tools" in message,
    )?.tools;

    return tools === undefined
      ? combined
      : withToolDefinitions(combined, tools);
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

    if (messageID != null) {
      this.traceState.toolMessageIdsByCallId.set(input.callID, messageID);
    }
  }

  private getSessionErrorMessage(error: SessionErrorInfo) {
    if ("message" in error && typeof error.message === "string") {
      return error.message;
    }

    if (
      "data" in error &&
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
  generationInputSnapshotsBySession: Map<string, unknown>;
  sessionParentIds: Map<string, string>;
  sessionHistories: Map<string, SessionHistory>;
  pendingUserMessageIdsBySession: Map<string, string>;
};

export type MessagePart = Extract<
  Parameters<NonNullable<Hooks["event"]>>[0]["event"],
  { type: "message.part.updated" }
>["properties"]["part"];

export type SessionHistory = {
  messages: ChatMlMessage[];
  userMessages: Map<string, number>;
  assistantMessages: Map<
    string,
    { startIndex: number; endIndex: number; parts: MessagePart[] }
  >;
  // Which messages the snapshot actually holds. A stale snapshot - the last
  // refresh failed, or it ran before the message existed - does not contain
  // the request that triggered the generation, and the live buffer has to
  // supply it.
  messageIds: Set<string>;
};

function splitAssistantSteps(parts: MessagePart[]) {
  const steps: MessagePart[][] = [];
  let current: MessagePart[] = [];

  for (const part of parts) {
    if (part.type === "step-start" && current.length > 0) {
      steps.push(current);
      current = [];
      continue;
    }

    if (part.type !== "step-start") {
      current.push(part);
    }
  }

  if (current.length > 0) {
    steps.push(current);
  }

  return steps;
}

function toolResultContent(
  state: Extract<MessagePart, { type: "tool" }>["state"],
) {
  if ("output" in state) {
    return state.output;
  }

  return "error" in state ? state.error : "";
}

function toolResultsOfStep(parts: MessagePart[]): ChatMlMessage[] {
  return parts
    .filter(
      (part): part is Extract<MessagePart, { type: "tool" }> =>
        part.type === "tool" &&
        (part.state.status === "completed" || part.state.status === "error"),
    )
    .map((part) => ({
      role: "tool" as const,
      name: part.tool,
      tool_call_id: part.callID,
      content: toolResultContent(part.state),
    }));
}

export function buildSessionHistory(
  messages: readonly {
    info: { id: string; role: string };
    parts: MessagePart[];
  }[],
): SessionHistory {
  const history: ChatMlMessage[] = [];
  const assistantMessages: SessionHistory["assistantMessages"] = new Map();
  const userMessages: SessionHistory["userMessages"] = new Map();
  const messageIds = new Set<string>();

  for (const message of messages) {
    messageIds.add(message.info.id);

    if (message.info.role === "user") {
      userMessages.set(message.info.id, history.length);
      history.push(formatUserMessage(message.parts));
      continue;
    }

    const startIndex = history.length;

    for (const step of splitAssistantSteps(message.parts)) {
      const assistant = buildAssistantMessage(step);

      if (assistant) {
        history.push(...assistant);
      }

      history.push(...toolResultsOfStep(step));
    }
    assistantMessages.set(message.info.id, {
      startIndex,
      endIndex: history.length,
      parts: message.parts,
    });
  }

  return { messages: history, assistantMessages, userMessages, messageIds };
}

function withToolDefinitions(
  messages: ChatMlMessage[],
  tools: ToolDefinition[],
): ChatMlMessage[] {
  const newestUserIndex = messages.reduce(
    (found, message, index) => (message.role === "user" ? index : found),
    -1,
  );

  if (newestUserIndex < 0) {
    return messages;
  }

  return messages.map((message, index) =>
    index === newestUserIndex ? { ...message, tools } : message,
  );
}

function formatUserMessagePart(part: MessagePart): FormattedMessagePart {
  if (part.type === "text") {
    return { type: part.type, text: part.text };
  }

  if (part.type === "file") {
    return { type: part.type, filename: part.filename, url: part.url };
  }

  if (part.type === "agent") {
    return { type: part.type, name: part.name };
  }

  if (part.type === "subtask") {
    return { type: part.type, prompt: part.prompt, agent: part.agent };
  }

  if (part.type === "tool") {
    return {
      type: part.type,
      tool: part.tool,
      title: "title" in part.state ? part.state.title : undefined,
    };
  }

  return { type: part.type };
}

function formatUserMessage(parts: MessagePart[]) {
  return { role: "user" as const, content: parts.map(formatUserMessagePart) };
}

function buildAssistantMessage(parts: MessagePart[]) {
  const content = parts
    .filter(
      (part): part is Extract<MessagePart, { type: "text" }> =>
        part.type === "text" && part.text !== "",
    )
    .map((part) => part.text)
    .join("");
  const thinking = parts
    .filter(
      (part): part is Extract<MessagePart, { type: "reasoning" }> =>
        part.type === "reasoning" && part.text !== "",
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

type FormattedMessagePart =
  | { type: string; text: string }
  | { type: string; filename?: string; url?: string }
  | { type: string; name?: string }
  | { type: string; prompt?: string; agent?: string }
  | { type: string; tool?: string; title?: string }
  | { type: string };

type SessionError = Extract<
  Parameters<NonNullable<Hooks["event"]>>[0]["event"],
  { type: "session.error" }
>["properties"]["error"];

export type SessionErrorInfo =
  | NonNullable<SessionError>
  | { name: string; message?: string; data?: { message?: unknown } };

type UserMessageInput = {
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
    onStart: (span: Span) => {
      span.setAttribute("langfuse.user.id", userId);
    },
    onEnd: () => undefined,
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  }) satisfies SpanProcessor;

const makePluginVersionSpanProcessor = () =>
  ({
    onStart: (span: Span) => {
      span.setAttribute("langfuse.plugin.version", PLUGIN_VERSION);
    },
    onEnd: () => undefined,
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  }) satisfies SpanProcessor;

const makeOpencodeVersionSpanProcessor = (version: string) =>
  ({
    onStart: (span: Span) => {
      span.setAttribute(
        "langfuse.observation.metadata.opencodeVersion",
        version,
      );
    },
    onEnd: () => undefined,
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  }) satisfies SpanProcessor;

// Langfuse's OTEL processor may auto-mark exported spans as app roots, this overrides that.
const makeAppRootSpanProcessor = (tracerName: string) =>
  ({
    onStart: (span: Span) => {
      if (span.instrumentationScope.name !== tracerName) {
        return;
      }

      span.setAttribute(
        "langfuse.internal.is_app_root",
        span.name === "opencode.turn",
      );
    },
    onEnd: () => undefined,
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
  opencodeVersion?: string;
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
      generationInputSnapshotsBySession: new Map<string, unknown>(),
      sessionParentIds: new Map<string, string>(),
      sessionHistories: new Map<string, SessionHistory>(),
      pendingUserMessageIdsBySession: new Map<string, string>(),
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
          input.serviceName != null
            ? resourceFromAttributes({ "service.name": input.serviceName })
            : null,
        ),
      spanProcessors: [
        makePluginVersionSpanProcessor(),
        ...(input.opencodeVersion != null
          ? [makeOpencodeVersionSpanProcessor(input.opencodeVersion)]
          : []),
        ...(input.userId != null
          ? [makeUserIdSpanProcessor(input.userId)]
          : []),
        processor,
        makeAppRootSpanProcessor(traceState.tracerName),
      ],
    });
    yield* Effect.sync(() => {
      provider.register();
    });

    return new LangfuseClient({
      baseUrl: input.baseUrl,
      traceState,
      forceFlush: Effect.tryPromise(() => processor.forceFlush()),
    });
  });
