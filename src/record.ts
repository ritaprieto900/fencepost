/**
 * Wire format and the live/expiry rule. No filesystem access here: keeping the
 * schema and the time logic total-independent lets the fence rules be tested
 * without touching a disk.
 */

export type LeaseRecord = {
  /** schema tag; guards against a mixed-version store */
  v: 1;
  /** resource key = normalized identity of what is held */
  resource: string;
  /** unique per acquire attempt */
  holderId: string;
  /** strictly increasing per resource; the fence */
  token: number;
  /** absolute wall-clock ms at which the lease expires */
  expiresAtMs: number;
  /** wall-clock ms at grant time; detects a backwards clock step */
  grantedAtMs: number;
  /** requested lease duration in ms */
  ttlMs: number;
  /** diagnostics only -- never a safety input */
  pid: number;
  owner: string;
  /**
   * The resource as its holder spelled it, for `status` only.
   *
   * Keys are hashes, and hashing is exactly what makes two spellings collapse --
   * so the key cannot be walked back to a path a human can read. Keeping a label
   * alongside it costs one field and means a person debugging a stuck lease sees
   * `db:migrations` instead of `7f3a9c...`. Never an input to identity or to the
   * fence: a holder is free to mislabel its own resource, and it still contends
   * correctly, because the key is what decides.
   */
  label?: string;
};

export function encode(rec: LeaseRecord): string {
  return JSON.stringify(rec) + '\n';
}

export function decode(text: string): LeaseRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  const str = (x: unknown): x is string => typeof x === 'string';
  if (!str(r.resource) || !str(r.holderId) || !num(r.token) || !str(r.owner)) return null;
  if (!num(r.expiresAtMs) || !num(r.grantedAtMs) || !num(r.ttlMs) || !num(r.pid)) return null;
  return r as unknown as LeaseRecord;
}

/**
 * Is this claim still holding?
 *
 * `clockFloorMs` is the highest grant time ever recorded for the resource. When
 * the wall clock is behind it, time went backwards (manual set, DST correction,
 * an NTP step) and expiry simply cannot be computed -- so the claim stays live.
 * The asymmetry is the reason: wrongly blocking one agent is recoverable,
 * wrongly freeing one is not.
 *
 * An undecodable record is reported as live=false. That is safe rather than
 * optimistic: such a record is left by a creator that died mid-write, so it
 * cannot renew, and the only thing it can do is be superseded -- which bumps the
 * fence number, retiring whatever the dead creator may have done.
 */
export function isLive(rec: LeaseRecord, nowMs: number, clockFloorMs: number): boolean {
  if (nowMs < clockFloorMs || nowMs < rec.grantedAtMs) return true;
  return rec.expiresAtMs > nowMs;
}
