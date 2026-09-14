import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

const requests = [];
const codexHome = process.env.CODEX_HOME;
const sqliteHome = process.env.CODEX_SQLITE_HOME;
if (codexHome !== '/opt/motive/codex-config' || sqliteHome !== '/var/lib/motive/worker') {
  throw new Error('protected Codex state split is missing');
}
const codexHomeMode = (await stat(codexHome)).mode & 0o7777;
let codexHomeWritable = true;
try { await access(codexHome, fsConstants.W_OK); } catch { codexHomeWritable = false; }
if (codexHomeMode !== 0o555 || codexHomeWritable) throw new Error('trusted Codex configuration is writable');

function event(response, type, data) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function envelope(id, output, status = 'completed') {
  return {
    id, object: 'response', created_at: 1_788_652_800, status, error: null, incomplete_details: null,
    instructions: null, max_output_tokens: 256, model: 'motive-local-mock-v1', output,
    parallel_tool_calls: false, previous_response_id: null, reasoning: { effort: 'low', summary: 'none' },
    store: false, temperature: 1, text: { format: { type: 'text' }, verbosity: 'low' },
    tool_choice: 'auto', tools: [], top_p: 1, truncation: 'disabled',
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 14 },
  };
}

function containsResult(body, callId) {
  return Array.isArray(body.input) && body.input.some(item => item && typeof item === 'object'
    && item.type === 'function_call_output' && item.call_id === callId);
}

function provesRead(body, callId, expected) {
  return Array.isArray(body.input) && body.input.some(item => {
    if (!item || item.type !== 'function_call_output' || item.call_id !== callId || typeof item.output !== 'string') return false;
    const output = item.output.replaceAll('\r\n', '\n');
    const marker = output.match(/(?:^|\n)(?:Final output|Output):\n/);
    return /(?:^|\n)(?:Process exited with code 0|Exit code: 0)\n/.test(output)
      && marker?.index !== undefined && output.slice(marker.index + marker[0].length).trim() === expected;
  });
}

function streamItem(response, responseId, item) {
  event(response, 'response.output_item.added', { response_id: responseId, output_index: 0, item: { ...item, status: 'in_progress' } });
  event(response, 'response.output_item.done', { response_id: responseId, output_index: 0, item: { ...item, status: 'completed' } });
}

function streamText(response, responseId, text) {
  const itemId = `msg_${responseId}`;
  const item = { id: itemId, type: 'message', role: 'assistant', content: [{ type: 'output_text', annotations: [], text }] };
  event(response, 'response.output_item.added', { response_id: responseId, output_index: 0,
    item: { id: itemId, type: 'message', role: 'assistant', content: [], status: 'in_progress' } });
  event(response, 'response.content_part.added', { response_id: responseId, item_id: itemId, output_index: 0,
    content_index: 0, part: { type: 'output_text', annotations: [], text: '' } });
  event(response, 'response.output_text.delta', { response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, delta: text });
  event(response, 'response.output_text.done', { response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, text });
  event(response, 'response.content_part.done', { response_id: responseId, item_id: itemId, output_index: 0,
    content_index: 0, part: { type: 'output_text', annotations: [], text } });
  event(response, 'response.output_item.done', { response_id: responseId, output_index: 0, item: { ...item, status: 'completed' } });
  return item;
}

const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error('request too large');
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const responseId = `resp_native_${requests.length}`;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    event(response, 'response.created', { response: envelope(responseId, [], 'in_progress') });
    event(response, 'response.in_progress', { response: envelope(responseId, [], 'in_progress') });
    const tool = Array.isArray(body.tools) ? body.tools.find(value => value && /shell|exec/i.test(String(value.name ?? value.type ?? ''))) : null;
    let output;
    if (tool && !containsResult(body, 'call_motive_1')) {
      const item = { id: 'fc_native_1', type: 'function_call', call_id: 'call_motive_1', name: tool.name,
        arguments: JSON.stringify(tool.name === 'shell_command'
          ? { command: ['cat', '--', 'motive-turn-1.input.txt'] }
          : { cmd: "cat -- 'motive-turn-1.input.txt'" }) };
      streamItem(response, responseId, item);
      output = [item];
    } else if (tool && !containsResult(body, 'call_motive_2')) {
      const item = { id: 'fc_native_2', type: 'function_call', call_id: 'call_motive_2', name: tool.name,
        arguments: JSON.stringify(tool.name === 'shell_command'
          ? { command: ['cat', '--', 'motive-turn-2.input.txt'] }
          : { cmd: "cat -- 'motive-turn-2.input.txt'" }) };
      streamItem(response, responseId, item);
      output = [item];
    } else {
      output = [streamText(response, responseId, 'MOTIVE_NATIVE_COMPLETE')];
    }
    event(response, 'response.completed', { response: envelope(responseId, output) });
    response.end();
  } catch (error) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: String(error), type: 'invalid_request_error' } }));
  }
});

server.listen(4545, '127.0.0.1');
await once(server, 'listening');
const args = ['exec', '--json', '--ephemeral', '--strict-config', '--ignore-rules', '--skip-git-repo-check',
  '--dangerously-bypass-approvals-and-sandbox',
  'Use the provided local shell tool exactly when requested. Complete the protected runtime exercise.'];
const child = spawn('/usr/local/bin/codex', args, { cwd: '/vercel/sandbox/workspace', env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { if (stdout.length < 1024 * 1024) stdout += chunk.toString('utf8'); });
child.stderr.on('data', chunk => { if (stderr.length < 1024 * 1024) stderr += chunk.toString('utf8'); });
const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
const [exitCode] = await once(child, 'close');
clearTimeout(timer);
server.close();
server.closeAllConnections();
await once(server, 'close');

const successfulFileReads = ['turn-one', 'turn-two'].filter((expected, index) =>
  requests.some(body => provesRead(body, `call_motive_${index + 1}`, expected))).length;
const passed = exitCode === 0 && requests.length === 3 && successfulFileReads === 2;
console.log(JSON.stringify({ format: 'motive.protected-worker-codex/0.1', passed,
  codexVersion: 'codex-cli 0.153.4', interface: 'codex-exec', exitCode,
  requestCount: requests.length, successfulFileReads,
  trustedCodexHomeMode: '0555', codexHomeWritable, sqliteHome: '/var/lib/motive/worker',
  externalSandboxFlag: '--dangerously-bypass-approvals-and-sandbox',
  stderrDigest: `sha256:${createHash('sha256').update(stderr).digest('hex')}` }));
if (!passed) {
  console.error(stderr.slice(0, 4096));
  process.exitCode = 1;
}
