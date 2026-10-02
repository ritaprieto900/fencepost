/**
 * Resource identity: turning a spelling into a fact.
 *
 * A lease is only as good as the equality test behind it. Two spellings of one
 * file that produce two keys give two agents each a lease the library considers
 * uncontested, and no fencing token fixes that -- the fence is per key. This is
 * therefore the load-bearing module, and its rules are derived from measured
 * behaviour on NTFS, not from what the documentation says Windows does.
 *
 * The bias, applied at every ambiguous step: **merge identities when unsure.**
 * Over-merging costs a false contention that clears itself; under-merging costs
 * two concurrent writers. Never the other way round.
 *
 * Measured on Windows 10.0.26300 / NTFS, October 2026:
 *
 *  - `realpathSync.native` resolves 8.3 short names, junctions, symlinks and
 *    inline `..` into the long canonical path, and strips a `\\?\` prefix.
 *  - It throws ENOENT unless the *final* component exists, so a claim on a file
 *    that has not been created yet needs the ancestor walk in `resolveOne`.
 *  - It does NOT unify a loopback admin share (`\\localhost\c$\x`) with `C:\x`.
 *    That fold has to be syntactic.
 *  - Node treats `target.txt.` as a distinct file from `target.txt` -- readdir
 *    lists both, and realpath keeps the dot. A native `CreateFile` caller has
 *    the dot stripped and reaches `target.txt`. Two views of one volume
 *    disagree, so the dot is trimmed here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export type Resource =
  | { kind: 'file'; target: string }
  | { kind: 'lock'; target: string };

/**
 * Windows discards trailing dots and spaces when a native API opens a name, so
 * `report.txt.` and `report.txt` are one file to everything except Node. That
 * disagreement is the dangerous kind -- an agent editing through a native tool
 * and an agent editing through Node would hold different locks on one file -- so
 * the trimming happens here.
 */
export function trimComponentEnds(component: string): string {
  return component.replace(/[ .]+$/, '');
}

/** Collapse mixed separators and drop an extended-length or device prefix. */
export function stripLengthPrefix(p: string): string {
  return p.replace(/^[/\\]{2}[?.][/\\]/, '');
}

/**
 * `\\localhost\c$\Users\x` -> `C:\Users\x`, for the loopback host only.
 *
 * A real `\\fileserver\share\...` is deliberately left alone: it may name a
 * different file on a different machine, and folding it would be an under-merge
 * disguised as a convenience.
 */
export function foldLoopbackShare(p: string): string {
  const m = /^\\\\(?:localhost|127\.0\.0\.1)\\([a-z])\$((?:\\.*)?)$/i.exec(p);
  if (!m) return p;
  const drive = (m[1] ?? '').toUpperCase();
  const rest = m[2] ?? '';
  return `${drive}:${rest === '' ? '\\' : rest}`;
}

type PathModule = typeof path.win32;

/**
 * Syntactic pass: everything answerable without consulting the filesystem.
 *
 * The order is not free. Both the extended-length prefix (`\\?\C:\...`) and a UNC
 * path (`\\server\share\...`) are identified by a *leading pair* of separators, so
 * a blanket "collapse repeated separators" would silently retarget them at the
 * current drive -- turning one file into two identities, which is the failure this
 * whole module exists to prevent. The lead is captured first, then normalized.
 */
export function normalizeSyntax(p: string, win32: boolean, cwd: string): string {
  const P: PathModule = win32 ? path.win32 : path.posix;
  if (!win32) {
    // POSIX is case-sensitive and has no aliases to fold at this layer, so the
    // only work is making the path absolute and removing redundant components.
    return P.resolve(cwd, p);
  }

  const body = stripLengthPrefix(p);
  const lead = /^[/\\]{2}/.test(body) ? '\\\\' : '';
  const collapsed = lead + (lead ? body.slice(2) : body).replace(/[\\/]+/g, '\\');
  const folded = foldLoopbackShare(collapsed);
  const normalized = path.win32.normalize(folded);
  const rooted =
    /^[a-z]:[\\/]/i.test(normalized) || normalized.startsWith('\\\\')
      ? normalized
      : path.win32.resolve(cwd, normalized);

  const parts = rooted.split('\\');
  if (rooted.startsWith('\\\\')) {
    // A leading pair splits into *two* empty components, so the authority is read
    // off the remainder rather than by index into `parts`.
    const after = rooted.slice(2).split('\\');
    const server = (after[0] ?? '').toUpperCase();
    const share = trimComponentEnds(after[1] ?? '');
    const rest = after.slice(2).map(trimComponentEnds);
    return `\\\\${server}\\${share}${rest.length ? '\\' + rest.join('\\') : '\\'}`;
  }
  const head = (parts[0] ?? '').toUpperCase();
  const rest = parts.slice(1).map(trimComponentEnds);
  return `${head}\\${rest.join('\\')}`;
}

export type Resolver = {
  /** Canonical identity of a path without consulting the filesystem. */
  syntax(p: string): string;
  /** Best effort canonical location of the *existing* part of a path. */
  resolve(p: string): string;
  /** Full resource key: namespace, resolved identity, hash. */
  key(res: Resource): string;
  /** Number of positive resolutions remembered; exposed for tests. */
  cacheSize(): number;
};

/**
 * `realpathSync.native` the deepest existing ancestor, then re-append what is
 * left.
 *
 * Not a convenience. Without it, every not-yet-existing target keeps its raw
 * spelling, at which point a relative and an absolute path to one file become
 * two keys -- exactly the hole a claim is supposed to close. Claims on files
 * about to be created are the common case, not the edge case: the agent takes the
 * lease before it writes.
 */
function resolveOne(p: string, win32: boolean, realp: (q: string) => string | null): string {
  const P: PathModule = win32 ? path.win32 : path.posix;
  const direct = realp(p);
  if (direct !== null) return direct;

  const tail: string[] = [];
  let cursor = p;
  for (;;) {
    const parent = P.dirname(cursor);
    if (parent === cursor) break;
    const base = P.basename(cursor);
    if (base !== '') tail.unshift(win32 ? trimComponentEnds(base) : base);
    cursor = parent;
    const hit = realp(cursor);
    if (hit !== null) {
      const sep = win32 ? '\\' : '/';
      const stem = hit.replace(new RegExp(`\\${sep}$`), '');
      return tail.length === 0 ? hit : `${stem}${sep}${tail.join(sep)}`;
    }
  }
  return p;
}

export function createResolver(
  opts: {
    cwd?: string;
    platform?: string;
    realp?: (p: string) => string | null;
    readDev?: (p: string) => number | null;
  } = {}
): Resolver {
  const cwd = opts.cwd ?? process.cwd();
  const win32 = (opts.platform ?? process.platform).toLowerCase().startsWith('win');

  const realp =
    opts.realp ??
    ((p: string): string | null => {
      try {
        return fs.realpathSync.native(p);
      } catch {
        return null;
      }
    });

  const cache = new Map<string, string>();

  function syntax(p: string): string {
    // Deliberately not `P.resolve(cwd, p)` first: resolving before the
    // extended-length and UNC prefixes are recognized is what mangles them.
    return normalizeSyntax(p, win32, cwd);
  }

  /**
   * Identity of a path. Cached on the pre-resolution form, because the cost is a
   * syscall per component walked upward and agents ask about the same handful of
   * files continuously.
   *
   * The cache is never invalidated: a path that changes what it resolves to -- an
   * ancestor junction being repointed, a volume remounted -- keeps a stale key
   * until this process exits. Stale in the direction of *holding two keys for one
   * file*, which is why this is documented as a per-process optimization and not
   * as identity itself. A long-lived holder should restart, or use the MCP server
   * that resolves once, on its own machine.
   */
  function resolve(p: string): string {
    const syntaxPath = syntax(p);
    const hit = cache.get(syntaxPath);
    if (hit !== undefined) return hit;
    let out = resolveOne(syntaxPath, win32, realp);
    if (win32) {
      // Case is not part of an NTFS identity. A case-sensitive mount would
      // over-merge here, which is the safe direction.
      out = out.toLowerCase();
    }
    cache.set(syntaxPath, out);
    return out;
  }

  function key(res: Resource): string {
    // The namespace prefix is what keeps a named lock from ever colliding with a
    // path claim, and the NUL separator cannot appear in either operand, so no
    // combination of targets can forge across the two namespaces.
    const identity =
      res.kind === 'file'
        ? `file\u0000${resolve(res.target)}`
        : `lock\u0000${res.target.trim().toLowerCase()}`;
    return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
  }

  return { syntax, resolve, key, cacheSize: () => cache.size };
}
