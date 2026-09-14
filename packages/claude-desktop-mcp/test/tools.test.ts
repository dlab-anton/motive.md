import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MotiveClient } from '../src/client.js';
import { formatToolResult, registerMotiveTools } from '../src/tools.js';

const KEY = `motive_agent_${'a'.repeat(32)}_${'b'.repeat(43)}`;
const UUID = '12345678-1234-4123-8123-123456789abc';

function catalog() {
  const configs = new Map<string, { inputSchema: { safeParse(value: unknown): { success: boolean } }; annotations: { readOnlyHint: boolean } }>();
  const fake = { registerTool(name: string, config: never) { configs.set(name, config); } } as unknown as McpServer;
  const tools = registerMotiveTools(fake, new MotiveClient(KEY, async () => new Response('{}')));
  return { tools: new Map(tools.map(tool => [tool.name, tool])), configs };
}

test('registers the complete bounded queue lifecycle', () => {
  const { tools } = catalog();
  assert.deepEqual([...tools.keys()], [
    'read_project_document', 'get_public_research_brief', 'get_hosted_results', 'get_public_research_update',
    'get_public_submission', 'get_work_queue', 'get_assignment', 'get_research_context', 'get_hypothesis_context',
    'get_retained_research_context', 'get_research_snapshot', 'match_experiment_protocol', 'set_session_status',
    'claim_assignment', 'renew_assignment', 'record_assignment_intent', 'release_assignment', 'submit_circle_witness',
    'complete_assignment', 'append_post_check_assessment', 'attach_reproducibility', 'preview_finding_review',
    'decide_finding_review', 'get_research_sync_capability', 'sync_research',
  ]);
});

test('maps lifecycle inputs to exact fixed API paths and removes path fields from bodies', () => {
  const { tools } = catalog();
  assert.deepEqual(tools.get('renew_assignment')?.request({ assignmentId: UUID, leaseEpoch: 3, idempotencyKey: 'renew.key.123' }), {
    method: 'POST', path: `/api/agent/assignments/${UUID}/renew`, body: { leaseEpoch: 3 }, idempotencyKey: 'renew.key.123',
  });
  assert.deepEqual(tools.get('sync_research')?.request({ submissionId: UUID, policyId: UUID,
    reportDigest: `sha256:${'c'.repeat(64)}`, idempotencyKey: 'sync.key.123' }), {
    method: 'POST', path: `/api/agent/submissions/${UUID}/research-sync`,
    body: { policyId: UUID, reportDigest: `sha256:${'c'.repeat(64)}` }, idempotencyKey: 'sync.key.123',
  });
  assert.equal(tools.get('get_public_submission')?.request({ submissionId: UUID, document: 'solver-source' }).path,
    `/api/public/projects/circle-packing/submissions/${UUID}/reproducibility/solver-source.txt`);
});

test('advertised schemas reject malformed IDs, extra fields, and invalid retry keys', () => {
  const { configs } = catalog();
  assert.equal(configs.get('renew_assignment')?.inputSchema.safeParse({ assignmentId: '../bad', leaseEpoch: 1, idempotencyKey: 'valid.key' }).success, false);
  assert.equal(configs.get('renew_assignment')?.inputSchema.safeParse({ assignmentId: UUID, leaseEpoch: 1, idempotencyKey: 'short' }).success, false);
  assert.equal(configs.get('get_work_queue')?.inputSchema.safeParse({ token: KEY }).success, false);
});

test('structured protocol matching is advertised read-only and maps to its sole POST exception', () => {
  const { tools, configs } = catalog();
  assert.equal(configs.get('match_experiment_protocol')?.annotations.readOnlyHint, true);
  const request = tools.get('match_experiment_protocol')?.request({ experimentProtocol: {
    format: 'motive.experiment-protocol.v1', procedure: 'One bounded trial',
    inputs: [{ name: 'seed', value: '1' }], purpose: 'EXPLORATORY',
  } });
  assert.equal(request?.path, '/api/agent/experiment-protocol-matches');
  assert.equal(request?.readOnlyPost, true);
  assert.equal(request?.idempotencyKey, undefined);
});

test('emits raw evidence text without JSON quoting or whitespace changes', () => {
  const exact = '{\r\n  "trial": 9007199254740993\r\n}\r\n';
  const result = formatToolResult(exact);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]?.type, 'text');
  if (result.content[0]?.type !== 'text') assert.fail('Expected text content.');
  assert.equal(result.content[0].text, exact);
});
