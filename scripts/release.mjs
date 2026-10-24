#!/usr/bin/env node
// Build, sign (Mozilla "unlisted" channel) and publish a release.
//
//   npm run release -- patch|minor|major   bump the version first, then release
//   npm run release -- none                release the version already in manifest.json
//
// Firefox installs update from the `updates.json` attached to the latest GitHub
// release (manifest.json -> browser_specific_settings.gecko.update_url).
// Credentials: WEB_EXT_API_KEY / WEB_EXT_API_SECRET in the environment, or
// AMO_JWT_ISSUER / AMO_JWT_SECRET in ~/.config/amazon-power-search/amo.env.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { verifyRelease } from './verify-release.mjs';

const REPO = 'ssjrocks/amazon-power-search';
const root = path.resolve(import.meta.dirname, '..');
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
};
const readJson = (f) => JSON.parse(readFileSync(path.join(root, f), 'utf8'));
const writeJson = (f, v) => writeFileSync(path.join(root, f), JSON.stringify(v, null, 2) + '\n');
const die = (m) => { console.error(`\nrelease: ${m}`); process.exit(1); };

function credentials() {
  if (process.env.WEB_EXT_API_KEY && process.env.WEB_EXT_API_SECRET) {
    return { WEB_EXT_API_KEY: process.env.WEB_EXT_API_KEY, WEB_EXT_API_SECRET: process.env.WEB_EXT_API_SECRET };
  }
  const f = path.join(homedir(), '.config/amazon-power-search/amo.env');
  if (!existsSync(f)) die(`no credentials: set WEB_EXT_API_KEY/SECRET or create ${f}`);
  const kv = Object.fromEntries(readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
  if (!kv.AMO_JWT_ISSUER || !kv.AMO_JWT_SECRET) die(`${f} needs AMO_JWT_ISSUER and AMO_JWT_SECRET`);
  return { WEB_EXT_API_KEY: kv.AMO_JWT_ISSUER, WEB_EXT_API_SECRET: kv.AMO_JWT_SECRET };
}

const bumpArg = process.argv[2] || 'none';
if (!['patch', 'minor', 'major', 'none'].includes(bumpArg)) die('usage: release.mjs patch|minor|major|none');

// ---- preconditions (before touching any file) ----
if (out('git', ['branch', '--show-current']) !== 'main') die('releases are made from main');
if (out('git', ['status', '--porcelain'])) die('working tree is not clean');
out('git', ['fetch', '-q', 'origin']);
if (out('git', ['rev-parse', 'HEAD']) !== out('git', ['rev-parse', 'origin/main'])) die('main differs from origin/main (pull or push first)');
const env = credentials();
out('gh', ['auth', 'status']);

const manifest = readJson('manifest.json');
let version = manifest.version;
if (bumpArg !== 'none') {
  const [a, b, c] = version.split('.').map(Number);
  version = { patch: [a, b, c + 1], minor: [a, b + 1, 0], major: [a + 1, 0, 0] }[bumpArg].join('.');
}
const tag = `v${version}`;
if (out('git', ['tag', '-l', tag])) die(`tag ${tag} already exists (versions can't be reused: Mozilla refuses to sign them twice)`);

const revert = () => spawnSync('git', ['checkout', '--', 'manifest.json', 'package.json', 'package-lock.json'], { cwd: root });
try {
  if (version !== manifest.version) {
    manifest.version = version;
    writeJson('manifest.json', manifest);
    const pkg = readJson('package.json'); pkg.version = version; writeJson('package.json', pkg);
    const lock = readJson('package-lock.json'); lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
    writeJson('package-lock.json', lock);
  }

  console.log(`\n== ${tag}: test + lint ==`);
  run('npm', ['test']);
  run('npx', ['web-ext', 'lint']);

  console.log(`\n== ${tag}: sign with Mozilla (unlisted; usually 1-3 minutes) ==`);
  const art = path.join(root, 'web-ext-artifacts');
  rmSync(art, { recursive: true, force: true });
  run('npx', ['web-ext', 'sign', '--approval-timeout', '600000'], env);
  const signed = readdirSync(art).find((f) => f.endsWith('.xpi'));
  if (!signed) throw new Error('web-ext sign produced no .xpi');

  const dist = path.join(root, 'dist');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist);
  const xpiName = `amazon-power-search-${version}.xpi`;
  copyFileSync(path.join(art, signed), path.join(dist, xpiName));
  const hash = createHash('sha256').update(readFileSync(path.join(dist, xpiName))).digest('hex');
  const gecko = manifest.browser_specific_settings.gecko;
  const updates = {
    addons: {
      [gecko.id]: {
        updates: [{
          version,
          update_link: `https://github.com/${REPO}/releases/download/${tag}/${xpiName}`,
          update_hash: `sha256:${hash}`,
          applications: { gecko: { strict_min_version: gecko.strict_min_version } },
        }],
      },
    },
  };
  writeFileSync(path.join(dist, 'updates.json'), JSON.stringify(updates, null, 2) + '\n');

  console.log(`\n== ${tag}: commit, tag, publish ==`);
  if (bumpArg !== 'none') {
    run('git', ['add', 'manifest.json', 'package.json', 'package-lock.json']);
    run('git', ['commit', '-q', '-m', `Release ${tag}`]);
  }
  run('git', ['tag', tag]);
  run('git', ['push', '-q', 'origin', 'main', tag]);
  const prev = out('git', ['tag', '--sort=-v:refname']).split('\n').find((t) => t !== tag);
  const notes = out('git', ['log', '--format=- %s', prev ? `${prev}..${tag}` : tag]).replace(/^- Release v.*\n?/gm, '') || 'Maintenance release.';
  run('gh', ['release', 'create', tag, path.join(dist, xpiName), path.join(dist, 'updates.json'),
    '--repo', REPO, '--title', tag, '--notes', notes, '--latest']);

  console.log(`\n== ${tag}: verify what Firefox will fetch ==`);
  await verifyRelease(version);
} catch (e) {
  revert();
  console.error(`\nrelease failed: ${e.message}`);
  console.error('If the tag or release was already created, check `git tag -l`, `gh release list` before retrying.');
  process.exit(1);
}
