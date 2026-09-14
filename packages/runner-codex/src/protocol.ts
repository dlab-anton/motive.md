import { createHash } from "node:crypto";

export type CapturedRequest = {
  sequence: number;
  method: string;
  path: string;
  bodyDigest: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

const IDENTITY_HEADERS = [
  "authorization",
  "x-client-request-id",
  "x-request-id",
  "x-stainless-retry-count",
  "openai-beta",
  "user-agent",
] as const;

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function captureHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  return Object.fromEntries(
    IDENTITY_HEADERS.flatMap((name) => {
      const value = headers[name];
      if (value === undefined) return [];
      const rendered = Array.isArray(value) ? value.join(",") : value;
      const scheme = rendered.includes(" ") ? rendered.split(/\s+/, 1)[0] : "present";
      return [[name, name === "authorization" ? `${scheme} [REDACTED]` : rendered]];
    }),
  );
}

export function parseJsonLines(text: string): Record<string, unknown>[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${String(error)}`);
      }
    });
}

export function requestInput(body: Record<string, unknown>): unknown[] {
  return Array.isArray(body.input) ? body.input : [];
}

export function containsToolResult(body: Record<string, unknown>, callId: string): boolean {
  return requestInput(body).some((item) => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Record<string, unknown>;
    return candidate.call_id === callId &&
      (candidate.type === "function_call_output" || candidate.type === "custom_tool_call_output" || candidate.type === "local_shell_call_output");
  });
}

/** A returned error or a mention of fixture text is not a successful read. */
export function hasSuccessfulFixtureRead(body: Record<string, unknown>, callId: string, expected: string): boolean {
  return requestInput(body).some(item => {
    if (!item || typeof item !== 'object') return false;
    const value = item as Record<string, unknown>;
    if (value.type !== 'function_call_output' || value.call_id !== callId || typeof value.output !== 'string') return false;
    const output = value.output.replaceAll('\r\n', '\n');
    if (!/(?:^|\n)(?:Process exited with code 0|Exit code: 0)\n/.test(output)) return false;
    const marker = output.match(/(?:^|\n)(?:Final output|Output):\n/);
    return marker?.index !== undefined && output.slice(marker.index + marker[0].length).trim() === expected;
  });
}

export function summarizeProtocol(requests: CapturedRequest[]): Record<string, unknown> {
  return {
    requestCount: requests.length,
    requestSequences: requests.map((request) => request.sequence),
    requestDigests: requests.map((request) => request.bodyDigest),
    clientRequestIds: requests.map((request) => request.headers["x-client-request-id"] ?? null),
    retryCounts: requests.map((request) => request.headers["x-stainless-retry-count"] ?? null),
    previousResponseIds: requests.map((request) => request.body.previous_response_id ?? null),
    storeValues: requests.map((request) => request.body.store ?? null),
    inputLengths: requests.map((request) => requestInput(request.body).length),
  };
}
