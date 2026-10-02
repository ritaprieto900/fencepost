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

export {
  createResolver,
  foldLoopbackShare,
  normalizeSyntax,
  trimComponentEnds,
  type Resource,
  type Resolver,
} from './identity.ts';
export type { LeaseRecord } from './record.ts';
