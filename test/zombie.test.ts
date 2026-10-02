import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { acquire, check, createStore, inspect, release, renew } from '../src/index.ts';
import { sleep } from '../src/atomic.ts';

const HELPER = fileURLToPath(new URL('./helpers/staller.ts', import.meta.url));

function freshStore(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fencepost-zombie-'));
}

const lock = (target: string) => ({ kind: 'lock', target }) as const;

/**
 * The scenario that motivates the whole design.
 *
 * A holder stops renewing -- a stalled filesystem, a long GC pause, a laptop
 * that slept through a deadline -- gets its lease reclaimed, and then wakes up
 * still believing it holds the resource. It is running stale code and cannot be
 * trusted to notice. Nothing here asks it to cooperate: the fence refuses its
 * renew, refuses its write, and refuses to let its cleanup destroy the current
 * holder's claim.
 */
test('a reclaimed holder is fenced out of every path, not just the write', () => {
  const root = freshStore();
  const s = createStore(root);

  const zombie = acquire(s, lock('src/api.ts'), { ttlMs: 120, owner: 'zombie' });
  sleep(240); // longer than two missed renewals at ttl/3

  const live = acquire(s, lock('src/api.ts'), { ttlMs: 5_000, waitMs: 2_000, owner: 'successor' });
  assert.ok(live.token > zombie.token, 'the successor must be granted a newer fence number');

  const zombieRenew = renew(s, zombie);
  assert.equal(zombieRenew.status, 'lost', 'a reclaimed holder must not be able to extend');

  assert.equal(check(s, lock('src/api.ts'), zombie.token), false, 'zombie write must be refused');
  assert.equal(check(s, lock('src/api.ts'), live.token), true, 'successor write must be allowed');

  // The zombie now tries to clean up after "itself". This must be a no-op.
  release(s, zombie);
  const after = inspect(s, lock('src/api.ts'));
  assert.equal(after.holder, 'successor', 'a zombie release must not evict the current holder');
  assert.ok(after.token >= live.token);

  release(s, live);
});

/**
 * A hard kill is the honest test of a lease, and it has a cost that should be
 * stated rather than hidden: nobody inspects the dead process, so the resource
 * stays blocked for the remaining ttl. That window is the price of not trusting
 * liveness detection, and it is why ttl is a tuning knob rather than a formality.
 */
test('a SIGKILLed holder releases only when its lease expires', async () => {
  const root = freshStore();
  createStore(root);

  const child = spawn(process.execPath, [HELPER, '--store', root, '--ttl', '900'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const tokenLine = await new Promise<string>((resolve, reject) => {
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl >= 0) resolve(buf.slice(0, nl));
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error('child never reported its lease')), 8_000);
  });

  const deadToken = Number(tokenLine.trim());
  assert.ok(Number.isFinite(deadToken) && deadToken > 0, `bad token line: ${tokenLine}`);

  const started = Date.now();
  child.kill('SIGKILL');

  const s = createStore(root);
  const reclaimed = acquire(s, lock('held-by-dead-process'), {
    ttlMs: 5_000,
    waitMs: 8_000,
    owner: 'successor',
  });
  const waited = Date.now() - started;

  assert.ok(
    waited >= 600,
    `reclaimed after only ${waited}ms: something treated the dead pid as authority instead of the lease deadline`
  );
  assert.ok(reclaimed.token > deadToken, 'the successor must sit behind a newer fence number');
  assert.equal(check(s, lock('held-by-dead-process'), deadToken), false, 'the dead token must be retired');
  release(s, reclaimed);
});
