/**
 * Resource identity.
 *
 * A lease is only as good as the equality test behind it. If two spellings of
 * the same file map to two different keys, two agents each get a "valid" lease
 * and the whole protocol is decoration. So this module is load-bearing, not
 * cosmetic.
 *
 * The bias is deliberate and one-directional: when unsure, merge two
 * identities (over-lock, which is merely slower) rather than split them
 * (under-lock, which is corruption).
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';

export type Resource =
  | { kind: 'file'; target: string }
  | { kind: 'lock'; target: string };

/**
 * Not covered yet, and each is a real bypass:
 *  - 8.3 short names (`C:\PROGRA~1\x.ts` is the same file as the long form)
 *  - junctions and symlinks (a key under a junction aliases its target)
 *  - UNC vs drive letter (`\\localhost\c$\a.ts` === `C:\a.ts`)
 *  - case-sensitive volumes, where lowercasing would wrongly merge
 * See docs/design-02 for the plan; until then a lock is only as strong as the
 * spelling discipline of the callers.
 */
export function normalizeFile(p: string, cwd: string, platform: string): string {
  let abs = path.resolve(cwd, p);
  if (platform === 'win32') {
    abs = abs.replace(/[\\/]+/g, '\\');
    // Windows folds case for comparison; drive letters arrive inconsistently
    // from different shells, so fold them too.
    abs = abs.replace(/^([a-z]):/i, (_, d: string) => `${d.toUpperCase()}:`);
    abs = abs.toLowerCase();
    abs = abs.replace(/\\+$/, '');
  } else {
    abs = abs.replace(/\/+$/, '');
  }
  return abs;
}

/** Keys are hashed so the store never has to escape path separators. */
export function keyOf(res: Resource, cwd: string, platform: string): string {
  const identity =
    res.kind === 'file'
      ? `file:${normalizeFile(res.target, cwd, platform)}`
      : `lock:${res.target.toLowerCase()}`;
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
}
