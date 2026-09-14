import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const KEY = `motive_agent_${'a'.repeat(32)}_${'b'.repeat(43)}`;

test('bundled stdio server initializes and lists tools without exposing a credential argument', async () => {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  environment.MOTIVE_PROJECT_ACCESS_KEY = KEY;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../server/index.js', import.meta.url))],
    env: environment,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'motive-extension-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 25);
    assert(listed.tools.some(tool => tool.name === 'get_work_queue'));
    const schemas = JSON.stringify(listed.tools.map(tool => tool.inputSchema));
    assert.equal(schemas.includes('project_access_key'), false);
    assert.equal(schemas.includes('MOTIVE_PROJECT_ACCESS_KEY'), false);
  } finally {
    await client.close();
  }
});
