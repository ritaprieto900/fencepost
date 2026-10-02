import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { acquire, check, createStore, inspect, release, tryAcquire } from '../src/index.ts';

const lock = (target: string) => ({ kind: 'lock', target }) as const;

function claimFiles(root: string, key: string): string[] {
  const dir = path.join(root, 'claims', key);
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

const genName = (seq: number): string => `g${String(seq).padStart(8, '0')}.json`;

/**
 * `release` writes its tombstone without an fsync, which is only defensible
 * because of where the garbage collection happens. These tests pin the
 * arrangement, because each half looks harmless alone and the failure only
 * appears when they are combined.
 *
 * The hazard: a sweep unlinks the released claim, and an unlink is no more
 * durable than a write. If the tombstone is then lost to a power failure *and*
 * the unlink survived, nothing is left on the volume, the next grantor numbers
 * from 1, and that is precisely the token the stale holder still carries -- so
 * its abandoned write would be accepted again. Sweeping only directly after a
 * durable claim became the maximum removes that possibility.
 */
test('release leaves a durable claim behind, so a lost tombstone cannot reset the fence', () => {
  let wall = 10_000;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-dur-'));
  const s = createStore(root, { now: () => wall, flush: false });
  const res = lock('durability');
  const key = s.resolver.key(res);

  const a = acquire(s, res, { ttlMs: 60_000, owner: 'a' });
  assert.equal(a.token, 1);
  release(s, a);

  // Both survive the release: the claim is *not* collected on the way out.
  assert.deepEqual(claimFiles(root, key), [genName(1), genName(2)]);

  // Simulate losing the tombstone entirely -- the worst outcome of no fsync.
  fs.rmSync(path.join(root, 'claims', key, genName(2)));

  const afterLoss = inspect(s, res);
  assert.equal(afterLoss.token, 1, 'the fence forgot that generation 1 was ever issued');
  assert.equal(afterLoss.live, true, 'a lost tombstone must fall back to a live claim, not to free');

  // So the resource is briefly blocked -- the bounded liveness cost that the
  // unswept claim buys the safety with.
  const blocked = tryAcquire(s, res, { ttlMs: 60_000, waitMs: 0, owner: 'b' });
  assert.equal(blocked.ok, false, 'a lost tombstone let a rival in immediately, meaning the claim was gone');

  wall += 60_001;
  const b = acquire(s, res, { ttlMs: 60_000, waitMs: 2_000, owner: 'b' });
  assert.ok(b.token > a.token, 'the successor did not move past the released holder');

  // The assertion the whole arrangement exists for.
  assert.equal(
    check(s, res, a.token),
    false,
    'a token issued before a lost tombstone was re-authorized -- numbering reset'
  );
  assert.equal(check(s, res, b.token), true);
});

/**
 * Garbage collection still has to happen somewhere, or a hot resource's
 * directory grows without limit. It belongs immediately after a durable claim
 * becomes the maximum, which is the only moment where collecting is provably
 * safe.
 */
test('the next acquire collects what release left behind', () => {
  let wall = 10_000;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-dur-'));
  const s = createStore(root, { now: () => wall, flush: false });
  const res = lock('bounded-growth');
  const key = s.resolver.key(res);

  for (let cycle = 0; cycle < 6; cycle++) {
    const lease = acquire(s, res, { ttlMs: 5_000, owner: `c${cycle}` });
    release(s, lease);
    wall += 5_001; // let it lapse so the next cycle is a fresh grant
    const files = claimFiles(root, key);
    assert.ok(
      files.length <= 2,
      `claim directory grew unboundedly at cycle ${cycle}: ${files.join(', ')}`
    );
  }
});

/**
 * The mirror case, recorded so nobody "optimizes" the wrong fsync away: losing a
 * *claim* is unsafe, not merely slow. Without its flush, the next grantor can
 * compute the same maximum and create the same generation number, and then two
 * running holders both present a token the store accepts.
 */
test('a claim whose file vanished would hand its exact number to a rival', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-dur-'));
  const s = createStore(root, { flush: false });
  const res = lock('reuse');
  const key = s.resolver.key(res);

  const holder = acquire(s, res, { ttlMs: 60_000, owner: 'holder' });
  // Simulate the *claim* being lost, which is the case the flush protects.
  fs.rmSync(path.join(root, 'claims', key, genName(holder.token)));

  const rival = acquire(s, res, { ttlMs: 60_000, waitMs: 1_000, owner: 'rival' });
  assert.equal(
    rival.token,
    holder.token,
    'expected the number to be reused, which is precisely why claims are flushed'
  );
  assert.equal(check(s, res, holder.token), true, 'and the stale holder is still authorized: two writers');
});
