import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { captureHeaders, containsToolResult, sha256, type CapturedRequest } from "./protocol.ts";

type MockServer = {
  baseUrl: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
};

export type MockMode = "happy" | "http-401" | "http-429" | "http-500" | "truncated-sse";

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_REQUESTS = 8;

type ResponseItem = Record<string, unknown>;

function event(response: ServerResponse, type: string, data: Record<string, unknown>): void {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function responseEnvelope(id: string, output: ResponseItem[], status = "completed", syntheticCost?: string) {
  return {
    id,
    object: "response",
    created_at: 1_788_652_800,
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 256,
    model: "motive-local-mock-v1",
    output,
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: { effort: "low", summary: "none" },
    store: false,
    temperature: 1,
    text: { format: { type: "text" }, verbosity: "low" },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      ...(syntheticCost === undefined ? {} : { cost: syntheticCost }),
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 14,
    },
  };
}

function streamItem(response: ServerResponse, responseId: string, item: ResponseItem): void {
  event(response, "response.output_item.added", { response_id: responseId, output_index: 0, item: { ...item, status: "in_progress" } });
  event(response, "response.output_item.done", { response_id: responseId, output_index: 0, item: { ...item, status: "completed" } });
}

function streamText(response: ServerResponse, responseId: string, text: string): ResponseItem {
  const itemId = `msg_${responseId}`;
  const item = { id: itemId, type: "message", role: "assistant", content: [{ type: "output_text", annotations: [], text }] };
  event(response, "response.output_item.added", { response_id: responseId, output_index: 0, item: { id: itemId, type: "message", role: "assistant", content: [], status: "in_progress" } });
  event(response, "response.content_part.added", { response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", annotations: [], text: "" } });
  event(response, "response.output_text.delta", { response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, delta: text });
  event(response, "response.output_text.done", { response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, text });
  event(response, "response.content_part.done", { response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", annotations: [], text } });
  event(response, "response.output_item.done", { response_id: responseId, output_index: 0, item: { ...item, status: "completed" } });
  return item;
}

function findShellTool(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.find((tool): tool is Record<string, unknown> => {
    if (!tool || typeof tool !== "object") return false;
    const candidate = tool as Record<string, unknown>;
    const name = String(candidate.name ?? candidate.type ?? "");
    return /shell|exec/i.test(name);
  });
}

function toolCallFor(tool: Record<string, unknown>, turn: number): { item: ResponseItem; callId: string } {
  const toolType = String(tool.type ?? "function");
  const name = String(tool.name ?? "shell");
  const callId = `call_motive_${turn}`;
  const fixtureName = `motive-turn-${turn}.input.txt`;
  const command = process.platform === "win32"
    ? `Get-Content -Raw -LiteralPath '${fixtureName}'`
    : `cat -- '${fixtureName}'`;

  if (toolType === "custom") {
    return { callId, item: { id: `ctc_${turn}`, type: "custom_tool_call", call_id: callId, name, input: command } };
  }
  if (toolType === "local_shell") {
    return { callId, item: { id: `lsc_${turn}`, type: "local_shell_call", call_id: callId, action: { type: "exec", command } } };
  }
  return {
    callId,
    item: {
      id: `fc_${turn}`,
      type: "function_call",
      call_id: callId,
      name,
      arguments: JSON.stringify({ cmd: command }),
    },
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) throw new Error("request body exceeds 1 MiB");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BODY_BYTES) throw new Error("request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startDeterministicMock(mode: MockMode = "happy", syntheticCost?: string): Promise<MockServer> {
  if (syntheticCost !== undefined && !/^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/.test(syntheticCost)) throw new Error('Invalid synthetic cost');
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url?.includes("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: "motive-local-mock-v1", object: "model", owned_by: "motive" }] }));
        return;
      }
      if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Not found" } }));
        return;
      }

      const rawBody = await readBody(request);
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      requests.push({
        sequence: requests.length + 1,
        method: request.method,
        path: request.url,
        bodyDigest: sha256(rawBody),
        body,
        headers: captureHeaders(request.headers as Record<string, string | string[] | undefined>),
      });
      if (requests.length > MAX_REQUESTS) {
        response.writeHead(508, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Mock request limit exceeded", type: "loop_detected" } }));
        return;
      }
      if (mode.startsWith("http-")) {
        const status = Number(mode.slice(5));
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `Deterministic ${status} fixture`, type: "motive_mock_error", code: `mock_${status}` } }));
        return;
      }

      const responseId = `resp_motive_${requests.length}`;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      event(response, "response.created", { response: responseEnvelope(responseId, [], "in_progress") });
      event(response, "response.in_progress", { response: responseEnvelope(responseId, [], "in_progress") });
      if (mode === "truncated-sse") {
        response.write("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial");
        response.end();
        return;
      }

      const tool = findShellTool(body);
      let output: ResponseItem[];
      if (tool && !containsToolResult(body, "call_motive_1")) {
        const call = toolCallFor(tool, 1);
        streamItem(response, responseId, call.item);
        output = [call.item];
      } else if (tool && containsToolResult(body, "call_motive_1") && !containsToolResult(body, "call_motive_2")) {
        const call = toolCallFor(tool, 2);
        streamItem(response, responseId, call.item);
        output = [call.item];
      } else {
        output = [streamText(response, responseId, "MOTIVE_MOCK_COMPLETE")];
      }
      event(response, "response.completed", { response: responseEnvelope(responseId, output, "completed", syntheticCost) });
      response.end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), type: "invalid_request_error" } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    },
  };
}
