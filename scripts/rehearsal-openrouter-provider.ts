/** Loaded only by the isolated browser rehearsal, never by the application. */
import { readFileSync } from 'node:fs';

const database = new URL(process.env.MOTIVE_DATABASE_URL || 'http://invalid');
if (!/^\/motive_ui_[a-f0-9]{32}$/.test(database.pathname) || process.env.MOTIVE_API_PORT !== '4319') {
  throw new Error('The rehearsal provider requires its disposable database and API port.');
}
const originalFetch = globalThis.fetch;
const storageOrigin = 'http://127.0.0.1:4320';
const objectFile = process.env.MOTIVE_REHEARSAL_OBJECTS_FILE;
if (!objectFile) throw new Error('The rehearsal immutable object fixture is required.');
const encodedObjects = JSON.parse(readFileSync(objectFile, 'utf8')) as Record<string, unknown>;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === storageOrigin) {
    if ((init?.method ?? (input instanceof Request ? input.method : 'GET')) !== 'GET') {
      throw new Error('Rehearsal object storage is read-only.');
    }
    const prefix = '/storage/v1/object/rehearsal-artifacts/';
    if (!url.pathname.startsWith(prefix)) return Response.json({ message: 'not found' }, { status: 404 });
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const encoded = encodedObjects[key];
    if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      return Response.json({ message: 'not found', statusCode: '404' }, { status: 404 });
    }
    const bytes = Buffer.from(encoded, 'base64');
    return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) } });
  }
  if (url.origin !== 'https://openrouter.ai') return originalFetch(input, init);
  if (url.pathname === '/api/v1/models') return Response.json({ data: [{ id: 'openai/gpt-6-astra', name: 'OpenAI: GPT-6 Astra',
    context_length: 128000, supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' } }] });
  if (url.pathname === '/api/v1/auth/keys') {
    const body = JSON.parse(String(init?.body));
    if (body.code !== 'synthetic-browser-authorization' || body.code_challenge_method !== 'S256' || body.code_verifier?.length < 43) return Response.json({ error: 'Invalid synthetic authorization' }, { status: 403 });
    return Response.json({ key: 'sk-or-rehearsal-only-never-a-provider-credential' });
  }
  if (url.pathname === '/api/v1/key') return Response.json({ data: { label: 'Isolated browser test', limit: 1, limit_remaining: 1, is_free_tier: false, is_management_key: false, expires_at: null } });
  throw new Error('Provider execution is forbidden in the browser rehearsal.');
};
