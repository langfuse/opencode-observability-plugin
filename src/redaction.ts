export type RedactionConfig = {
  tools?: readonly {
    readonly name: string;
    readonly path?: string;
    readonly input?: "as-is" | "redact";
    readonly output?: "as-is" | "redact";
  }[];
};

type Policy = { input: boolean; output: boolean };

const REDACTED = "[REDACTED]";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class TelemetryRedaction {
  private readonly calls = new Map<string, Policy & { sessionID?: string }>();

  constructor(private readonly config: RedactionConfig = {}) {}

  private policy(tool: string, args: unknown): Policy {
    let decodedArgs: unknown = args;
    if (typeof args === "string") {
      try {
        decodedArgs = JSON.parse(args);
      } catch {
        // Unknown input: apply path-scoped redaction conservatively below.
      }
    }
    const pathKeys = ["filePath", "path", "filename"];
    const argsRecord = isRecord(decodedArgs) ? decodedArgs : undefined;
    const paths =
      argsRecord !== undefined
        ? pathKeys
            .map((key) => argsRecord[key])
            .filter((value): value is string => typeof value === "string")
        : [];
    const unknownPath =
      paths.length === 0 ||
      (argsRecord !== undefined &&
        pathKeys.some(
          (key) => key in argsRecord && typeof argsRecord[key] !== "string",
        ));
    const policies = (paths.length > 0 ? paths : [undefined]).map((path) => {
      let policy: Policy = { input: false, output: false };
      for (const rule of this.config.tools ?? []) {
        if (rule.name !== "*" && rule.name !== tool) {
          continue;
        }
        if (rule.path !== undefined) {
          if (path === undefined) {
            continue;
          }
          const pattern = rule.path.replace(
            /\*\*\/|\*\*|\*|[.+?^${}()|[\]\\]/g,
            (match) =>
              match === "**/"
                ? "(?:.*/)?"
                : match === "**"
                  ? ".*"
                  : match === "*"
                    ? "[^/]*"
                    : `\\${match}`,
          );
          if (!new RegExp(`^${pattern}$`).test(path)) {
            continue;
          }
        }
        policy = {
          input: (rule.input ?? "as-is") === "redact",
          output: (rule.output ?? "redact") === "redact",
        };
      }
      return policy;
    });
    return {
      input:
        policies.some((policy) => policy.input) ||
        (unknownPath && this.unknownPathRedaction(tool).input),
      output:
        policies.some((policy) => policy.output) ||
        (unknownPath && this.unknownPathRedaction(tool).output),
    };
  }

  private unknownPathRedaction(tool: string): Policy {
    const rules = (this.config.tools ?? []).filter(
      (rule) =>
        (rule.name === "*" || rule.name === tool) && rule.path !== undefined,
    );
    return {
      input: rules.some((rule) => rule.input === "redact"),
      output: rules.some((rule) => (rule.output ?? "redact") === "redact"),
    };
  }

  register(callID: string, tool: string, args: unknown, sessionID?: string) {
    if (args === undefined && this.calls.has(callID)) {
      return;
    }
    this.calls.set(callID, {
      ...this.policy(tool, args),
      sessionID: sessionID ?? this.calls.get(callID)?.sessionID,
    });
  }

  clear() {
    this.calls.clear();
  }

  clearSession(sessionID: string) {
    for (const [callID, policy] of this.calls) {
      if (policy.sessionID === sessionID) {
        this.calls.delete(callID);
      }
    }
  }

  toolInput(tool: string, args: unknown) {
    return this.policy(tool, args).input ? REDACTED : args;
  }

  toolOutput(callID: string, output: unknown) {
    return this.calls.get(callID)?.output === true ? REDACTED : output;
  }

  sanitize(value: unknown, sessionID?: string): unknown {
    // Register calls before walking results: a history snapshot can contain
    // tool results from earlier steps as well as their original tool calls.
    const discover = (node: unknown): void => {
      if (typeof node !== "object" || node === null) {
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(discover);
        return;
      }
      if (!isRecord(node)) {
        return;
      }
      const object = node;
      if (typeof object.id === "string" && typeof object.name === "string") {
        if (object.type === "tool-call") {
          this.register(object.id, object.name, object.input, sessionID);
        } else if (typeof object.arguments === "string") {
          try {
            this.register(
              object.id,
              object.name,
              JSON.parse(object.arguments),
              sessionID,
            );
          } catch {
            this.register(object.id, object.name, object.arguments, sessionID);
          }
        }
      }
      Object.values(object).forEach(discover);
    };
    discover(value);

    const visit = (node: unknown): unknown => {
      if (typeof node !== "object" || node === null) {
        return node;
      }
      if (Array.isArray(node)) {
        return node.map(visit);
      }
      if (!isRecord(node)) {
        return node;
      }
      const object = node;
      const callID =
        typeof object.tool_call_id === "string"
          ? object.tool_call_id
          : typeof object.toolCallId === "string"
            ? object.toolCallId
            : typeof object.callID === "string"
              ? object.callID
              : typeof object.id === "string" &&
                  (object.type === "tool-result" ||
                    object.type === "tool" ||
                    object.type === "tool-call" ||
                    (typeof object.name === "string" && "arguments" in object))
                ? object.id
                : undefined;
      const resultTool =
        (object.type === "tool-result" || object.role === "tool") &&
        typeof object.name === "string"
          ? object.name
          : undefined;
      const namedPolicy =
        resultTool !== undefined
          ? this.policy(resultTool, undefined)
          : undefined;
      const policy =
        (callID !== undefined ? this.calls.get(callID) : undefined) ??
        namedPolicy;
      const isResult = object.role === "tool" || object.type === "tool-result";
      const isCall = typeof object.name === "string" && "arguments" in object;
      if (policy?.output === true && isResult) {
        return {
          ...Object.fromEntries(
            Object.entries(object).filter(([key]) =>
              [
                "role",
                "type",
                "id",
                "name",
                "tool_call_id",
                "toolCallId",
              ].includes(key),
            ),
          ),
          ...(object.role === "tool" ? { content: REDACTED } : {}),
          ...(object.type === "tool-result" ? { result: REDACTED } : {}),
        };
      }
      if (policy?.input === true && (isCall || object.type === "tool-call")) {
        return {
          ...Object.fromEntries(
            Object.entries(object).filter(([key]) =>
              ["type", "id", "name", "namespace"].includes(key),
            ),
          ),
          ...(isCall ? { arguments: REDACTED } : { input: REDACTED }),
        };
      }
      return Object.fromEntries(
        Object.entries(object).map(([key, item]) => [key, visit(item)]),
      );
    };
    return visit(value);
  }
}
