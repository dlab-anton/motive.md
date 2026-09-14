#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

const FORBIDDEN_PATH_RULES = [
  ['local state', /(?:^|\/)\.local(?:\/|$)/i],
  ['local agent state', /(?:^|\/)\.agents(?:\/|$)/i],
  ['provider metadata', /(?:^|\/)(?:\.vercel|supabase\/\.temp)(?:\/|$)/i],
  ['environment secret file', /(?:^|\/)\.env(?:\.[^/]*)?$/i],
  ['credential file', /\.(?:key|p12|pfx)$/i],
  ['log file', /(?:^|\/)(?:logs\/|[^/]+\.log$)/i],
  ['debug capture', /(?:^|\/)(?:\.debug|debug-captures|captures)(?:\/|$)/i],
  ['test artifact', /(?:^|\/)(?:test-results|playwright-report|coverage|\.nyc_output)(?:\/|$)/i],
  ['generated artifact', /(?:^|\/)(?:artifacts|dist|build|out|\.cache|\.turbo|\.vite|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(?:\/|$)|\.py[cod]$/i],
  ['dependency tree', /(?:^|\/)node_modules(?:\/|$)/i],
  ['private handoff', /(?:^|\/)(?:\.handoffs|private-handoffs)(?:\/|$)|\.private-handoff\.[^/]+$|^MOTIVE-BACKEND-FINAL-DEV-HANDOFF\.md$|^docs\/(?:HYPOTHESIS-DEPLOYMENT-HANDOFF|ACTIVE-TODO-HISTORY-[^/]+)\.md$/i],
  ['local database or dump', /\.(?:sqlite3?|db3?|dump|sql\.gz)$/i],
  ['archive', /(?:^|\/)(?:archive|archives)(?:\/|$)|\.(?:zip|tar|tar\.gz|tgz|7z|rar)$/i],
];

const CREDENTIAL_RULES = [
  ['Motive bearer', /(?<![A-Za-z0-9_-])motive_(?:agent|review|review_queue)_[a-f0-9]{32}_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g],
  ['OpenAI key', /(?<![A-Za-z0-9_-])sk-(?!or-)(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g],
  ['OpenRouter key', /(?<![A-Za-z0-9_-])sk-or-v1-[a-f0-9]{64}(?![A-Za-z0-9_-])/gi],
  ['GitHub token', /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/g],
  ['Supabase secret key', /(?<![A-Za-z0-9_-])sb_secret_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g],
  ['private key', new RegExp('-----BEGIN ' + '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----', 'g')],
];

function normalizedPath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function publicEnvironmentExample(path) {
  return /(?:^|\/)\.env(?:\.[^/]+)?\.example$/i.test(path);
}

function lineAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function publicationText(path, contents) {
  if (contents[0] === 0xff && contents[1] === 0xfe) return contents.subarray(2).toString('utf16le');
  if (contents[0] === 0xfe && contents[1] === 0xff) {
    const swapped = Buffer.from(contents.subarray(2));
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      const first = swapped[index];
      swapped[index] = swapped[index + 1];
      swapped[index + 1] = first;
    }
    return swapped.toString('utf16le');
  }
  if (!contents.includes(0)) return contents.toString('utf8');
  const knownBinary = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.pdf', '.wasm']);
  if (knownBinary.has(extname(path).toLowerCase())) return null;
  throw new Error('unsupported NUL-bearing text encoding');
}

function findCredentialMatches(text) {
  const findings = [];
  for (const [rule, pattern] of CREDENTIAL_RULES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) findings.push({ index: match.index, rule });
  }

  const passwordUrl = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^/\s:@]+:([^/\s@]+)@(\[[^\]]+\]|[^/\s:]+)/gi;
  for (const match of text.matchAll(passwordUrl)) {
    const encoded = match[1];
    const host = match[2].replace(/^\[|\]$/g, '').toLowerCase();
    let password = encoded;
    try { password = decodeURIComponent(encoded); } catch { /* Treat malformed escapes as literal text. */ }
    const placeholder = /^(?:pass(?:word)?|secret|example|changeme|replace[-_]?me|your[-_].*)$/i.test(password)
      || password.includes('${') || password.includes('{{') || password.startsWith('<')
      || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.invalid');
    if (!placeholder && password.length >= 8) findings.push({ index: match.index, rule: 'password in URL' });
  }

  const jwt = /\beyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
  for (const match of text.matchAll(jwt)) {
    try {
      const payload = JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url').toString('utf8'));
      if (payload?.role === 'service_role') findings.push({ index: match.index, rule: 'service-role JWT' });
    } catch { /* An invalid JWT-shaped string is not a credential match. */ }
  }
  return findings;
}

function runGit(root, args, encoding = 'utf8') {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Git is unavailable or the publication file list could not be read.');
  }
  return result.stdout;
}

export function checkPublication(cwd = process.cwd()) {
  let root;
  try {
    root = realpathSync(String(runGit(cwd, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    throw new Error('A readable Git worktree is required for the publication check.');
  }

  const raw = runGit(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], 'buffer');
  const paths = [...new Set(raw.toString('utf8').split('\0').filter(Boolean).map(normalizedPath))].sort();
  const findings = [];

  for (const path of paths) {
    const absolute = resolve(root, path);
    const fromRoot = relative(root, absolute);
    const escapedRoot = fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
    if (escapedRoot) {
      findings.push({ path, rule: 'path escapes repository' });
      continue;
    }

    const pathRule = FORBIDDEN_PATH_RULES.find(([rule, pattern]) => {
      if (rule === 'environment secret file' && publicEnvironmentExample(path)) return false;
      return pattern.test(path);
    });
    if (pathRule) findings.push({ path, rule: pathRule[0] });

    let stat;
    try { stat = lstatSync(absolute); } catch {
      findings.push({ path, rule: 'unreadable or missing file' });
      continue;
    }
    if (stat.isSymbolicLink()) {
      findings.push({ path, rule: 'symbolic link' });
      continue;
    }
    if (!stat.isFile()) {
      findings.push({ path, rule: 'unsupported file type' });
      continue;
    }

    let contents;
    try { contents = readFileSync(absolute); } catch {
      findings.push({ path, rule: 'unreadable file' });
      continue;
    }
    let text;
    try { text = publicationText(path, contents); } catch {
      findings.push({ path, rule: 'unsupported text encoding' });
      continue;
    }
    if (text === null) continue;
    for (const match of findCredentialMatches(text)) {
      findings.push({ path, line: lineAt(text, match.index), rule: match.rule });
    }
  }

  return { root, paths, findings };
}

export function formatFinding(finding) {
  const safePath = finding.path.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  const location = finding.line ? `${safePath}:${finding.line}` : safePath;
  return `${location} [${finding.rule}]`;
}

function main() {
  try {
    const result = checkPublication();
    if (result.findings.length) {
      process.stderr.write('Publication check failed:\n');
      for (const finding of result.findings) process.stderr.write(`- ${formatFinding(finding)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Publication check passed (${result.paths.length} files).\n`);
  } catch (error) {
    process.stderr.write(`Publication check failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
