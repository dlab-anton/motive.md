import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;
const MAX_INSPECT_BATCH = 100;

export type DockerImageListing = {
  Repository: string;
  Tag: string;
  ID: string;
  Size: string;
};

export type MotiveImageSelection = {
  removableRefs: string[];
  protectedRefs: string[];
  uniqueImages: Array<{ id: string; size: string; motiveRefs: string[]; otherRefs: string[]; protected: boolean }>;
};

export function selectUnusedMotiveImageRefs(
  rows: readonly DockerImageListing[],
  containerImageIds: ReadonlySet<string>,
): MotiveImageSelection {
  const images = new Map<string, { size: string; motiveRefs: Set<string>; otherRefs: Set<string> }>();
  for (const row of rows) {
    if (typeof row.ID !== 'string' || row.ID.length === 0 || typeof row.Repository !== 'string' || typeof row.Tag !== 'string') continue;
    const image = images.get(row.ID) ?? { size: row.Size, motiveRefs: new Set<string>(), otherRefs: new Set<string>() };
    images.set(row.ID, image);
    if (row.Repository === '<none>' || row.Tag === '<none>') continue;
    const ref = `${row.Repository}:${row.Tag}`;
    if (row.Repository.startsWith('motive-')) image.motiveRefs.add(ref); else image.otherRefs.add(ref);
  }
  const removableRefs: string[] = []; const protectedRefs: string[] = [];
  const uniqueImages = [...images.entries()].filter(([, image]) => image.motiveRefs.size > 0).map(([id, image]) => {
    const motiveRefs = [...image.motiveRefs].sort(); const protectedImage = containerImageIds.has(id);
    (protectedImage ? protectedRefs : removableRefs).push(...motiveRefs);
    return { id, size: image.size, motiveRefs, otherRefs: [...image.otherRefs].sort(), protected: protectedImage };
  }).sort((left, right) => left.id.localeCompare(right.id));
  return { removableRefs: removableRefs.sort(), protectedRefs: protectedRefs.sort(), uniqueImages };
}

type CliOptions = { apply: boolean; buildCache: boolean; keepStorage: string | null };

export function parseCleanupArguments(args: readonly string[]): CliOptions {
  let apply = false; let buildCache = false; let keepStorage: string | null = null;
  for (const arg of args) {
    if (arg === '--apply') apply = true;
    else if (arg === '--build-cache') buildCache = true;
    else if (arg.startsWith('--keep-storage=')) keepStorage = arg.slice('--keep-storage='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (buildCache !== (keepStorage !== null)) throw new Error('--build-cache and --keep-storage=<1-100>GB must be supplied together.');
  if (keepStorage !== null && !/^(?:[1-9]|[1-9][0-9]|100)GB$/.test(keepStorage)) {
    throw new Error('--keep-storage must be an integer from 1GB through 100GB.');
  }
  return { apply, buildCache, keepStorage };
}

async function docker(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let exceeded = false;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_COMMAND_OUTPUT) { exceeded = true; child.kill(); return; }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.once('error', reject);
    child.once('close', code => {
      if (exceeded) { reject(new Error('Docker command output exceeded 16 MiB.')); return; }
      if (code !== 0) { reject(new Error(`Docker command failed (${args[0] ?? 'unknown'}): ${Buffer.concat(stderr).toString('utf8').trim()}`)); return; }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

function jsonLines<T>(text: string): T[] {
  return text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as T);
}

async function containerImageIds(): Promise<Set<string>> {
  const ids = (await docker(['ps', '-aq', '--no-trunc'])).split(/\s+/u).filter(Boolean);
  const images = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += MAX_INSPECT_BATCH) {
    const inspected = JSON.parse(await docker(['inspect', '--type', 'container', ...ids.slice(offset, offset + MAX_INSPECT_BATCH)])) as unknown;
    if (!Array.isArray(inspected)) throw new Error('Docker container inspection returned malformed JSON.');
    for (const item of inspected) {
      if (item && typeof item === 'object' && typeof (item as { Image?: unknown }).Image === 'string') images.add((item as { Image: string }).Image);
    }
  }
  return images;
}

async function inspectState() {
  const [imageText, usedIds, diskText] = await Promise.all([
    docker(['image', 'ls', '--no-trunc', '--format', '{{json .}}']),
    containerImageIds(),
    docker(['system', 'df', '--format', '{{json .}}']),
  ]);
  const rows = jsonLines<DockerImageListing>(imageText);
  return { selection: selectUnusedMotiveImageRefs(rows, usedIds), systemDf: jsonLines<Record<string, unknown>>(diskText) };
}

export async function cleanupMotiveDocker(args: readonly string[]): Promise<void> {
  const options = parseCleanupArguments(args); const before = await inspectState();
  const report: Record<string, unknown> = { mode: options.apply ? 'apply' : 'dry-run', before,
    cachePlan: options.buildCache ? { keepStorage: options.keepStorage } : null };
  if (options.apply) {
    if (before.selection.removableRefs.length) await docker(['image', 'rm', '--', ...before.selection.removableRefs]);
    if (options.buildCache) await docker(['builder', 'prune', '--force', '--keep-storage', options.keepStorage!]);
    report.after = await inspectState();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cleanupMotiveDocker(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Docker cleanup failed.'}\n`); process.exitCode = 1;
  });
}
