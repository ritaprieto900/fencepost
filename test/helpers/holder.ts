/**
 * Child worker for the contention test.
 *
 * It performs the pattern the library exists for: take a lease, pass the token
 * through the fence gate, mutate the shared resource, release. Every mutation is
 * therefore legal only while this process is the current holder, which is what
 * makes the parent's audit meaningful -- see test/contention.test.ts.
 */

import * as fs from 'node:fs';

import { acquire, check, createStore, release } from '../../src/index.ts';
import { sleep } from '../../src/atomic.ts';

function arg(name: string): string {
  const value = process.argv[process.argv.indexOf(`--${name}`) + 1];
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

/** The protected resource: one append-only log, mutated only under the lease. */
function appendUnderLease(file: string, line: string): void {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeFileSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

const store = createStore(arg('store'));
const resource = { kind: 'lock', target: arg('resource') } as const;
const rounds = Number(arg('rounds'));
const holdMs = Number(arg('hold'));
const ttlMs = Number(arg('ttl'));
const out = arg('out');
const violations: string[] = [];

for (let round = 0; round < rounds; round++) {
  let lease;
  try {
    lease = acquire(store, resource, { ttlMs, waitMs: 20_000, owner: `w${process.pid}` });
  } catch (e) {
    violations.push(`acquire-timeout round=${round} ${String(e)}`);
    break;
  }

  // The gate: refuse to mutate unless the store still authorizes this token.
  if (!check(store, resource, lease.token)) {
    violations.push(`fence-refused-while-held round=${round} token=${lease.token}`);
    release(store, lease);
    continue;
  }

  appendUnderLease(out, `${lease.token}\t${process.pid}\t${lease.holderId}\t${round}\n`);
  sleep(holdMs);

  // Still authorized after the hold? If not, two processes were live at once,
  // which is exactly the bug this test exists to catch.
  if (!check(store, resource, lease.token)) {
    violations.push(`lost-during-hold round=${round} token=${lease.token}`);
  }

  release(store, lease);
}

for (const v of violations) process.stderr.write(`VIOLATION ${v}\n`);
process.exit(violations.length === 0 ? 0 : 17);
