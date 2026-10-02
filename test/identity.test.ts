import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createStore, acquire, release, tryAcquire } from '../src/index.ts';
import { keyOf, normalizeFile } from '../src/key.ts';

function freshStore(now?: () => number): ReturnType<typeof createStore> {
  return createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'fencepost-key-')), { now });
}

/**
 * A lease is only as strong as the equality test behind it. If two spellings of
 * the same path produce two keys, two agents each get a lease the library
 * considers uncontested, and no amount of fencing fixes that -- the fence is
 * per key.
 */
test(
  'win32 path aliases collapse to one identity',
  { skip: process.platform !== 'win32' ? 'needs win32 path semantics' : false },
  () => {
    const cwd = 'C:\\repo';
    const spellings = [
      'C:\\repo\\src\\a.ts',
      'c:\\repo\\src\\A.TS',
      'C:/repo/src/a.ts',
      'c:/REPO/src/../src/a.ts',
      'src\\a.ts',
      'C:\\repo\\src\\a.ts\\',
    ];
    const keys = new Set(spellings.map((p) => keyOf({ kind: 'file', target: p }, cwd, 'win32')));
    assert.equal(keys.size, 1, `aliases split into ${keys.size} keys: ${[...keys].join(', ')}`);

    const s = freshStore();
    const lease = acquire(s, { kind: 'file', target: 'C:\\repo\\src\\a.ts' }, { ttlMs: 5_000 });
    // The same file reached by a rival spelling must be refused.
    const rival = tryAcquire(s, { kind: 'file', target: 'c:/repo/SRC/A.TS' }, { ttlMs: 5_000, waitMs: 0 });
    assert.equal(rival.ok, false, 'a differently spelled alias slipped past the lock');
    release(s, lease);
  }
);

test('distinct resources stay distinct, and drive-letter case is folded', () => {
  const cwd = 'C:\\repo';
  const k = (t: string) => keyOf({ kind: 'file', target: t }, cwd, 'win32');
  assert.notEqual(k('C:\\repo\\a.ts'), k('C:\\repo\\b.ts'));
  assert.notEqual(k('C:\\repo\\a.ts'), k('D:\\repo\\a.ts'));
  assert.equal(normalizeFile('c:\\repo\\a.ts', cwd, 'win32'), normalizeFile('C:\\repo\\A.TS', cwd, 'win32'));
});

test('lock resources are namespaced apart from file resources', () => {
  const cwd = process.cwd();
  const asFile = keyOf({ kind: 'file', target: 'migrations' }, cwd, process.platform);
  const asLock = keyOf({ kind: 'lock', target: 'migrations' }, cwd, process.platform);
  assert.notEqual(asFile, asLock, 'a named lock must never collide with a path claim');
});

test('posix paths keep case sensitivity', () => {
  const k = (t: string) => keyOf({ kind: 'file', target: t }, '/repo', 'posix');
  assert.notEqual(k('/repo/a.ts'), k('/repo/A.TS'), 'posix volumes are case-sensitive');
  assert.equal(k('/repo/a.ts'), k('/repo/sub/../a.ts'));
});

/**
 * Expiry is decided by the lease deadline and nothing else. This test also pins
 * the deliberately conservative half of that rule: when the clock steps
 * backwards, an expiry we cannot compute is treated as still live, because
 * wrongly blocking one agent is recoverable and wrongly freeing one is not.
 */
test('a backwards clock step must not expire a live lease', () => {
  let wall = 10_000;
  const s = freshStore(() => wall);
  const lease = acquire(s, { kind: 'lock', target: 'clock' }, { ttlMs: 5_000, owner: 'a' });

  wall -= 4_000; // manual set, DST correction, or an NTP step
  const during = tryAcquire(s, { kind: 'lock', target: 'clock' }, { ttlMs: 5_000, waitMs: 0, owner: 'b' });
  assert.equal(during.ok, false, 'a backwards clock let a rival reclaim a live lease');
  assert.equal(lease.token, 1);

  wall = 10_000 + 5_001; // now genuinely past the deadline
  const after = tryAcquire(s, { kind: 'lock', target: 'clock' }, { ttlMs: 5_000, waitMs: 1_000, owner: 'b' });
  assert.equal(after.ok, true, 'an expired lease was still blocking');
  if (after.ok) assert.ok(after.lease.token > lease.token);
});
