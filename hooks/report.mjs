// Claude Code hook: forwards the hook payload to the dev-dashboard. Fire-and-forget.
// Never prints, always exits 0.
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const payload = JSON.parse(await readStdin());
  if (payload && typeof payload === 'object') {
    payload.dd_where = process.env.CLAUDE_CODE_REMOTE === 'true' ? 'chmura' : 'lokalna';
    await fetch(process.env.DEV_DASHBOARD_URL ?? 'http://127.0.0.1:4317/hook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    });
  }
} catch {
  // swallow everything: a dashboard problem must never disturb Claude Code
}
process.exit(0);
