/**
 * Minimal ambient types for the incumbent, which ships none.
 *
 * Only the surface the benchmark touches. Written by hand because the alternative
 * -- letting it be `any` -- means the comparison could silently call something
 * that does not exist, and a benchmark that quietly measures nothing is worse
 * than no benchmark.
 */
declare module 'proper-lockfile' {
  export interface LockOptions {
    stale?: number;
    update?: number;
    retries?: number | Record<string, unknown>;
    realpath?: boolean;
    lockfilePath?: string;
    onCompromised?: (err: Error) => void;
  }

  /** Resolves to the release function for the lock that was taken. */
  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  export function unlock(file: string, options?: LockOptions): Promise<void>;
  export function check(file: string, options?: LockOptions): Promise<boolean>;

  const api: {
    lock: typeof lock;
    unlock: typeof unlock;
    check: typeof check;
  };
  export default api;
}
