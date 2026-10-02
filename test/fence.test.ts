import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { acquire, check, createStore, inspect, keyOf, release, sweepStale, tryAcquire } from '../src/index.ts';
import { sleep } from '../src/atomic.ts';

type Store = ReturnType<typeof createStore>;

const lock = (target: string) => ({ kind: 'lock', target }) as const;

function fresh(): Store {
  return createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'fencepost-fence-')));
}

const genName = (seq: number): string => `g${String(seq).padStart(8, '0')}.json`;

function claimDir(s: Store, target: string): string {
  return path.join(s.root, 'claims', keyOf(lock(target), s.cwd, s.platform));
}

function forged(seq: number): string {
  return JSON.stringify({
    v: 1,
    resource: 'unused',
    holderId: 'forged',
    token: seq,
    grantedAtMs: 1,
    expiresAtMs: 1,
    ttlMs: 1,
    pid: 1,
    owner: 'forged',
  });
}

/**
 * The newest claim is the only memory the fence has of how high the numbers have
 * gone. If a torn or truncated record made the protocol treat it as absent, the
 * next grantor would restart low -- and some zombie's already-issued token would
 * quietly become current again.
 *
 * So a corrupt newest claim must be *superseded*, never *reset*.
 */
test('a corrupt newest claim is superseded, never restarted from zero', () => {
  const s = fresh();
  const first = acquire(s, lock('src/db.ts'), { ttlMs: 60, owner: 'a' });
  sleep(120);

  const dir = claimDir(s, 'src/db.ts');
  assert.deepEqual(fs.readdirSync(dir), [genName(first.token)]);
  fs.writeFileSync(path.join(dir, genName(first.token)), '{trunc');

  const second = acquire(s, lock('src/db.ts'), { ttlMs: 60_000, waitMs: 2_000, owner: 'b' });
  assert.ok(
    second.token > first.token,
    `numbering restarted after corruption: ${first.token} -> ${second.token}`
  );
  assert.equal(check(s, lock('src/db.ts'), first.token), false, 'the dead token became current again');
  assert.equal(check(s, lock('src/db.ts'), second.token), true);
});

/**
 * Releasing must not lower the fence. Handing a resource back and taking it
 * again has to move strictly forward, or every release re-arms the tokens of
 * everyone who held it before.
 */
test('release frees the resource without ever lowering the fence', () => {
  const s = fresh();
  const a = acquire(s, lock('migrations'), { ttlMs: 60_000, owner: 'a' });
  assert.equal(check(s, lock('migrations'), a.token), true);

  release(s, a);

  const b = tryAcquire(s, lock('migrations'), { ttlMs: 60_000, waitMs: 0, owner: 'b' });
  assert.equal(b.ok, true, 'a released resource must be immediately contendable');
  if (!b.ok) return;
  assert.ok(b.lease.token > a.token, `release lowered the fence: ${a.token} -> ${b.lease.token}`);
  assert.equal(
    check(s, lock('migrations'), a.token),
    false,
    'the previous holder can still write after releasing'
  );

  release(s, b.lease);
  const c = acquire(s, lock('migrations'), { ttlMs: 60_000, waitMs: 2_000, owner: 'c' });
  assert.ok(c.token > b.lease.token);
});

/**
 * Sweeping exists so one hot resource's directory cannot grow without bound. The
 * one thing it must never take is the newest claim, since that file *is* the
 * fence's memory. This pins the boundary deliberately: a sweep that feels like
 * "just cleanup" is exactly how a safety invariant gets deleted later.
 */
test('sweep removes superseded claims and keeps the newest', () => {
  const s = fresh();
  const lease = acquire(s, lock('hot'), { ttlMs: 60_000, owner: 'a' });
  const dir = claimDir(s, 'hot');
  const forgedSeqs = [1, 2, 3].filter((seq) => seq < lease.token);
  for (const seq of forgedSeqs) fs.writeFileSync(path.join(dir, genName(seq)), forged(seq));

  const removed = sweepStale(s, lock('hot'));
  assert.equal(removed, forgedSeqs.length);
  assert.deepEqual(fs.readdirSync(dir), [genName(lease.token)]);
  assert.equal(check(s, lock('hot'), lease.token), true, 'sweep invalidated a live lease');

  // And the fence still remembers the high-water mark after the cleanup.
  release(s, lease);
  const next = acquire(s, lock('hot'), { ttlMs: 60_000, waitMs: 2_000, owner: 'b' });
  assert.ok(next.token > lease.token, 'cleanup reset the fence');
});

test('inspect reports who holds a resource and whether it is taken', () => {
  const s = fresh();
  const lease = acquire(s, lock('status'), { ttlMs: 60_000, owner: 'whoever' });
  const during = inspect(s, lock('status'));
  assert.equal(during.holder, 'whoever');
  assert.equal(during.live, true);
  assert.equal(during.token, lease.token);

  release(s, lease);
  const after = inspect(s, lock('status'));
  assert.equal(after.live, false, 'a released resource still reads as taken');
  assert.ok(after.token >= lease.token, 'release must not lower the fence');
});
