import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { acquire, check, createStore, inspect, release, renew, tryAcquire } from '../src/index.ts';
import type { Resource, Store } from '../src/index.ts';

function tmpStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fencepost-smoke-'));
  return createStore(root);
}

const file = (target: string): Resource => ({ kind: 'file', target });

test('acquire then a second acquire is refused', () => {
  const s = tmpStore();
  const lease = acquire(s, file('src/a.ts'), { ttlMs: 5000 });
  assert.equal(lease.token, 1);
  const second = tryAcquire(s, file('src/a.ts'), { ttlMs: 5000, waitMs: 0 });
  assert.equal(second.ok, false);
  release(s, lease);
});

test('release then re-acquire bumps the fence number', () => {
  const s = tmpStore();
  const a = acquire(s, file('src/b.ts'), { ttlMs: 5000 });
  release(s, a);
  const b = acquire(s, file('src/b.ts'), { ttlMs: 5000, waitMs: 1000 });
  assert.ok(b.token > a.token, `token should advance: ${a.token} -> ${b.token}`);
  assert.equal(check(s, file('src/b.ts'), b.token), true);
  assert.equal(check(s, file('src/b.ts'), a.token), false, 'stale token must be refused');
  release(s, b);
});

test('renew extends the lease for the current holder only', () => {
  const s = tmpStore();
  const lease = acquire(s, file('src/c.ts'), { ttlMs: 5000 });
  const before = lease.expiresAtMs;
  const out = renew(s, lease);
  assert.equal(out.status, 'renewed');
  if (out.status === 'renewed') assert.ok(out.expiresAtMs >= before);
  release(s, lease);
});

test('a reclaimed holder cannot renew', () => {
  const s = tmpStore();
  const stale = acquire(s, file('src/d.ts'), { ttlMs: 5000 });
  // Simulate being written around: a rival advances the fence and takes the claim.
  release(s, stale);
  const rival = acquire(s, file('src/d.ts'), { ttlMs: 5000, waitMs: 1000 });
  const out = renew(s, stale);
  assert.equal(out.status, 'lost');
  assert.ok(inspect(s, file('src/d.ts')).token >= rival.token);
  release(s, rival);
});
