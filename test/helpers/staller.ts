/**
 * Takes a lease, reports its fence number, then hangs without renewing until it
 * is killed. This is the "agent got SIGKILLed mid-edit" case, and notably it is
 * *not* detected by anything -- no heartbeat, no exit hook, no PID check. The
 * only thing that frees the resource is the lease deadline.
 */

import { acquire, createStore } from '../../src/index.ts';
import { sleep } from '../../src/atomic.ts';

function arg(name: string): string {
  const value = process.argv[process.argv.indexOf(`--${name}`) + 1];
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

const store = createStore(arg('store'));
const lease = acquire(store, { kind: 'lock', target: 'held-by-dead-process' }, {
  ttlMs: Number(arg('ttl')),
  owner: 'doomed',
});

process.stdout.write(`${lease.token}\n`);
sleep(60_000);
