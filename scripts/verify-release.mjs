// Checks what Firefox will actually fetch: the `update_url` must serve the given
// version and the .xpi it links to must match `update_hash`. GitHub's
// `releases/latest` redirect can lag a new release by a couple of minutes, so
// this polls.
//
//   node scripts/verify-release.mjs 0.1.2
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export async function verifyRelease(version, { timeoutMs = 6 * 60_000, intervalMs = 10_000, log = console.log } = {}) {
  const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../manifest.json'), 'utf8'));
  const { id, update_url: url } = manifest.browser_specific_settings.gecko;
  const deadline = Date.now() + timeoutMs;
  let seen = 'nothing';
  for (;;) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      const entry = res.ok ? (await res.json()).addons?.[id]?.updates?.[0] : null;
      seen = entry?.version ?? `HTTP ${res.status}`;
      if (entry?.version === version) {
        const xpi = Buffer.from(await (await fetch(entry.update_link)).arrayBuffer());
        const got = `sha256:${createHash('sha256').update(xpi).digest('hex')}`;
        if (got !== entry.update_hash) throw new Error(`published .xpi hash ${got} does not match update_hash ${entry.update_hash}`);
        log(`ok: ${url} serves ${version}; ${entry.update_link} matches its hash`);
        return entry;
      }
    } catch (e) {
      if (/does not match/.test(e.message)) throw e; // a real mismatch, not a network blip
      seen = e.message;
    }
    if (Date.now() > deadline) throw new Error(`${url} still serves ${seen}, not ${version}, after ${Math.round(timeoutMs / 1000)}s`);
    log(`waiting for ${url} to serve ${version} (now: ${seen})...`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyRelease(process.argv[2]).catch((e) => { console.error(e.message); process.exit(1); });
}
