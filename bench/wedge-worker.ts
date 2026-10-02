/**
 * Wedged-holder worker for the benchmark.
 *
 * Two roles, run as two separate OS processes. That separation is the entire
 * point: the staleness mechanism being measured lives in the holder's event loop,
 * so stalling the *same* process stalls the contender too and nothing is proven.
 * A real wedge -- a page fault, a debugger pause, a machine that slept -- stops
 * one process and leaves the others running.
 */

import * as fs from 'node:fs';

import { acquire, check, createStore, renew } from '../src/index.ts';

const flag = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
};

const role = flag('role');
const optional = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? '' : (process.argv[i + 1] ?? '');
};
const block = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// Read lazily: the incumbent roles take --target and the fencepost roles take
// --store, and requiring either up front makes the other role fail at import.
const target = () => optional('target');
const storePath = () => optional('store');

if (role === 'incumbent-holder') {
  const lockfile = await import('proper-lockfile');
  const lock = lockfile.default ?? lockfile;
  let compromised = false;
  const release = await lock.lock(target(), {
    stale: 5_000,
    update: 1_000,
    retries: 0,
    onCompromised: () => {
      compromised = true;
    },
  });
  process.stdout.write('LOCKED\n');
  block(9_000); // longer than stale, so the refresh definitely stopped arriving

  // Observe the lockfile on both sides of the release. Without this, a successful
  // `release()` is ambiguous: it may have torn down a live lock belonging to
  // another process, or it may have cleaned up a file that was already gone.
  const lockPath = `${target()}.lock`;
  const before = fs.existsSync(lockPath);
  const outcome = await release().then(
    () => 'released',
    (e: Error) => `release threw: ${e.message.split('\n')[0] ?? 'unknown'}`
  );
  const after = fs.existsSync(lockPath);
  process.stdout.write(
    `COMPROMISED=${compromised} RELEASE=${outcome} LOCKFILE_BEFORE=${before} LOCKFILE_AFTER=${after}\n`
  );
} else if (role === 'incumbent-rival') {
  const lockfile = await import('proper-lockfile');
  const lock = lockfile.default ?? lockfile;
  try {
    const release = await lock.lock(target(), { stale: 5_000, retries: 0 });
    process.stdout.write('STOLEN\n');
    // Hold the lock rather than releasing on the way out: if the rival let go
    // first, the original holder's later `release()` would be acting on a missing
    // file and the observation would prove nothing about whose lock it removed.
    block(Number(flag('hold')));
    await release();
    process.stdout.write('RIVAL_RELEASED\n');
  } catch (e) {
    process.stdout.write(`REFUSED: ${(e as Error).message.split('\n')[0] ?? 'unknown'}\n`);
  }
} else if (role === 'fencepost-holder') {
  const store = createStore(storePath());
  const resource = { kind: 'lock', target: 'wedge' } as const;
  const lease = acquire(store, resource, { ttlMs: 5_000, owner: 'zombie' });
  process.stdout.write(`LOCKED token=${lease.token}\n`);
  block(9_000); // outlives its own ttl by design
  const authorized = check(store, resource, lease.token);
  const renewed = renew(store, lease);
  process.stdout.write(`AFTER_RESUME check=${authorized} renew=${renewed.status}\n`);
} else if (role === 'fencepost-rival') {
  const store = createStore(storePath());
  const resource = { kind: 'lock', target: 'wedge' } as const;
  // Blocks until the wedged holder's lease expires, which is the point: the
  // successor gets in on the deadline, not on a corpse.
  const out = acquire(store, resource, { ttlMs: 30_000, waitMs: 60_000, owner: 'successor' });
  process.stdout.write(`TOOK token=${out.token}\n`);
}
