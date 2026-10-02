/**
 * Filesystem primitives, restricted to operations that are safe on Windows.
 *
 * The protocol in lease.ts deliberately uses only two atomic actions:
 * `mkdir` and creating a file that does not exist yet. Both fail with a
 * distinguishable error when someone else won, and neither needs a
 * read-modify-write, a rename, or a delete to arbitrate.
 *
 * That restriction is not stylistic. An earlier revision arbitrated expired-claim
 * reclamation by renaming the claim directory aside, and on Windows that fails
 * with `EBUSY: resource busy or locked` whenever another process merely holds a
 * handle inside it -- which is the normal case for a reader, and reliably
 * happens the moment several agents contend. Rename and replace are the two
 * operations Windows will not promise, so this library performs neither.
 *
 * The residual rule kept throughout: **an error code is not an outcome.** Where
 * an operation could have landed anyway, the answer is decided by reading the
 * resulting state, never by assuming failure.
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

const errCode = (e: unknown): string =>
  typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : '';

const isNotFound = (e: unknown): boolean => errCode(e) === 'ENOENT';
const isExists = (e: unknown): boolean => ['EEXIST', 'EPERM'].includes(errCode(e));

export function ensureDir(dir: string): void {
  // mkdir -p is idempotent, so concurrent creators are harmless.
  fs.mkdirSync(dir, { recursive: true });
}

export function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Atomically create a directory. Returns false when it already existed, which is
 * the normal answer under contention.
 */
export function mkdirExclusive(dir: string): boolean {
  try {
    fs.mkdirSync(dir);
    return true;
  } catch (e) {
    if (isExists(e)) return false;
    if (isNotFound(e)) return false; // parent vanished; caller re-seeds and retries
    throw e;
  }
}

export type WriteNew = { status: 'created' } | { status: 'taken' } | { status: 'unknown'; cause: unknown };

/**
 * Create `file` with `bytes`, failing if it already exists, and flush it to the
 * device before returning. This is the library's only arbitration primitive.
 *
 * `flush` costs an fsync and is what makes a claim survive a machine losing
 * power rather than only a process dying. Without it, a claim that was
 * acknowledged can be missing after a reboot while a later claim that was not
 * acknowledged survives -- which reorders the fence.
 */
export function writeNew(file: string, bytes: string, flush = true): WriteNew {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (e) {
    // EPERM on a racing create is Windows for "someone else got it"; confirm
    // rather than trust the code, because EPERM also appears for a create that
    // succeeded while an indexer watched the directory.
    if (isExists(e)) return exists(file) ? { status: 'taken' } : { status: 'unknown', cause: e };
    return { status: 'unknown', cause: e };
  }
  try {
    fs.writeFileSync(fd, bytes);
    if (flush) fs.fsyncSync(fd);
  } catch (e) {
    // The name is ours but the content may be partial. Leaving it is the safe
    // answer: a reader that cannot decode it treats it as a dead creator, and it
    // will be superseded by a higher fence number.
    return { status: 'unknown', cause: e };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already committed; a failed close changes nothing observable */
    }
  }
  return { status: 'created' };
}

/** Best-effort unlink. Nothing in the protocol depends on this succeeding. */
export function unlinkQuiet(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* garbage; a later sweep takes it */
  }
}

/**
 * Blocking sleep that occupies no timer and no event loop. Callers are
 * short-lived CLI processes where a promise-based delay would keep the loop alive
 * for work it is not doing.
 */
export function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function nonce(): string {
  return crypto.randomBytes(5).toString('hex');
}
