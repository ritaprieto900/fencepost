#!/usr/bin/env node
/**
 * Benchmark and safety comparison. The output file is generated, never typed:
 * hand-copied numbers rot silently, and a table nobody can re-run is decoration.
 *
 *   node bench/bench.ts            # regenerate bench/RESULTS.md
 *
 * Read the caveats section it emits before quoting any number from it. One
 * machine, one SSD, one antivirus configuration, one afternoon.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { acquire, check, createStore, release, renew, tryAcquire } from '../src/index.ts';
import type { Store } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'RESULTS.md');
const WORKER = path.join(HERE, 'contention-worker.ts');
const WEDGE = path.join(HERE, 'wedge-worker.ts');

const ITERATIONS = 400;
const WARMUP = 40;

/* ------------------------------------------------------------------ utilities */

const block = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

type Run = { code: number; stdout: string; stderr: string };

function runWorker(script: string, args: string[], timeoutMs = 60_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`worker timed out after ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Poll `done` on a growing buffer, so a child's startup is not a fixed sleep. */
async function waitFor(done: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The observed line, not a paraphrase of it. */
function pick(stream: string, marker: string): string {
  const line = stream.split('\n').find((l) => l.includes(marker));
  return line?.trim() ?? `<no line containing "${marker}">`;
}

const trim = (r: Run): string => (r.stdout.trim() || r.stderr.trim() || `exit=${r.code}`).trim();

type Samples = { n: number; p50: number; p95: number; p99: number; min: number; max: number };

function stats(values: number[]): Samples {
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] ?? 0;
  return {
    n: s.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    min: at(0),
    max: at(1),
  };
}

/** Time `fn` per-iteration rather than in bulk, so the distribution is visible. */
function sample(fn: () => unknown, iterations = ITERATIONS): Samples {
  const out: number[] = [];
  for (let i = 0; i < WARMUP; i++) fn();
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    out.push(Number(process.hrtime.bigint() - t0) / 1e3);
  }
  return stats(out);
}

const us = (n: number): string => (n < 1000 ? `${n.toFixed(1)} µs` : `${(n / 1000).toFixed(2)} ms`);

const row = (label: string, s: Samples): string =>
  `| ${label} | ${s.p50.toFixed(0)} | ${s.p95.toFixed(0)} | ${s.p99.toFixed(0)} | ${s.min.toFixed(0)} | ${s.max.toFixed(0)} |`;

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fp-${prefix}-`));
}

/* -------------------------------------------------------------------- latencies */

function latencySuite(flush: boolean): { label: string; rows: string[]; cold: number; gate: number } {
  const root = tempDir(`bench-flush${flush ? 'on' : 'off'}`);
  const store: Store = createStore(root, { flush });
  const rows: string[] = [];
  let seq = 0;
  const fresh = () => ({ kind: 'lock', target: `res-${seq++}` }) as const;

  let held = fresh();
  let heldLease = acquire(store, held, { ttlMs: 600_000 });
  const gate = sample(() => check(store, held, heldLease.token));
  rows.push(row('check (fence gate read)', gate));
  rows.push(row('renew (self-supersede)', sample(() => {
    const l = acquire(store, fresh(), { ttlMs: 600_000 });
    renew(store, l);
    release(store, l);
  })));
  const cold = sample(() => {
    const l = acquire(store, fresh(), { ttlMs: 60_000 });
    release(store, l);
  });
  rows.push(row('acquire + release (cold resource)', cold));
  const t0 = process.hrtime.bigint();
  const contested = tryAcquire(store, held, { ttlMs: 60_000, waitMs: 0 });
  const refusedIn = Number(process.hrtime.bigint() - t0) / 1e3;
  rows.push(row('claim refused while held', { n: 1, p50: refusedIn, p95: refusedIn, p99: refusedIn, min: refusedIn, max: refusedIn }));
  if (contested.ok) throw new Error('benchmark premise broken: a held resource accepted a rival');

  release(store, heldLease);
  fs.rmSync(root, { recursive: true, force: true });
  return {
    label: flush ? 'fsync on (durable across power loss)' : 'fsync off (process-crash safe only)',
    rows,
    cold: cold.p50,
    gate: gate.p50,
  };
}

/* ---------------------------------------------------------------- contention */

async function contentionSuite(): Promise<{ rows: string[]; notes: string[]; rates: number[] }> {
  const rows: string[] = [];
  const notes: string[] = [];
  const rates: number[] = [];
  for (const workers of [2, 4, 8, 16]) {
    const root = tempDir('bench-contend');
    const rounds = Math.max(8, Math.round(120 / workers));
    const t0 = process.hrtime.bigint();
    const results = await Promise.all(
      Array.from({ length: workers }, (_, i) =>
        runWorker(WORKER, ['--store', root, '--rounds', String(rounds), '--ttl', '5000', '--tag', `w${i}`])
      )
    );
    const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
    const bad = results.filter((r) => r.code !== 0);
    if (bad.length > 0) {
      notes.push(`**workers reported violations at ${workers} concurrency:** ${bad.map((b) => b.stderr).join(' ')}`);
    }

    // No two holders may ever be handed the same generation. This is the property
    // the throughput figure depends on: if a number repeats, two processes were
    // inside the critical section at once and the ops/s below is measuring a lock
    // that was not actually locking.
    //
    // Deliberately *not* asserted: that the numbers are dense. Releasing writes a
    // tombstone one generation higher, so every release consumes a number that no
    // holder ever reports -- a gap is the design working, not a hole in it.
    const seen = results.flatMap((r) =>
      r.stdout
        .trim()
        .split(/\s+/)
        .slice(1)
        .map(Number)
        .filter(Number.isFinite)
    );
    const distinct = new Set(seen);
    if (distinct.size !== seen.length) {
      notes.push(
        `**duplicate generation numbers at ${workers} concurrency (${seen.length} issued, ` +
          `${distinct.size} distinct) -- the throughput below is not serialized.**`
      );
    }

    const total = workers * rounds;
    rates.push(total / seconds);
    rows.push(
      `| ${workers} | ${rounds} | ${total} | ${total.toFixed(0)} | ${(total / seconds).toFixed(1)} | ${((seconds / total) * 1000).toFixed(2)} |`
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { rows, notes, rates };
}

/* --------------------------------------------------- incumbent: proper-lockfile */

async function incumbentLatency(): Promise<{ rows: string[]; notes: string[]; p50: number }> {
  const lockfile = await import('proper-lockfile');
  const lock = lockfile.default ?? lockfile;
  const root = tempDir('bench-incumbent');
  const rows: string[] = [];
  const notes: string[] = [];
  let seq = 0;

  const target = path.join(root, `f${seq++}.txt`);
  fs.writeFileSync(target, 'x');

  const theirRoundTrip = await sampleAsync(async () => {
    const rel = await lock.lock(target);
    await rel();
  });
  rows.push(row('lock + unlock (their API)', theirRoundTrip));

  // The head-to-head that is not about speed: their own README states that with
  // `realpath: true` (the default) "the file must exist previously". Claiming a
  // path before creating it is the primary use case here.
  const missing = path.join(root, 'about-to-be-created.txt');
  let lockOnMissing: string;
  try {
    const rel = await lock.lock(missing);
    await rel();
    lockOnMissing = 'succeeded';
  } catch (e) {
    lockOnMissing = `rejected: ${(e as Error).message.split('\n')[0]}`;
  }
  notes.push(`- \`proper-lockfile\` locking a **not-yet-existing** file with default options: ${lockOnMissing}.`);

  // Their documented floor for staleness.
  notes.push('- `stale` has a **minimum of 5000ms** in their API, so 5s is the fastest takeover window they will accept.');

  fs.rmSync(root, { recursive: true, force: true });
  return { rows, notes, p50: theirRoundTrip.p50 };
}

async function sampleAsync(fn: () => Promise<unknown>): Promise<Samples> {
  const out: number[] = [];
  for (let i = 0; i < WARMUP; i++) await fn();
  for (let i = 0; i < 150; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    out.push(Number(process.hrtime.bigint() - t0) / 1e3);
  }
  return stats(out);
}

/* ------------------------------------------------------- the wedged-holder test */

/**
 * The scenario is the same for both: a holder stops responding, is judged dead,
 * is written around by a *different process*, then resumes and does something.
 *
 * The two-process separation is not pedantry. A staleness refresher lives inside
 * the holder's own event loop, so wedging the holder in the same process as the
 * contender wedges the contender too and proves nothing -- which is exactly the
 * mistake an earlier revision of this benchmark made, and why the scenario is now
 * driven by separate OS processes.
 *
 * Everything emitted below is an observation. The reading is labelled as a reading
 * and does not depend on which way the observation went.
 */
async function wedgedHolderSuite(): Promise<string[]> {
  const lines: string[] = [];
  // Captured from the incumbent run so the interpretation below is built from
  // what was printed rather than from a sentence written in advance.
  let incomingRival = '';
  let incomingHolder = '';

  // --- fencepost: 5s ttl, wedged 9s, successor in another process
  {
    const root = tempDir('fp-wedge');
    // Seed the store only. The holder has to be the child: a lease taken in this
    // process would be a second holder on the same resource, and the child would
    // correctly block and then throw -- which is what this line used to do.
    createStore(root);

    const holder = spawn(
      process.execPath,
      [WEDGE, '--role', 'fencepost-holder', '--store', root],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let holderOut = '';
    holder.stdout.setEncoding('utf8');
    holder.stdout.on('data', (c: string) => (holderOut += c));
    await waitFor(() => holderOut.includes('LOCKED'), 15_000, 'fencepost holder');
    const taken = pick(holderOut, 'LOCKED');

    const rival = await runWorker(WEDGE, ['--role', 'fencepost-rival', '--store', root], 60_000);
    await waitFor(() => holderOut.includes('AFTER_RESUME'), 25_000, 'fencepost holder resume');
    if (holder.exitCode === null) holder.kill('SIGKILL');

    lines.push(
      `**fencepost** — holder process: \`${taken}\`, then wedged 9s past its 5s ttl. ` +
        `Successor process printed: \`${trim(rival)}\`. ` +
        `Wedged holder, after resuming, printed: \`${pick(holderOut, 'AFTER_RESUME')}\`.`
    );
    fs.rmSync(root, { recursive: true, force: true });
  }

  // --- proper-lockfile: stale 5000 / update 1000, same shape
  {
    const root = tempDir('fp-wedge-incumbent');
    const target = path.join(root, 'shared.txt');
    fs.writeFileSync(target, 'x');

    const holder = spawn(
      process.execPath,
      [WEDGE, '--role', 'incumbent-holder', '--target', target],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let holderOut = '';
    holder.stdout.setEncoding('utf8');
    holder.stdout.on('data', (c: string) => (holderOut += c));
    await waitFor(() => holderOut.includes('LOCKED'), 20_000, 'incumbent holder');

    // Rival starts after the 5s staleness floor has passed while the holder is
    // wedged, and then *keeps* the lock for long enough that the holder's own
    // release is the last write to the lockfile.
    block(6_500);
    const rival = spawn(
      process.execPath,
      [WEDGE, '--role', 'incumbent-rival', '--target', target, '--hold', '12000'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let rivalOut = '';
    rival.stdout.setEncoding('utf8');
    rival.stdout.on('data', (c: string) => (rivalOut += c));

    await waitFor(() => holderOut.includes('COMPROMISED='), 30_000, 'incumbent holder resume');
    await waitFor(
      () => rivalOut.includes('STOLEN') || rivalOut.includes('REFUSED') || rival.exitCode !== null,
      20_000,
      'incumbent rival verdict'
    );
    if (holder.exitCode === null) holder.kill('SIGKILL');
    if (rival.exitCode === null) rival.kill('SIGKILL');

    incomingRival = rivalOut;
    incomingHolder = pick(holderOut, 'COMPROMISED=');

    lines.push(
      `**proper-lockfile** — holder locked with \`stale: 5000, update: 1000\`, then wedged its event loop 9s; ` +
        `rival locked the same path while it was wedged and held on. ` +
        `Rival printed: \`${rivalOut.trim().split('\n')[0] ?? '<nothing>'}\`. ` +
        `Holder after resuming printed: \`${pick(holderOut, 'COMPROMISED=')}\`.`
    );
    fs.rmSync(root, { recursive: true, force: true });
  }

  lines.push('_Reading, not measurement:_ ' + describeWedge(incomingRival, incomingHolder));

  return lines;
}

/**
 * Interpret the incumbent run from what it actually printed, so the prose cannot
 * drift out of sync with the measurement above it. A fixed sentence here once
 * asserted a result while the code producing it was measuring something else
 * entirely -- the same failure as a typed number, one floor up.
 */
function describeWedge(rivalLine: string, holderLine: string): string {
  const tookOver = rivalLine.includes('STOLEN');
  const told = holderLine.includes('COMPROMISED=true');
  const lockfileRemoved =
    holderLine.includes('LOCKFILE_BEFORE=true') && holderLine.includes('LOCKFILE_AFTER=false');

  const parts: string[] = [
    tookOver
      ? 'the rival entered while the original holder was wedged, so for a window two processes both believed they held the path'
      : 'the rival was kept out, so this run did not produce two concurrent holders',
    told
      ? 'the original holder was told on resume (onCompromised fired)'
      : 'the original holder was never told (`COMPROMISED=false` above)',
    lockfileRemoved
      ? 'and its `release()` removed the lockfile belonging to the rival -- unlocking a resource it no longer held, while the live holder kept believing it was protected'
      : 'and its `release()` did not remove a lock it no longer owned',
  ];

  return (
    parts.join('; ') + '. ' +
    'None of this is a bug that `proper-lockfile` denies: its own README lists "updates take ' +
    'longer than expected, possibly causing the lock to become stale" as a known route to two ' +
    'locks on one file. What a fence changes is *when* a stale holder is stopped. A generation ' +
    'number is presented at the write, so a superseded holder is refused there whether or not it ' +
    'ever notices; an mtime is consulted on the refresh schedule, so a holder that mutates before ' +
    'its next refresh has nothing to check against.'
  );
}

/* ----------------------------------------------------------------------- emit */

async function main(): Promise<void> {
  const cpu = os.cpus()[0]?.model ?? 'unknown';
  const out: string[] = [];
  out.push('# Benchmark results');
  out.push('');
  out.push('Generated by `node bench/bench.ts`. Do not edit by hand — the numbers are the');
  out.push('reproducible artifact, and a hand-copied table silently becomes a claim nobody can check.');
  out.push('');
  out.push('```');
  out.push(`node        ${process.version}`);
  out.push(`platform    ${process.platform} ${os.release()} (${os.arch()})`);
  out.push(`cpu         ${cpu} x ${os.cpus().length}`);
  out.push(`memory      ${(os.totalmem() / 1073741824).toFixed(1)} GB`);
  out.push(`tmp volume  ${os.tmpdir()}`);
  out.push(`date        ${new Date().toISOString()}`);
  out.push(`iterations  ${ITERATIONS} per row, ${WARMUP} warmup (150 for the async incumbent row)`);
  out.push('```');
  out.push('');
  out.push('All times in microseconds unless the cell says `ms`.');

  out.push('');
  out.push('## Latency');
  out.push('');
  const durable = latencySuite(true);
  const volatile = latencySuite(false);
  for (const suite of [durable, volatile]) {
    out.push(`### ${suite.label}`);
    out.push('');
    out.push('| operation | p50 | p95 | p99 | min | max |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    out.push(...suite.rows);
    out.push('');
  }

  const incumbent = await incumbentLatency();
  out.push('### proper-lockfile (the incumbent)');
  out.push('');
  out.push('| operation | p50 | p95 | p99 | min | max |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  out.push(...incumbent.rows);
  out.push('');
  out.push('Observations from its own API surface:');
  out.push('');
  out.push(...incumbent.notes);

  out.push('');
  out.push('## Contention throughput');
  out.push('');
  out.push('Every worker claims, holds briefly, releases, and repeats, all against **one** resource.');
  out.push('This is the serialized path, so rising worker count should raise total throughput only');
  out.push('until contention overhead dominates.');
  out.push('');
  out.push('| workers | rounds each | total ops | ops | seconds/op |');
  out.push('| --- | --- | --- | --- | --- |');
  const contention = await contentionSuite();
  out.push(...contention.rows);
  out.push('');
  out.push(...contention.notes);

  out.push('## The wedged-holder comparison');
  out.push('');
  out.push('The scenario is identical for both: a holder stops responding, is judged dead, is');
  out.push('written around, and then resumes and does something.');
  out.push('');
  for (const line of await wedgedHolderSuite()) {
    out.push(`- ${line}`);
  }

  out.push('');
  out.push('## Read these numbers with');
  out.push('');
  out.push('- **One machine.** NTFS plus whatever antivirus is configured here. Do not read');
  out.push('  p50 as "the code": consecutive full runs of this file have moved the incumbent\'s');
  out.push('  `lock + unlock` p50 by roughly 1.6x with no change on that side at all, so p50 drifts');
  out.push('  by tens of percent too. Re-run before quoting a number, and prefer the ratio between');
  out.push('  rows within one run over any single row compared across runs.');
  out.push('- **The latency rows are not the point.** A lease is taken once per editing task, so');
  out.push('  even a 10x difference is invisible next to an agent turn. They are here because a');
  out.push('  correctness claim that costs 100ms would be a bad trade, not to win a race.');
  out.push('- **The fsync pair is the honest cost of durability**, and the gap between them is what');
  out.push('  you are buying: with `flush: false` a claim survives a process crash but not a power loss.');
  out.push('- **The incumbent comparison is not a speed verdict.** `proper-lockfile` has 110M');
  out.push('  downloads a month and its maintainers document these limits in their own README; the');
  out.push('  comparison is about which failure modes are *detectable at the moment of the write*.');
  out.push('');
  out.push('## What the safety costs');
  out.push('');
  const ms = (n: number): string => `${(n / 1000).toFixed(2)} ms`;
  out.push(
    'Stated plainly, because a comparison that only ever shows the favourable half is not a ' +
      'comparison: the incumbent did `lock + unlock` in **' + ms(incumbent.p50) + '** p50 while a ' +
      'fenced `acquire + release` took **' + ms(durable.cold) + '** with claims flushed (and **' +
      ms(volatile.cold) + '** with `flush: false`). A lease here is a directory of immutable ' +
      'claims, each one created exclusively, plus a tombstone on release and a directory scan on ' +
      'every read -- that is what buys the refusal-at-write-time property, and it is roughly an ' +
      'order of magnitude more expensive than a lockfile whose answer is only "is something ' +
      'stale-looking sitting here". The gate read is the cheap part, at **' + ms(durable.gate) +
      '** p50, because it only looks.'
  );
  out.push('');
  out.push('Two consequences, both worth internalizing:');
  out.push('');
  const bestRate = Math.max(...contention.rates);
  const worstRate = Math.min(...contention.rates);
  out.push(
    `- One hot resource serialized to **${worstRate.toFixed(0)}-${bestRate.toFixed(0)} operations ` +
      'per second** across the concurrency levels above. This is a tool for claiming a migration ' +
      'or a port, not for guarding an inner loop; nobody should put it in a per-file write path at ' +
      'this cost.'
  );
  out.push(
    '- The tombstone written on release is deliberately **not** flushed, while every claim is. ' +
      'That asymmetry is already reflected in the numbers above; why it is safe, and why a claim ' +
      'losing its flush is not, is argued in `docs/design-01-lease-and-fence.md` under "Which ' +
      'fsyncs are load-bearing" and pinned by `test/durability.test.ts`. No before/after figure is ' +
      'restated here, because this file cannot measure the old code -- and a typed number inside a ' +
      'generated document is exactly the rot the generated document exists to avoid.'
  );

  fs.writeFileSync(OUT, out.join('\n') + '\n');
  process.stdout.write(`wrote ${OUT}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`bench failed: ${String(e)}\n`);
  process.exitCode = 1;
});
