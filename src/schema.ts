// Every type or schema in this file that mirrors OpenCode internals must include
// a version-pinned OpenCode source link with the exact line range it matches.
// Links should use the OpenCode version in package.json by default. Older
// versions may only be linked when retaining backward compatibility.

import type { Hooks } from "@opencode-ai/plugin";
import { Schema } from "effect";

import type { LangfuseClient } from "./langfuse.js";

// Retained from v1.15.13 for compatibility with its step-start payload.
// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L103-L114
type LegacySessionNextStepStartedEvent = {
  id: string;
  type: "session.next.step.started";
  properties: {
    sessionID: string;
    timestamp: number;
    agent: string;
    model: Parameters<LangfuseClient["startActiveGenerationStep"]>[0]["model"];
    snapshot?: string;
  };
};

// Retained from v1.15.13 for compatibility with its step-end payload.
// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L116-L135
type LegacySessionNextStepEndedEvent = {
  id: string;
  type: "session.next.step.ended";
  properties: {
    sessionID: string;
    timestamp: number;
    finish: string;
    cost: number;
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
    snapshot?: string;
  };
};

// Retained from v1.15.13 for compatibility with its step-failure payload.
// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L137-L145
type LegacySessionNextStepFailedEvent = {
  id: string;
  type: "session.next.step.failed";
  properties: {
    sessionID: string;
    timestamp: number;
    error: { type: "unknown"; message: string };
  };
};

// Retained from v1.15.13 for compatibility with its tool-call payload.
// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L249-L263
type LegacySessionNextToolCalledEvent = {
  id: string;
  type: "session.next.tool.called";
  properties: {
    sessionID: string;
    timestamp: number;
    callID: string;
    tool: string;
    input: Record<string, unknown>;
    provider: { executed: boolean; metadata?: Record<string, unknown> };
  };
};

// Retained from v1.15.13 for compatibility with its retry payload.
// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L321-L330
type LegacySessionNextRetriedEvent = {
  id: string;
  type: "session.next.retried";
  properties: {
    sessionID: string;
    timestamp: number;
    attempt: number;
    error: {
      message: string;
      isRetryable: boolean;
      statusCode?: number;
      responseHeaders?: Record<string, string>;
      responseBody?: string;
      metadata?: Record<string, string>;
    };
  };
};

// Retained from v1.15.13 for compatibility with its reasoning-end payload.
// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L201-L210
type LegacySessionNextReasoningEndedEvent = {
  id: string;
  type: "session.next.reasoning.ended";
  properties: {
    sessionID: string;
    timestamp: number;
    reasoningID: string;
    text: string;
  };
};

// Retained from v1.15.13 for compatibility with its compaction-end payload.
// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L353-L362
type LegacySessionNextCompactionEndedEvent = {
  id: string;
  type: "session.next.compaction.ended";
  properties: {
    sessionID: string;
    timestamp: number;
    text: string;
    include?: string;
  };
};

// Retained from v1.15.13 to compose its compatibility event payloads.
// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L365-L405
type LegacySessionNextEvent =
  | LegacySessionNextStepStartedEvent
  | LegacySessionNextStepEndedEvent
  | LegacySessionNextStepFailedEvent
  | LegacySessionNextToolCalledEvent
  | LegacySessionNextRetriedEvent
  | LegacySessionNextReasoningEndedEvent
  | LegacySessionNextCompactionEndedEvent;

// https://github.com/anomalyco/opencode/blob/v1.18.19/packages/schema/src/session-event.ts#L149-L160
type SessionNextStepStartedEvent = {
  id: string;
  type: "session.next.step.started";
  properties: {
    sessionID: string;
    timestamp: number;
    assistantMessageID: string;
    agent: string;
    model: Parameters<LangfuseClient["startActiveGenerationStep"]>[0]["model"];
    snapshot?: string;
  };
};

// https://github.com/anomalyco/opencode/blob/v1.18.19/packages/schema/src/session-event.ts#L162-L183
type SessionNextStepEndedEvent = {
  id: string;
  type: "session.next.step.ended";
  properties: {
    sessionID: string;
    timestamp: number;
    assistantMessageID: string;
    finish: string;
    cost: number;
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
    snapshot?: string;
    files?: string[];
  };
};

// https://github.com/anomalyco/opencode/blob/v1.18.19/packages/schema/src/session-event.ts#L185-L194
type SessionNextStepFailedEvent = {
  id: string;
  type: "session.next.step.failed";
  properties: {
    sessionID: string;
    timestamp: number;
    assistantMessageID: string;
    error: { type: "unknown"; message: string };
  };
};

// https://github.com/anomalyco/opencode/blob/v1.18.19/packages/schema/src/session-event.ts#L312-L325
type SessionNextToolCalledEvent = {
  id: string;
  type: "session.next.tool.called";
  properties: {
    sessionID: string;
    timestamp: number;
    assistantMessageID: string;
    callID: string;
    tool: string;
    input: Record<string, unknown>;
    provider: {
      executed: boolean;
      metadata?: Record<string, Record<string, unknown>>;
    };
  };
};

// https://github.com/anomalyco/opencode/blob/v1.18.19/packages/schema/src/session-event.ts#L375-L396
type SessionNextRetriedEvent = {
  id: string;
  type: "session.next.retried";
  properties: {
    sessionID: string;
    timestamp: number;
    attempt: number;
    error: {
      message: string;
      isRetryable: boolean;
      statusCode?: number;
      responseHeaders?: Record<string, string>;
      responseBody?: string;
      metadata?: Record<string, string>;
    };
  };
};

// https://github.com/anomalyco/opencode/blob/v1.18.19/packages/schema/src/session-event.ts#L259-L270
type SessionNextReasoningEndedEvent = {
  id: string;
  type: "session.next.reasoning.ended";
  properties: {
    sessionID: string;
    timestamp: number;
    assistantMessageID: string;
    reasoningID: string;
    text: string;
    providerMetadata?: Record<string, Record<string, unknown>>;
  };
};

// https://github.com/anomalyco/opencode/blob/v1.18.19/packages/schema/src/session-event.ts#L420-L431
type SessionNextCompactionEndedEvent = {
  id: string;
  type: "session.next.compaction.ended";
  properties: {
    sessionID: string;
    timestamp: number;
    messageID: string;
    reason: "auto" | "manual";
    text: string;
    recent: string;
  };
};

// https://github.com/anomalyco/opencode/blob/v1.18.19/packages/schema/src/session-event.ts#L479-L517
type CurrentSessionNextEvent =
  | SessionNextStepStartedEvent
  | SessionNextStepEndedEvent
  | SessionNextStepFailedEvent
  | SessionNextToolCalledEvent
  | SessionNextRetriedEvent
  | SessionNextReasoningEndedEvent
  | SessionNextCompactionEndedEvent;

// https://github.com/anomalyco/opencode/blob/v1.18.19/packages/schema/src/session-event.ts#L479-L517
type SessionNextEvent = LegacySessionNextEvent | CurrentSessionNextEvent;

// https://github.com/anomalyco/opencode/blob/v1.18.19/packages/plugin/src/index.ts#L222-L224
export type OpencodeEvent =
  | Parameters<NonNullable<Hooks["event"]>>[0]["event"]
  | SessionNextEvent;

// https://github.com/anomalyco/opencode/blob/v1.18.19/packages/opencode/src/tool/tool.ts#L48-L53
export const NativeToolResultSchema = Schema.Struct({
  title: Schema.String,
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  output: Schema.String,
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
});

// https://github.com/anomalyco/opencode/blob/v1.18.19/packages/opencode/src/session/tools.ts#L407-L424
export const McpToolResultSchema = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  structuredContent: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  isError: Schema.optional(Schema.Boolean),
  _meta: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
});

// https://github.com/anomalyco/opencode/blob/v1.18.19/packages/opencode/src/session/tools.ts#L436-L461
const McpResourceContentsSchema = Schema.Union(
  Schema.Struct({
    uri: Schema.String,
    mimeType: Schema.optional(Schema.String),
    text: Schema.String,
  }),
  Schema.Struct({
    uri: Schema.String,
    mimeType: Schema.optional(Schema.String),
    blob: Schema.String,
  }),
);

// https://github.com/anomalyco/opencode/blob/v1.18.19/packages/opencode/src/session/tools.ts#L426-L461
export const McpContentSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("image"),
    data: Schema.String,
    mimeType: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("resource"),
    resource: McpResourceContentsSchema,
  }),
);
