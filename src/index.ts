export {
  acquire,
  check,
  createStore,
  heartbeat,
  inspect,
  release,
  renew,
  sweepStale,
  tryAcquire,
  withLease,
  LeaseHeldError,
  type AcquireOptions,
  type AcquireOutcome,
  type Lease,
  type LostReason,
  type RenewOutcome,
  type Store,
} from './lease.ts';

export { keyOf, normalizeFile, type Resource } from './key.ts';
export type { LeaseRecord } from './record.ts';
