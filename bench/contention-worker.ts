/**
 * Contention worker for the benchmark: claim, hold, release, repeat, against one
 * shared resource. Prints the generation numbers it actually wrote under, so the
 * caller can confirm that the throughput it is quoting was produced by serialized
 * critical sections and not by two processes both thinking they held the thing.
 */

import { acquire, check, createStore, release } from '../src/index.ts';
import { sleep } from '../src/atomic.ts';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return value;
}

const store = createStore(arg('store'));
const rounds = Number(arg('rounds'));
const ttlMs = Number(arg('ttl', '5000'));
const tag = arg('tag', `pid${process.pid}`);
const holdMs = Number(arg('hold', '2'));

const resource = { kind: 'lock', target: 'hot' } as const;
const generations: number[] = [];
const violations: string[] = [];

for (let round = 0; round < rounds; round++) {
  let lease;
  try {
    lease = acquire(store, resource, { ttlMs, waitMs: 30_000, owner: tag });
  } catch (e) {
    violations.push(`acquire-timeout round=${round} ${String(e)}`);
    break;
  }
  if (!check(store, resource, lease.token)) {
    violations.push(`refused-while-held round=${round} token=${lease.token}`);
  } else {
    generations.push(lease.token);
  }
  sleep(holdMs);
  release(store, lease);
}

for (const v of violations) process.stderr.write(`${tag}: ${v}\n`);
process.stdout.write(`${tag} ${generations.join(' ')}\n`);
process.exit(violations.length === 0 ? 0 : 17);
