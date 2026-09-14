import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';

const codexHome = process.env.CODEX_HOME;
const sqliteHome = process.env.CODEX_SQLITE_HOME;
if (codexHome !== '/opt/motive/codex-config' || sqliteHome !== '/var/lib/motive/worker') {
  throw new Error('protected Codex state split is missing');
}
const codexHomeMode = (await stat(codexHome)).mode & 0o7777;
let codexHomeWritable = true;
try { await access(codexHome, fsConstants.W_OK); } catch { codexHomeWritable = false; }
if (codexHomeMode !== 0o555 || codexHomeWritable) throw new Error('trusted Codex configuration is writable');

async function deniedFileRead(path) {
  try {
    await readFile(path);
    return { denied: false, errorCode: null };
  } catch (error) {
    const errorCode = typeof error === 'object' && error && 'code' in error ? String(error.code) : null;
    return { denied: errorCode === 'EACCES' || errorCode === 'EPERM', errorCode };
  }
}

function deniedSocketConnect(path) {
  return new Promise(resolve => {
    const socket = createConnection({ path });
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ denied: false, errorCode: 'TIMEOUT' }), 2_000);
    socket.once('connect', () => finish({ denied: false, errorCode: null }));
    socket.once('error', error => {
      const errorCode = typeof error === 'object' && error && 'code' in error ? String(error.code) : null;
      finish({ denied: errorCode === 'EACCES' || errorCode === 'EPERM', errorCode });
    });
  });
}

const postgresDataRead = await deniedFileRead('/var/lib/motive/postgres/PG_VERSION');
const postgresSocketConnect = await deniedSocketConnect('/run/motive/postgres/.s.PGSQL.5432');
const args = ['exec', '--json', '--ephemeral', '--strict-config', '--ignore-rules', '--skip-git-repo-check',
  '--dangerously-bypass-approvals-and-sandbox',
  'Use the provided local shell tool exactly when requested. Complete the protected joined gateway exercise.'];
const child = spawn('/usr/local/bin/codex', args, { cwd: '/vercel/sandbox/workspace', env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
let outputTruncated = false;
function capture(current, chunk) {
  if (current.length >= 1024 * 1024) { outputTruncated = true; return current; }
  const accepted = chunk.toString('utf8').slice(0, 1024 * 1024 - current.length);
  if (accepted.length < chunk.length) outputTruncated = true;
  return current + accepted;
}
child.stdout.on('data', chunk => { stdout = capture(stdout, chunk); });
child.stderr.on('data', chunk => { stderr = capture(stderr, chunk); });
const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
const [exitCode] = await once(child, 'close');
clearTimeout(timer);

const events = [];
let invalidJsonLines = 0;
for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
  try { events.push(JSON.parse(line)); }
  catch { invalidJsonLines += 1; }
}
const successfulFileReads = ['turn-one', 'turn-two'].filter(expected => events.some(event => {
  const item = event?.item;
  return event?.type === 'item.completed' && item?.type === 'command_execution'
    && item.exit_code === 0 && String(item.aggregated_output ?? '').trim() === expected;
})).length;
const passed = exitCode === 0 && !outputTruncated && invalidJsonLines === 0 && successfulFileReads === 2
  && postgresDataRead.denied && postgresSocketConnect.denied;
console.log(JSON.stringify({ format: 'motive.protected-worker-joined-codex/0.1', passed,
  codexVersion: 'codex-cli 0.153.4', interface: 'codex-exec', exitCode, successfulFileReads,
  outputTruncated, invalidJsonLines, trustedCodexHomeMode: '0555', codexHomeWritable,
  sqliteHome: '/var/lib/motive/worker', postgresDataRead, postgresSocketConnect,
  externalSandboxFlag: '--dangerously-bypass-approvals-and-sandbox',
  stderrDigest: `sha256:${createHash('sha256').update(stderr).digest('hex')}` }));
if (!passed) {
  console.error(stderr.slice(0, 4096));
  process.exitCode = 1;
}
