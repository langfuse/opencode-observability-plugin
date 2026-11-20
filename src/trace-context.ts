import {
  isSpanContextValid,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

import type { LangfuseClient } from "./langfuse.js";

// Keep propagation independent of the host's global OTel configuration.
const propagator = new W3CTraceContextPropagator();

function isHeaders(carrier: unknown): carrier is Headers {
  return typeof Headers !== "undefined" && carrier instanceof Headers;
}

function isRecord(carrier: unknown): carrier is Record<string, string> {
  return typeof carrier === "object" && carrier !== null && !isHeaders(carrier);
}

function hasTraceHeader(carrier: unknown): boolean {
  if (carrier == null) {
    return false;
  }
  if (isHeaders(carrier)) {
    return carrier.has("traceparent") || carrier.has("tracestate");
  }
  if (typeof carrier === "object") {
    return Object.keys(carrier).some(
      (key) =>
        key.toLowerCase() === "traceparent" ||
        key.toLowerCase() === "tracestate",
    );
  }
  return false;
}

const headerMapSetter = {
  set(carrier: unknown, key: string, value: string) {
    if (isHeaders(carrier)) {
      carrier.set(key, value);
    } else if (isRecord(carrier)) {
      carrier[key] = value;
    }
  },
};

export function injectTraceContext(
  headers: Record<string, string> | Headers,
  context: ReturnType<LangfuseClient["getActiveTraceContext"]>,
  configuredHeaders: readonly unknown[] = [],
) {
  // Header names are case-insensitive. Leave even malformed existing values
  // to their owner rather than replacing another plugin's propagation policy.
  if (hasTraceHeader(headers) || configuredHeaders.some(hasTraceHeader)) {
    return;
  }

  const parent = [context.generation, context.turn].find(
    (candidate) =>
      candidate !== undefined &&
      isSpanContextValid(candidate) &&
      Number.isInteger(candidate.traceFlags) &&
      candidate.traceFlags >= 0 &&
      candidate.traceFlags <= 255,
  );
  if (!parent) {
    return;
  }

  propagator.inject(
    trace.setSpanContext(ROOT_CONTEXT, {
      traceId: parent.traceId.toLowerCase(),
      spanId: parent.spanId.toLowerCase(),
      // W3C version 00 propagates the sampling decision, not reserved flag bits.
      traceFlags: parent.traceFlags & TraceFlags.SAMPLED,
      traceState: parent.traceState,
    }),
    headers,
    headerMapSetter,
  );
}
