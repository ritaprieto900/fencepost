import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: stdout.trim(), stderr }));
  });
}

function tempStore(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fp-cli-'));
}

/** The documented shape is `fencepost <command> [flags]`, so build calls that way. */
function call(store: string, command: string, ...args: string[]) {
  return cli([command, '--store', store, ...args]);
}

/**
 * The exit codes are the interface an agent actually consumes -- a wrapper that
 * always exits 0 tells its caller nothing about whether the resource was taken.
 * So they are asserted rather than eyeballed, along with the guard the whole tool
 * depends on: a stale token is refused.
 */
test('claim, refuse a rival, verify the token, release', async () => {
  const s = tempStore();

  const first = await call(s, 'claim', '--lock', 'db:migrations', '--ttl', '60000', '--owner', 'a');
  assert.equal(first.code, 0, first.stderr);
  const token = Number(first.stdout);
  assert.ok(Number.isInteger(token) && token >= 1, `expected a token, got ${JSON.stringify(first.stdout)}`);

  const rival = await call(s, 'claim', '--lock', 'db:migrations', '--ttl', '60000');
  assert.equal(rival.code, 3, 'a held resource must not report success');
  assert.match(rival.stdout, /held by a/);

  assert.equal((await call(s, 'check', '--lock', 'db:migrations', String(token))).code, 0);
  const stale = await call(s, 'check', '--lock', 'db:migrations', String(token + 1000));
  assert.equal(stale.code, 3, 'a stale token was accepted');
  assert.match(stale.stdout, /stale/);

  const released = await call(s, 'release', '--lock', 'db:migrations', String(token));
  assert.equal(released.code, 0, released.stdout + released.stderr);

  const after = await call(s, 'claim', '--lock', 'db:migrations', '--ttl', '60000');
  assert.equal(after.code, 0, 'the resource stayed taken after release');
  assert.ok(
    Number(after.stdout) > token,
    `re-acquire must advance the fence: ${token} -> ${after.stdout}`
  );
});

test('release refuses to evict a holder it is not', async () => {
  const s = tempStore();
  const mine = await call(s, 'claim', '--lock', 'port:3000', '--ttl', '60000', '--owner', 'owner-a');
  const token = Number(mine.stdout);

  // The wrong token must not free somebody else's resource.
  const wrong = await call(s, 'release', '--lock', 'port:3000', String(token + 7));
  assert.equal(wrong.code, 3);
  assert.equal((await call(s, 'check', '--lock', 'port:3000', String(token))).code, 0);

  // A file claim and a lock claim of the same string are different resources.
  const asFile = await call(s, 'claim', '--file', 'port:3000', '--ttl', '60000');
  assert.equal(asFile.code, 0, 'a named lock blocked a path claim on the same string');
});

test('run keeps the lease held for the whole life of the child', async () => {
  const s = tempStore();

  const running = call(s, 'run', '--lock', 'migrate', '--ttl', '4000', '--', 'node', '-e', 'setTimeout(()=>{}, 2500)');

  await new Promise((r) => setTimeout(r, 400));
  const during = await call(s, 'claim', '--lock', 'migrate', '--ttl', '4000');
  assert.equal(during.code, 3, 'the lease was not held while the child ran');

  const done = await running;
  assert.equal(done.code, 0, done.stderr);
  const after = await call(s, 'claim', '--lock', 'migrate', '--ttl', '4000');
  assert.equal(after.code, 0, 'the lease outlived its child');
  await call(s, 'release', '--lock', 'migrate', after.stdout);
});

test('run propagates the child exit code, and still releases', async () => {
  const s = tempStore();
  const out = await call(s, 'run', '--lock', 'failing', '--ttl', '4000', '--', 'node', '-e', 'process.exit(42)');
  assert.equal(out.code, 42, `child exit code was swallowed: ${out.code} ${out.stderr}`);

  const after = await call(s, 'claim', '--lock', 'failing', '--ttl', '4000');
  assert.equal(after.code, 0, 'a failed child left the resource claimed');
  await call(s, 'release', '--lock', 'failing', after.stdout);
});

test('status lists claims with their labels rather than bare hashes', async () => {
  const s = tempStore();
  await call(s, 'claim', '--lock', 'db:migrations', '--ttl', '60000', '--owner', 'named');
  const out = await call(s, 'status');
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /db:migrations/, `label missing from:\n${out.stdout}`);
  assert.match(out.stdout, /owner=named/);

  const empty = await call(tempStore(), 'status');
  assert.match(empty.stdout, /no claims/);
});

test('bad input is an error, not a silent no-op', async () => {
  const s = tempStore();
  const noResource = await call(s, 'claim', '--ttl', '5000');
  assert.equal(noResource.code, 1);
  assert.match(noResource.stderr, /--file|--lock/);

  assert.equal((await call(s, 'claim', '--file', 'a.ts', '--lock', 'x')).code, 1);
  assert.equal((await call(s, 'frobnicate')).code, 1);

  // A leading flag is the most likely mistyping, and it should say so plainly.
  const misordered = await cli(['--store', s, 'claim', '--lock', 'x']);
  assert.equal(misordered.code, 1);
  assert.match(misordered.stderr, /command must come first/);
});
