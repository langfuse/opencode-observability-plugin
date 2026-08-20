// Every type or schema in this file that mirrors OpenCode internals must include
// a version-pinned OpenCode source link with the exact line range it matches.

import type { Hooks } from "@opencode-ai/plugin";
import { Schema } from "effect";

import type { LangfuseClient } from "./langfuse.js";

// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L103-L114
type SessionNextStepStartedEvent = {
  id: string;
  type: "session.next.step.started";
  properties: {
    sessionID: string;
    timestamp: number;
    assistantMessageID?: string;
    agent: string;
    model: Parameters<LangfuseClient["startActiveGenerationStep"]>[0]["model"];
    snapshot?: string;
  };
};

// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L116-L135
type SessionNextStepEndedEvent = {
  id: string;
  type: "session.next.step.ended";
  properties: { sessionID: string; timestamp: number };
};

// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L137-L145
type SessionNextStepFailedEvent = {
  id: string;
  type: "session.next.step.failed";
  properties: {
    sessionID: string;
    timestamp: number;
    assistantMessageID?: string;
    error: { message: string };
  };
};

// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L249-L263
type SessionNextToolCalledEvent = {
  id: string;
  type: "session.next.tool.called";
  properties: {
    sessionID: string;
    timestamp: number;
    assistantMessageID?: string;
    callID: string;
    tool: string;
    input: Record<string, unknown>;
    provider: { executed: boolean; metadata?: unknown };
  };
};

// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L321-L330
type SessionNextRetriedEvent = {
  id: string;
  type: "session.next.retried";
  properties: {
    sessionID: string;
    timestamp: number;
    attempt: number;
    error: unknown;
  };
};

// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L201-L210
type SessionNextReasoningEndedEvent = {
  id: string;
  type: "session.next.reasoning.ended";
  properties: {
    sessionID: string;
    timestamp: number;
    assistantMessageID: string;
    reasoningID: string;
    text: string;
  };
};

// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L353-L362
type SessionNextCompactionEndedEvent = {
  id: string;
  type: "session.next.compaction.ended";
  properties: {
    sessionID: string;
    timestamp: number;
    text: string;
    include?: string;
  };
};

// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/core/src/session-event.ts#L365-L405
export type SessionNextEvent =
  | SessionNextStepStartedEvent
  | SessionNextStepEndedEvent
  | SessionNextStepFailedEvent
  | SessionNextToolCalledEvent
  | SessionNextRetriedEvent
  | SessionNextReasoningEndedEvent
  | SessionNextCompactionEndedEvent;

// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/plugin/src/index.ts#L222-L224
export type OpencodeEvent =
  | Parameters<NonNullable<Hooks["event"]>>[0]["event"]
  | SessionNextEvent;

// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/opencode/src/tool/tool.ts#L46-L52
export const NativeToolResultSchema = Schema.Struct({
  title: Schema.String,
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  output: Schema.String,
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
});

// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/opencode/src/mcp/index.ts#L158-L184
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

// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/opencode/src/session/tools.ts#L163-L171
export const McpResourceContentsSchema = Schema.Union(
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

// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/opencode/src/session/tools.ts#L153-L172
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
