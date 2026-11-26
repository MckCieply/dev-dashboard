import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd'];
const WITH_MATCHER = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);

const fwd = (p) => String(p).replace(/\\/g, '/');

export function hookCommand(reportPath) {
  return `node "${fwd(reportPath)}"`;
}

const isOurs = (entry, reportPath) =>
  Array.isArray(entry?.hooks) &&
  entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(fwd(reportPath)));

export function removeHooks(settings, reportPath) {
  const out = structuredClone(settings ?? {});
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  for (const [event, entries] of Object.entries(out.hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = [];
    for (const entry of entries) {
      if (!isOurs(entry, reportPath)) { kept.push(entry); continue; }
      const rest = entry.hooks.filter((h) => !(typeof h?.command === 'string' && h.command.includes(fwd(reportPath))));
      if (rest.length) kept.push({ ...entry, hooks: rest });
    }
    if (kept.length) out.hooks[event] = kept; else delete out.hooks[event];
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

export function addHooks(settings, reportPath) {
  const out = removeHooks(settings, reportPath);
  out.hooks ??= {};
  const command = hookCommand(reportPath);
  for (const event of EVENTS) {
    const entry = { hooks: [{ type: 'command', command, timeout: 5 }] };
    if (WITH_MATCHER.has(event)) entry.matcher = '*';
    const ordered = WITH_MATCHER.has(event) ? { matcher: '*', hooks: entry.hooks } : entry;
    out.hooks[event] = [...(out.hooks[event] ?? []), ordered];
  }
  return out;
}

// Line diff of two settings objects: "- " removed, "+ " added, unchanged lines omitted.
export function diffSettings(before, after) {
  const a = JSON.stringify(before ?? {}, null, 2).split('\n');
  const b = JSON.stringify(after ?? {}, null, 2).split('\n');
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0; let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) out.push(`+ ${b[j++]}`);
    else out.push(`- ${a[i++]}`);
  }
  return out.join('\n');
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const settingsPath = arg('--settings') ?? path.join(os.homedir(), '.claude', 'settings.json');
  const uninstall = argv.includes('--uninstall');
  const reportPath = fwd(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'report.mjs'));

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
    catch (e) { console.error(`Not valid JSON, leaving untouched: ${settingsPath} (${e.message})`); return 1; }
  }
  const next = uninstall ? removeHooks(settings, reportPath) : addHooks(settings, reportPath);
  console.log(`${uninstall ? 'Remove' : 'Add'} hooks for: ${EVENTS.join(', ')}`);
  console.log(`Settings: ${settingsPath}\nReport script: ${reportPath}`);

  const diff = diffSettings(settings, next);
  console.log(diff ? `\nChanges:\n${diff}\n` : '\nNo changes.\n');

  if (!argv.includes('--yes')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Apply? [y/N] ');
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) { console.log('Aborted.'); return 0; }
  }
  if (fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  } else {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n');
  console.log('Done.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
