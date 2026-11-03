import { createTraceState, type SpanContext } from "@opentelemetry/api";
import { describe, expect, test } from "vitest";

import { injectTraceContext } from "../../src/trace-context.js";

const parent = {
  traceId: "abcdef0123456789abcdef0123456789",
  spanId: "abcdef0123456789",
  traceFlags: 1,
} satisfies SpanContext;

describe("W3C trace context validation", () => {
  test.each([
    { traceId: "0".repeat(32) },
    { spanId: "0".repeat(16) },
    { traceId: "g".repeat(32) },
    { traceFlags: 256 },
  ])("rejects invalid context %j and falls back to a valid turn", (invalid) => {
    const generation = { ...parent, ...invalid };
    const headers = {};
    injectTraceContext(headers, { generation, turn: undefined });
    expect(headers).toEqual({});
    injectTraceContext(headers, { generation: undefined, turn: generation });
    expect(headers).toEqual({});
    injectTraceContext(headers, { generation, turn: parent });
    expect(headers).toEqual({
      traceparent: `00-${parent.traceId}-${parent.spanId}-01`,
    });
  });

  test.each([0, 255])(
    "serializes sampling flags %i, lowercase IDs, and tracestate",
    (traceFlags) => {
      const headers = {};
      injectTraceContext(headers, {
        generation: {
          ...parent,
          traceId: parent.traceId.toUpperCase(),
          spanId: parent.spanId.toUpperCase(),
          traceFlags,
          traceState: createTraceState("vendor=value"),
        },
        turn: undefined,
      });
      expect(headers).toEqual({
        traceparent: `00-${parent.traceId}-${parent.spanId}-0${(traceFlags & 1).toString(16)}`,
        tracestate: "vendor=value",
      });
    },
  );

  test("leaves malformed existing traceparent headers to their owner", () => {
    const headers = { TraceParent: "invalid" };
    injectTraceContext(headers, { generation: parent, turn: undefined });
    expect(headers).toEqual({ TraceParent: "invalid" });
  });

  test("injects into Headers objects", () => {
    const standardHeaders = new Headers();
    injectTraceContext(standardHeaders, {
      generation: parent,
      turn: undefined,
    });
    expect(standardHeaders.get("traceparent")).toBe(
      `00-${parent.traceId}-${parent.spanId}-01`,
    );
  });

  test("preserves existing trace headers and does not combine standalone tracestate", () => {
    const existingHeaders = new Headers({ traceparent: "existing-trace" });
    injectTraceContext(existingHeaders, {
      generation: parent,
      turn: undefined,
    });
    expect(existingHeaders.get("traceparent")).toBe("existing-trace");

    const standaloneState = { tracestate: "other=value" };
    injectTraceContext(standaloneState, {
      generation: parent,
      turn: undefined,
    });
    expect(standaloneState).toEqual({ tracestate: "other=value" });
  });
});
