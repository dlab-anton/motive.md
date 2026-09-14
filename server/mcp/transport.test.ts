import { describe, expect, it, vi } from 'vitest';
import type { MotiveClient, MotiveRequest } from '../../packages/claude-desktop-mcp/src/client.ts';
import { createMotiveMcpHttpHandler } from './transport.ts';

const ENDPOINT = 'https://motive.example/mcp';
const ORIGIN = 'https://cowork.example';
const UUID = '12345678-1234-4123-8123-123456789abc';

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function execution(result: unknown = { ok: true }) {
  const calls: MotiveRequest[] = [];
  const client = {
    request: vi.fn(async (input: MotiveRequest) => {
      calls.push(input);
      return result;
    }),
  } as unknown as MotiveClient;
  return { calls, value: { client } };
}

describe('Motive stateless Streamable HTTP transport', () => {
  it('negotiates initialization, accepts initialized, and exposes the exact 25-tool registry', async () => {
    const handler = createMotiveMcpHttpHandler({ allowedOrigins: [ORIGIN] });
    const run = execution();
    const initialized = await handler(request({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' },
      },
    }), run.value);
    expect(initialized.status).toBe(200);
    await expect(initialized.json()).resolves.toMatchObject({
      jsonrpc: '2.0', id: 1,
      result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } },
    });

    const notification = await handler(request(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { 'MCP-Protocol-Version': '2025-11-25' },
    ), run.value);
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe('');

    const listed = await handler(request(
      { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} },
      { 'MCP-Protocol-Version': '2025-11-25' },
    ), run.value);
    const payload = await listed.json() as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
    expect(payload.result.tools).toHaveLength(25);
    expect(payload.result.tools.map(tool => tool.name)).toContain('get_work_queue');
    expect(payload.result.tools.every(tool => tool.inputSchema !== undefined)).toBe(true);
  });

  it('preserves exact UTF-8 tool text and passes mutation idempotency through the shared registry', async () => {
    const exact = '\uFEFFline one\r\nβeta\r\n';
    const handler = createMotiveMcpHttpHandler({ allowedOrigins: [ORIGIN] });
    const read = execution(exact);
    const readResponse = await handler(request(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'read_project_document', arguments: { document: 'contributor_skill' },
      } },
      { 'MCP-Protocol-Version': '2025-11-25' },
    ), read.value);
    const readPayload = await readResponse.json() as { result: { content: Array<{ text: string }> } };
    expect(readPayload.result.content[0]?.text).toBe(exact);

    const write = execution();
    await handler(request(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
        name: 'claim_assignment', arguments: { assignmentId: UUID, idempotencyKey: 'claim.test.123' },
      } },
      { 'MCP-Protocol-Version': '2025-11-25' },
    ), write.value);
    expect(write.calls).toEqual([{
      method: 'POST', path: `/api/agent/assignments/${UUID}/claim`, body: {}, idempotencyKey: 'claim.test.123',
    }]);
  });

  it('rejects invalid origins, versions, media negotiation, and oversized bodies without reflecting input', async () => {
    const handler = createMotiveMcpHttpHandler({ allowedOrigins: [ORIGIN], maxBodyBytes: 128 });
    const run = execution();
    const badOrigin = await handler(request(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { Origin: 'https://attacker.example' },
    ), run.value);
    expect(badOrigin.status).toBe(403);

    const badVersion = await handler(request(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'MCP-Protocol-Version': '2099-01-01' },
    ), run.value);
    expect(badVersion.status).toBe(400);

    const badAccept = await handler(request(
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { Accept: 'application/json' },
    ), run.value);
    expect(badAccept.status).toBe(406);

    const marker = 'private-marker-that-must-not-be-reflected';
    const oversized = await handler(request({
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: marker, arguments: { text: marker.repeat(8) } },
    }), run.value);
    expect(oversized.status).toBe(413);
    expect(await oversized.text()).not.toContain(marker);
    expect(run.calls).toHaveLength(0);
  });

  it('returns 405 without opening an SSE stream', async () => {
    const handler = createMotiveMcpHttpHandler({ allowedOrigins: [ORIGIN] });
    const response = await handler(new Request(ENDPOINT, {
      method: 'GET', headers: { Accept: 'text/event-stream', Origin: ORIGIN },
    }), execution().value);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});
