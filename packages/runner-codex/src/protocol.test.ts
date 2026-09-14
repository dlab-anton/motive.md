import { describe, expect, it } from "vitest";
import { captureHeaders, containsToolResult, hasSuccessfulFixtureRead, parseJsonLines, summarizeProtocol } from "./protocol.ts";

describe("Codex protocol evidence", () => {
  it('requires successful exit and exact fixture output instead of a failed-tool round trip', () => {
    const body = (output: string) => ({ input: [{ type: 'function_call_output', call_id: 'call-1', output }] });
    expect(hasSuccessfulFixtureRead(body('Process exited with code 0\nFinal output:\nturn-one\n'), 'call-1', 'turn-one')).toBe(true);
    expect(hasSuccessfulFixtureRead(body('Rejected: blocked by policy while reading turn-one'), 'call-1', 'turn-one')).toBe(false);
    expect(hasSuccessfulFixtureRead(body('Process exited with code 1\nFinal output:\nturn-one\n'), 'call-1', 'turn-one')).toBe(false);
    expect(hasSuccessfulFixtureRead(body('Process exited with code 0\nFinal output:\nturn-one\n'), 'different-call', 'turn-one')).toBe(false);
    expect(hasSuccessfulFixtureRead(body('Process exited with code 0\nFinal output:\nturn-one failed'), 'call-1', 'turn-one')).toBe(false);
  });
  it("recognizes each supported tool-result item without trusting prose", () => {
    for (const type of ["function_call_output", "custom_tool_call_output", "local_shell_call_output"]) {
      expect(containsToolResult({ input: [{ type, call_id: "call-1", output: "ok" }] }, "call-1")).toBe(true);
    }
    expect(containsToolResult({ input: [{ type: "message", content: "call-1 succeeded" }] }, "call-1")).toBe(false);
  });

  it("rejects non-JSON event lines", () => {
    expect(() => parseJsonLines('{"type":"turn.started"}\nnot-json')).toThrow(/line 2/);
  });

  it("never persists bearer material", () => {
    expect(captureHeaders({ authorization: "Bearer fixture-secret", "x-client-request-id": "thread-1" })).toEqual({
      authorization: "Bearer [REDACTED]",
      "x-client-request-id": "thread-1",
    });
    expect(captureHeaders({ authorization: "opaque-secret" }).authorization).toBe("present [REDACTED]");
  });

  it("keeps request identity, retries, and continuation fields distinct", () => {
    const summary = summarizeProtocol([{
      sequence: 1,
      method: "POST",
      path: "/v1/responses",
      bodyDigest: "sha256:a",
      body: { store: false, previous_response_id: null, input: [] },
      headers: { "x-client-request-id": "thread-1", "x-stainless-retry-count": "0" },
    }]);
    expect(summary).toMatchObject({
      requestCount: 1,
      clientRequestIds: ["thread-1"],
      retryCounts: ["0"],
      previousResponseIds: [null],
      storeValues: [false],
    });
  });
});
