#!/usr/bin/env node
/**
 * Verify the published artifact, not the source tree.
 *
 * Every other check in this repository runs against `src/*.ts` directly, which is
 * exactly why none of them said anything when the package turned out to be
 * uninstallable: Node refuses to strip types under `node_modules`, so the shipped
 * entry point was dead on arrival while 36 tests passed. This file packs the
 * tarball, installs it into a throwaway directory, and uses it the way a stranger
 * would.
 *
 * Run with `npm run verify:package`; it is also wired to prepublishOnly.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * npm is invoked as `node <npm-cli.js>`, not as `npm`.
 *
 * Spawning the bare name fails on Windows from inside Node: `npm` is `npm.cmd`, and
 * `spawn` without a shell does not consult PATHEXT, so the very first draft of this
 * file died with `spawnSync npx ENOENT`, then ran every remaining check against a
 * consumer directory that had never been created -- and reported the repository's
 * own node_modules as if it were the install under test. A verification harness that
 * can pass by measuring the wrong tree is worse than no harness.
 */
const NPM_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

function npm(args, cwd) {
  const r = spawnSync(process.execPath, [NPM_CLI, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) throw new Error(`npm ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`npm ${args.join(' ')} exited ${r.status}\n${(r.stderr ?? '').split('\n').slice(0, 6).join('\n')}`);
  }
  return r.stdout;
}

function node(args, cwd) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw new Error(`node ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) {
    // tsc reports diagnostics on stdout, not stderr, so a harness that only
    // forwards stderr loses exactly the information needed to act on the failure.
    const detail = [(r.stdout ?? '').trim(), (r.stderr ?? '').trim()].filter(Boolean).join('\n');
    throw new Error(`node ${args.join(' ')} exited ${r.status}\n${detail.split('\n').slice(0, 8).join('\n')}`);
  }
  return r.stdout.trim();
}

/* ------------------------------------------------------------------- setup */

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-verify-'));
const consumer = path.join(work, 'consumer');
let installed = '';
let tarball = '';

/**
 * Refuse to write anywhere that is not inside the throwaway directory.
 *
 * Not defensive paranoia: an earlier draft of this file assigned `consumer` only
 * after a step that then failed, leaving it an empty string, so
 * `writable('tsconfig.json')` resolved to the *repository* and
 * overwrote the real tsconfig.json. A harness that verifies a package should not
 * be able to edit the package it is verifying.
 */
function writable(name) {
  const p = path.resolve(consumer, name);
  if (!p.startsWith(path.resolve(work) + path.sep)) {
    throw new Error(`refusing to write outside the scratch directory: ${p}`);
  }
  return p;
}

function setup() {
  // Build first: the artifact under test is dist, and a stale dist would let this
  // pass while the source is broken.
  const built = spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'],
    { cwd: ROOT, encoding: 'utf8' }
  );
  if (built.status !== 0) throw new Error(`build failed:\n${built.stdout.split('\n').slice(0, 8).join('\n')}`);

  const listing = npm(['pack', '--pack-destination', work, '--silent'], ROOT).trim().split('\n').pop();
  tarball = path.join(work, listing);
  if (!fs.existsSync(tarball)) throw new Error(`npm pack reported "${listing}" which is not on disk`);

  fs.mkdirSync(consumer);
  fs.writeFileSync(
    writable('package.json'),
    JSON.stringify({ name: 'consumer', version: '1.0.0', type: 'module', private: true }, null, 2)
  );

  // --offline is the point: an install that needs the registry here is an install
  // that is pulling the optional server dependency into every library consumer.
  npm(['install', '--no-audit', '--no-fund', '--offline', '--silent', tarball], consumer);
  installed = path.join(consumer, 'node_modules', 'fencepost');
  if (!fs.existsSync(installed)) throw new Error('install produced no node_modules/fencepost');
}

/* ------------------------------------------------------------------ checks */

const results = [];

function check(name, fn) {
  let outcome;
  try {
    outcome = { ok: true, detail: fn() };
  } catch (e) {
    outcome = { ok: false, detail: String(e.message ?? e).split('\n').slice(0, 4).join(' | ') };
  }
  results.push({ name, ...outcome });
  console.log(outcome.ok ? `  PASS  ${name}\n          ${outcome.detail}` : `  FAIL  ${name}\n          ${outcome.detail}`);
}

try {
  setup();
  console.log(`packed ${(fs.statSync(tarball).size / 1024).toFixed(1)} kb, installed into a clean consumer offline\n`);
} catch (e) {
  console.error(`  FAIL  pack + install\n          ${String(e.message ?? e).split('\n').slice(0, 5).join('\n          ')}`);
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

check('the package ships compiled JS with declarations, not raw .ts', () => {
  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else acc.push(path.relative(installed, p).replace(/\\/g, '/'));
    }
    return acc;
  };
  const files = walk(installed);
  if (!files.includes('dist/index.js')) throw new Error(`dist/index.js absent; have: ${files.slice(0, 8).join(', ')}`);
  if (!files.includes('dist/index.d.ts')) throw new Error('dist/index.d.ts absent');
  const raw = files.filter((f) => /\.ts$/.test(f) && !f.endsWith('.d.ts'));
  if (raw.length > 0) throw new Error(`raw .ts shipped: ${raw.join(', ')}`);
  return `${files.length} files: ${files.filter((f) => f.startsWith('dist/')).length} in dist, none of them source`;
});

check('every declared entry point resolves on disk', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  const targets = [];
  const walk = (v) => {
    if (typeof v === 'string') targets.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(pkg.exports);
  walk(pkg.bin);
  walk(pkg.main);
  walk(pkg.types);
  const missing = targets.filter((t) => !fs.existsSync(path.join(installed, t)));
  if (missing.length > 0) throw new Error(`dangling: ${missing.join(', ')}`);
  return `${targets.length} targets, all present`;
});

check('a JS consumer can import the library and the fence works there', () => {
  fs.writeFileSync(
    writable('use.mjs'),
    [
      "import { createStore, acquire, check, release } from 'fencepost';",
      "const s = createStore('.fp');",
      "const r = { kind: 'lock', target: 'db:migrations' };",
      'const a = acquire(s, r, { ttlMs: 5000, owner: "one" });',
      'if (!check(s, r, a.token)) throw new Error("own token refused");',
      'release(s, a);',
      'const b = acquire(s, r, { ttlMs: 5000, owner: "two" });',
      'if (!(b.token > a.token)) throw new Error("fence did not advance: " + a.token + " -> " + b.token);',
      'if (check(s, r, a.token)) throw new Error("stale token still authorized");',
      'release(s, b);',
      "console.log('acquired at ' + a.token + ', successor at ' + b.token + ', stale token refused');",
    ].join('\n')
  );
  return node(['use.mjs'], consumer);
});

check('the entry point works with the MCP SDK absent entirely', () => {
  // What makes the peer dependency optional in fact rather than in wording: if the
  // main entry reached the server module, this would throw ERR_MODULE_NOT_FOUND.
  fs.writeFileSync(
    writable('no-sdk.mjs'),
    ["import { createStore } from 'fencepost';", "createStore('.fp-no-sdk');", "console.log('imported with no SDK installed');"].join('\n')
  );
  return node(['no-sdk.mjs'], consumer);
});

check('installing the library pulls no web framework', () => {
  const present = fs.readdirSync(path.join(consumer, 'node_modules'));
  const offenders = present.filter((n) =>
    ['express', 'hono', 'cors', 'jose', 'zod', '@modelcontextprotocol'].includes(n)
  );
  if (offenders.length > 0) throw new Error(`server-only deps installed: ${offenders.join(', ')}`);
  return `consumer tree contains ${present.length} entr(ies): ${present.join(', ') || 'none (zero deps)'}`;
});

check('the installed CLI runs and returns valid JSON', () => {
  const out = node([path.join(installed, 'dist', 'cli.js'), 'status', '--json'], consumer);
  JSON.parse(out || '[]');
  return `fencepost status --json -> ${out}`;
});

check('a TypeScript consumer resolves and is actually constrained by the published types', () => {
  const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const write = (name, body, file) => {
    fs.writeFileSync(writable(name), body.join('\n'));
    fs.writeFileSync(
      writable('tsconfig.json'),
      JSON.stringify({
        compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', strict: true, noEmit: true, target: 'es2023', skipLibCheck: true },
        files: [file],
      })
    );
  };

  // First: the honest usage must compile. Without this half, a check that only
  // demands "tsc complains" passes when the types are missing altogether.
  const good = [
    "import { acquire, createStore, check, release, type Lease, type Resource } from 'fencepost';",
    'const store = createStore(\'.fp\');',
    'const r: Resource = { kind: \'lock\', target: \'x\' };',
    'const lease: Lease = acquire(store, r, { ttlMs: 1000 });',
    'const n: number = lease.token;',
    'const live: boolean = check(store, r, n);',
    'if (live) release(store, lease);',
    'void n;',
  ];
  write('typed-good.ts', good, 'typed-good.ts');
  node([TSC, '-p', writable('tsconfig.json')], consumer);

  // Then: a wrong assignment must be rejected, proving the .d.ts carries real
  // structure rather than collapsing to `any`.
  write('typed-bad.ts', [...good, 'const bad: string = lease.token;', 'void bad;'], 'typed-bad.ts');
  let err = '';
  try {
    node([TSC, '-p', writable('tsconfig.json')], consumer);
    throw new Error('tsc accepted `const bad: string = lease.token` -- the published types are not real');
  } catch (e) {
    err = String(e.message);
  }
  if (!/TS2322/.test(err)) {
    throw new Error(`tsc failed, but not with an assignability error, so it may be failing for the wrong reason:\n${err}`);
  }
  return 'valid usage compiles; `string = lease.token` rejected with TS2322';
});

check('LICENSE and README ship inside the package', () => {
  for (const f of ['LICENSE', 'README.md']) {
    if (!fs.existsSync(path.join(installed, f))) throw new Error(`${f} missing`);
  }
  return 'LICENSE + README.md present';
});

/* ------------------------------------------------------------------ report */

fs.rmSync(work, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('failed: ' + failed.map((f) => f.name).join('; '));
  process.exit(1);
}
