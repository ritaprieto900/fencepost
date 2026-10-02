/**
 * The lease protocol.
 *
 * A resource is held by the newest of a series of immutable, monotonically
 * numbered claim files:
 *
 *   <root>/claims/<key>/g00000001.json
 *   <root>/claims/<key>/g00000002.json
 *   ...
 *
 * The generation number *is* the fencing token. Every protocol step is a create
 * of a file that must not exist yet, so there is exactly one arbitration point
 * and it is provided by the filesystem rather than by a read-modify-write we
 * would have to defend.
 *
 * Invariants:
 *
 *  I1  The highest generation present is the only candidate holder.
 *  I2  Generation numbers never repeat and never decrease, across crashes and
 *      restarts -- because the file recording the highest one is never deleted.
 *  I3  An operation carrying any other generation is refused, including by the
 *      holder that was current before it was superseded.
 *  I4  Where an outcome cannot be determined, state is re-read; it is never
 *      assumed.
 *
 * Note where the safety actually lives: I1 is a property of the common case, and
 * I2+I3 are what make the residue of every race survivable. Two processes can
 * both briefly believe they hold a resource -- that is unavoidable without
 * co-operation from a party we have explicitly stopped trusting -- but only one
 * of them can pass `check()`. The library's job is to make the other one
 * harmless rather than to make it impossible to be wrong.
 */

import * as path from 'node:path';

import {
  ensureDir,
  listDir,
  mkdirExclusive,
  readOrNull,
  sleep,
  unlinkQuiet,
  writeNew,
  nonce,
} from './atomic.ts';
import { createResolver, type Resource, type Resolver } from './identity.ts';
import { decode, encode, isLive, type LeaseRecord } from './record.ts';

export class LeaseHeldError extends Error {
  readonly heldBy: string | null;
  readonly resourceKey: string;

  constructor(heldBy: string | null, resourceKey: string) {
    super(`lease for ${resourceKey} is held${heldBy ? ` by ${heldBy}` : ''}`);
    this.name = 'LeaseHeldError';
    this.heldBy = heldBy;
    this.resourceKey = resourceKey;
  }
}

export type LostReason = 'superseded' | 'expired' | 'not-holder' | 'unreadable';

export type Lease = {
  resourceKey: string;
  holderId: string;
  owner: string;
  label: string;
  token: number;
  ttlMs: number;
  expiresAtMs: number;
};

export type ClaimStatus = {
  key: string;
  label: string;
  token: number;
  owner: string | null;
  live: boolean;
  expiresAtMs: number | null;
  ttlMs: number | null;
};

export type RenewOutcome =
  | { status: 'renewed'; token: number; expiresAtMs: number }
  | { status: 'lost'; reason: LostReason };

export type AcquireOutcome =
  | { ok: true; lease: Lease }
  | { ok: false; heldBy: string | null };

export type Store = {
  root: string;
  claimsRoot: string;
  /** resolves a resource to the key its claims live under */
  resolver: Resolver;
  /** injectable, so expiry and clock steps are testable without waiting */
  now: () => number;
  /** backoff sleeper; injectable to keep the suite fast */
  pause: (ms: number) => void;
  /** fsync each claim; on by default, off only to make a test fast */
  flush: boolean;
};

export function createStore(
  root: string,
  opts: {
    now?: () => number;
    cwd?: string;
    platform?: string;
    flush?: boolean;
    pause?: (ms: number) => void;
    realp?: (p: string) => string | null;
  } = {}
): Store {
  const s: Store = {
    root,
    claimsRoot: path.join(root, 'claims'),
    resolver: createResolver({ cwd: opts.cwd, platform: opts.platform, realp: opts.realp }),
    now: opts.now ?? Date.now,
    pause: opts.pause ?? sleep,
    flush: opts.flush ?? true,
  };
  ensureDir(s.claimsRoot);
  return s;
}

const claimDir = (s: Store, key: string): string => path.join(s.claimsRoot, key);
const genFile = (dir: string, seq: number): string =>
  path.join(dir, `g${String(seq).padStart(8, '0')}.json`);
const GEN_NAME = /^g(\d{8,})\.json$/;

type Generation = { seq: number; file: string; rec: LeaseRecord | null };

/** All claims for a resource, oldest first. Undecodable entries stay, with rec null. */
function generations(s: Store, key: string): Generation[] {
  const dir = claimDir(s, key);
  const out: Generation[] = [];
  for (const name of listDir(dir)) {
    const m = GEN_NAME.exec(name);
    if (!m) continue;
    const seq = Number.parseInt(m[1] ?? '', 10);
    const file = path.join(dir, name);
    const raw = readOrNull(file);
    out.push({ seq, file, rec: raw === null ? null : decode(raw) });
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/**
 * The newest grant time we have ever recorded, used as a floor for wall-clock
 * comparisons. The highest generation is by construction the most recently
 * written claim, so its grant time is the floor; a clock now reading below it
 * has stepped backwards.
 */
function clockFloor(latest: Generation | undefined): number {
  return latest?.rec?.grantedAtMs ?? 0;
}

/**
 * Is the newest claim still holding?
 *
 * Written as a type predicate so that a caller which learned "live" can also
 * learn "and therefore a decodable record exists behind it" -- the two facts are
 * established by the same read, and narrowing keeps the callers from re-guessing.
 */
function liveNow(s: Store, latest: Generation | undefined): latest is Generation & { rec: LeaseRecord } {
  if (!latest || latest.rec === null) return false;
  return isLive(latest.rec, s.now(), clockFloor(latest));
}

function newHolderId(owner: string): string {
  return `${owner}.${process.pid}.${nonce()}`;
}

/**
 * Try to land claim `seq`. The filesystem picks the winner: two contenders
 * compute the same number and race to create the same file name, and exactly one
 * create succeeds.
 */
function createClaim(
  s: Store,
  key: string,
  seq: number,
  rec: LeaseRecord
): 'created' | 'taken' | 'unconfirmed' {
  const file = genFile(claimDir(s, key), seq);
  const wrote = writeNew(file, encode(rec), s.flush);
  if (wrote.status === 'created') return 'created';
  if (wrote.status === 'taken') return 'taken';
  // The create reported trouble, so decide by looking: it may have landed.
  const back = readOrNull(file);
  const seen = back === null ? null : decode(back);
  return seen !== null && seen.holderId === rec.holderId ? 'created' : 'unconfirmed';
}

/** Are we the newest claim, with the identity we wrote? */
function isCommittedNewest(s: Store, key: string, seq: number, holderId: string): boolean {
  const gens = generations(s, key);
  const latest = gens[gens.length - 1];
  return latest !== undefined && latest.seq === seq && latest.rec?.holderId === holderId;
}

function buildRecord(
  key: string,
  seq: number,
  owner: string,
  holderId: string,
  ttlMs: number,
  nowMs: number,
  label: string
): LeaseRecord {
  return {
    v: 1,
    resource: key,
    holderId,
    token: seq,
    grantedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    ttlMs,
    pid: process.pid,
    owner,
    label,
  };
}

type Step =
  | { kind: 'acquired'; lease: Lease }
  | { kind: 'held'; heldBy: string | null }
  | { kind: 'retry' };

/**
 * One acquisition attempt, and only one: whether the resource is ours to take.
 *
 * Renewal deliberately does not come through here. This step's question is "is
 * the newest claim still holding?", and during a renewal the newest claim is our
 * own, so the honest answer would be yes and we would stand down from extending
 * our own lease. Renewal asks a different question -- "is the newest claim
 * *mine*?" -- and has its own step below.
 */
function attempt(
  s: Store,
  key: string,
  ttlMs: number,
  owner: string,
  holderId: string,
  label: string
): Step {
  mkdirExclusive(claimDir(s, key));

  const gens = generations(s, key);
  const latest = gens[gens.length - 1];

  if (liveNow(s, latest)) {
    // A claim we cannot decode is not a holder, but neither is it free to keep:
    // it was left by a creator that died mid-write, so it cannot renew, and
    // superseding it retires whatever it may have been about to do.
    return { kind: 'held', heldBy: latest.rec?.owner ?? null };
  }

  const next = (latest?.seq ?? 0) + 1;
  const rec = buildRecord(key, next, owner, holderId, ttlMs, s.now(), label);
  if (createClaim(s, key, next, rec) !== 'created') return { kind: 'retry' };

  // One confirmation, so that a returned lease means "we are newest" rather than
  // "we wrote a file". If a rival got ahead of us, its number is higher and our
  // writes would be refused anyway; there is no reason to report a success the
  // fence contradicts.
  if (!isCommittedNewest(s, key, next, holderId)) return { kind: 'retry' };

  return {
    kind: 'acquired',
    lease: {
      resourceKey: key,
      holderId,
      owner,
      label,
      token: next,
      ttlMs,
      expiresAtMs: rec.expiresAtMs,
    },
  };
}

export type AcquireOptions = {
  ttlMs?: number;
  /** how long to keep trying; 0 makes this a single pass */
  waitMs?: number;
  owner?: string;
};

/** Same work as `acquire`, but reports contention instead of throwing. */
export function tryAcquire(
  s: Store,
  resource: Resource,
  opts: AcquireOptions = {}
): AcquireOutcome {
  const key = s.resolver.key(resource);
  const label = resource.target;
  const ttlMs = opts.ttlMs ?? 30_000;
  const owner = opts.owner ?? 'agent';
  const holderId = newHolderId(owner);
  const deadline = s.now() + (opts.waitMs ?? 5_000);
  let backoff = 2;
  let lastHeldBy: string | null = null;

  for (;;) {
    const step = attempt(s, key, ttlMs, owner, holderId, label);
    if (step.kind === 'acquired') return { ok: true, lease: step.lease };
    if (step.kind === 'held') lastHeldBy = step.heldBy;
    if (s.now() >= deadline) return { ok: false, heldBy: lastHeldBy };
    // Jittered, because these callers are agents launched in batches: a fixed
    // interval makes them re-collide on the same generation number every tick.
    s.pause(Math.min(backoff + Math.floor(Math.random() * backoff), 40));
    backoff = Math.min(backoff * 2, 40);
  }
}

/** Block until the lease is ours or the deadline passes. */
export function acquire(s: Store, resource: Resource, opts: AcquireOptions = {}): Lease {
  const out = tryAcquire(s, resource, opts);
  if (!out.ok) {
    throw new LeaseHeldError(out.heldBy, s.resolver.key(resource));
  }
  return out.lease;
}

/**
 * Extend our hold by superseding *ourselves* with the next generation.
 *
 * Renewal never edits a claim file -- editing is what needs rename or replace,
 * and Windows promises neither. It also keeps the fence meaningful: the moment we
 * move from generation n to n+1, a stale in-flight operation still carrying n is
 * refused by our own store.
 */
export function renew(s: Store, lease: Lease): RenewOutcome {
  const key = lease.resourceKey;
  const gens = generations(s, key);
  const latest = gens[gens.length - 1];
  if (!latest) return { status: 'lost', reason: 'unreadable' };
  if (latest.seq !== lease.token) return { status: 'lost', reason: 'superseded' };
  if (latest.rec === null) return { status: 'lost', reason: 'unreadable' };
  if (latest.rec.holderId !== lease.holderId) return { status: 'lost', reason: 'not-holder' };
  if (!liveNow(s, latest)) return { status: 'lost', reason: 'expired' };

  const next = latest.seq + 1;
  const rec = buildRecord(key, next, lease.owner, lease.holderId, lease.ttlMs, s.now(), lease.label);
  const created = createClaim(s, key, next, rec);
  if (created !== 'created') {
    // A rival claimed the number, or our create did not land. Either way we are
    // no longer the newest, so the answer is that we lost the lease.
    return { status: 'lost', reason: 'superseded' };
  }
  if (!isCommittedNewest(s, key, next, lease.holderId)) {
    return { status: 'lost', reason: 'superseded' };
  }

  lease.token = next;
  lease.expiresAtMs = rec.expiresAtMs;
  sweepByKey(s, key);
  return { status: 'renewed', token: next, expiresAtMs: rec.expiresAtMs };
}

/**
 * The fence gate. Anything that mutates a protected resource passes its token
 * through here and refuses when this says no.
 *
 * This is what neutralizes the zombie. A reclaimed holder does not have to know
 * it was reclaimed -- it may be running stale code, or be wedged and only now
 * waking -- because its token is no longer the newest and the write is refused
 * whether it noticed or not.
 */
export function check(s: Store, resource: Resource, token: number): boolean {
  const key = s.resolver.key(resource);
  const gens = generations(s, key);
  const latest = gens[gens.length - 1];
  if (!latest || latest.seq !== token) return false;
  return liveNow(s, latest);
}

/**
 * Give the resource up.
 *
 * Releasing writes an already-expired successor rather than deleting our claim,
 * because that claim is the high-water mark: delete it and the next grantor
 * restarts numbering from a lower number, which would make a zombie's retired
 * token current again. Freeing a resource must never lower the fence.
 *
 * A release by a process that is no longer the newest is a no-op: that claim is
 * somebody else's to give up, and deleting it would hand their resource to a
 * third agent.
 */
export function release(s: Store, lease: Lease): void {
  const key = lease.resourceKey;
  const gens = generations(s, key);
  const latest = gens[gens.length - 1];
  if (!latest || latest.seq !== lease.token) return;
  if (latest.rec === null || latest.rec.holderId !== lease.holderId) return;

  const nowMs = s.now();
  const tombstone: LeaseRecord = {
    ...latest.rec,
    token: latest.seq + 1,
    grantedAtMs: nowMs,
    expiresAtMs: nowMs, // not greater than now, so nobody reads it as live
  };
  writeNew(genFile(claimDir(s, key), tombstone.token), encode(tombstone), s.flush);
  sweepByKey(s, key);
}

/**
 * Delete superseded claims.
 *
 * Only claims that are not the newest are ever removed, which is what keeps I2
 * intact: the newest claim is the fence's memory and must survive. Deleting a
 * live-but-not-newest claim is harmless for the same reason its holder is
 * already harmless -- the fence has moved past it.
 */
function sweepByKey(s: Store, key: string): number {
  const gens = generations(s, key);
  let removed = 0;
  // Everything but the last: that one is the fence's memory of the highest
  // number ever granted, and removing it would let numbering restart lower.
  for (const stale of gens.slice(0, -1)) {
    unlinkQuiet(stale.file);
    removed++;
  }
  return removed;
}

export function sweepStale(s: Store, resource: Resource): number {
  return sweepByKey(s, s.resolver.key(resource));
}

/**
 * The newest claim's record, if it can be read.
 *
 * Exposed so a caller holding a token but not the original handle -- an operator
 * clearing a stuck lease from the command line -- can prove ownership properly.
 * `release` refuses unless the token *and* the holder id both match the live
 * claim, and fabricating either half would defeat exactly that check.
 */
export function holderOf(s: Store, resource: Resource): LeaseRecord | null {
  const gens = generations(s, s.resolver.key(resource));
  return gens[gens.length - 1]?.rec ?? null;
}

/** Current fence number and holder, for status output and tests. */
export function inspect(
  s: Store,
  resource: Resource
): { token: number; holder: string | null; live: boolean; expiresAtMs: number | null } {
  const key = s.resolver.key(resource);
  const gens = generations(s, key);
  const latest = gens[gens.length - 1];
  return {
    token: latest?.seq ?? 0,
    holder: latest?.rec?.owner ?? null,
    live: liveNow(s, latest),
    expiresAtMs: latest?.rec?.expiresAtMs ?? null,
  };
}

/**
 * Keep a lease alive from a long-lived process, reporting the moment we stop
 * being the holder. Returns the stop function.
 *
 * Renews at ttl/3, so two missed renewals still fit inside the ttl: a stalled
 * filesystem or a long GC pause should not cost us the lease.
 */
export function heartbeat(
  s: Store,
  lease: Lease,
  onLost: (reason: LostReason) => void
): () => void {
  const every = Math.max(10, Math.floor(lease.ttlMs / 3));
  const timer = setInterval(() => {
    const out = renew(s, lease);
    if (out.status === 'lost') {
      clearInterval(timer);
      onLost(out.reason);
    }
  }, every);
  // A heartbeat must not be the reason a process lingers.
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Every resource with a claim on it, whether it is currently held, and by whom.
 *
 * Reads the store directly rather than keeping a registry, because a registry
 * would be a second copy of the truth -- and the disagreement between a registry
 * and the claims would be resolved by whichever one you got to first.
 */
export function listClaims(s: Store): ClaimStatus[] {
  const out: ClaimStatus[] = [];
  for (const key of listDir(s.claimsRoot)) {
    const gens = generations(s, key);
    const latest = gens[gens.length - 1];
    out.push({
      key,
      label: latest?.rec?.label ?? '(unreadable claim)',
      token: latest?.seq ?? 0,
      owner: latest?.rec?.owner ?? null,
      live: liveNow(s, latest),
      expiresAtMs: latest?.rec?.expiresAtMs ?? null,
      ttlMs: latest?.rec?.ttlMs ?? null,
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/** Run `fn` while holding a lease on `resource`, releasing on any outcome. */
export function withLease<T>(
  s: Store,
  resource: Resource,
  opts: AcquireOptions,
  fn: (lease: Lease) => T
): T {
  const lease = acquire(s, resource, opts);
  try {
    return fn(lease);
  } finally {
    release(s, lease);
  }
}
