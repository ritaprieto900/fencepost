# Unit 2 — what makes a file one file

## Why this module is load-bearing

Unit 1's safety argument ends with "only the current fence number may write". That
sentence is indexed by a *key*. If two spellings of one file produce two keys, each
gets its own uncontested fence, and the corruption unit 1 prevents does not happen at
all — no token is involved, nothing is stale, both writers are perfectly authorized.

So identity is not a convenience layer. A bug here silently deletes the guarantee,
which is why every rule below is justified by a measurement rather than by intuition.

## Two passes

1. **Syntactic** (`normalizeSyntax`): make the path absolute, unify separators, drop
   the extended-length prefix, fold the loopback admin share, uppercase the drive,
   trim trailing dots and spaces per component. No syscalls beyond `resolve`.
2. **Operating system** (`resolve`): ask the volume where this actually is, via
   `realpathSync.native`, then fold case and memoize.

Pass 2 does the heavy lifting and pass 1 exists for what it cannot answer.

## Measured on Windows 10.0.26300 / NTFS, October 2026

| input | `realpathSync.native` | handled by |
| --- | --- | --- |
| `C:\...\UNIT2L~1\...` (8.3 short name) | resolves to the long name | pass 2 |
| path through a junction or symlink | resolves to the true target | pass 2 |
| `..\`, `.\`, `//`, mixed separators | resolves correctly | pass 2 |
| `\\?\C:\...` extended-length prefix | prefix removed | pass 2, but see below |
| `file.TXT` vs `FILE.TXT` | keeps on-disk casing, resolves fine | pass 1 + case fold |
| `file.txt.` (trailing dot) | **kept as a distinct file** | pass 1 only |
| `\\localhost\c$\x` vs `C:\x` | **not unified** | pass 1 only |
| `dir\notcreated.ts` where `dir` exists | **throws ENOENT** | ancestor walk |
| two hard links to one file | **not unified** | nobody — see limits |

Three of those deserve to be stated as surprises, because they are the ones that would
have been guessed wrong.

### The trailing dot is a genuine divergence between Node and Win32

`readdir` lists `target.txt` and `target.txt.` as two entries, and realpath preserves
the dot — so under Node they really are two files. A native `CreateFile` call has the
trailing dot stripped and reaches `target.txt`. Two tools, one volume, two answers.

That matters here because the agents sharing a tree do not all go through Node. The
resolution is to trim, which merges toward the Win32 view: a lock taken on `x.` and a
lock taken on `x` collide. The opposite direction would let a native tool and a Node
tool edit one file with two uncontested leases.

### The leading pair must survive separator collapsing

The first implementation collapsed repeated separators and *then* looked for `\\?\` and
UNC prefixes. Collapsing turns `\\?\C:\a` into `\?\C:\a`, after which the prefix is
unrecognizable, and the path then gets re-rooted against cwd to produce
`C:\?\C:\a`. Two identities for one file, in a module whose job is preventing that.
Same shape of bug for `\\server\share`, which becomes a drive-relative path.

Both prefixes are therefore captured before any collapsing, and `path.win32.normalize`
is run afterwards — it is UNC-aware and preserves the authority. A related trap:
`'\\\\server\\share'.split('\\')` yields *two* leading empty components, so the
authority is read off `slice(2)`, not by index. Both of these are pinned by tests.

### Claims are normally taken on files that do not exist yet

`realpathSync.native` requires the final component to exist. But the protocol's whole
point is to claim *before* writing, so "does not exist yet" is the common case, not an
edge case. `resolveOne` therefore walks to the deepest existing ancestor, resolves that,
and re-attaches the remainder — so `dir/new.ts` and `dir\x\..\new.ts` agree before
either names a real file, and the claim is still the right one after it is created.
There is a test for exactly that sequence.

## Direction of every guess

Merge when unsure. A false contention resolves by itself once the other holder
finishes; a missed one is two agents writing one file, which is the thing the project
exists to prevent. That is why case is folded even though a case-sensitive mount would
then be over-merged, and why trailing dots are trimmed.

## Limits that remain, stated plainly

- **Hard links are two identities.** Measured: `realpath` returns different paths for
  `original.txt` and `hardlink.txt`, while `stat` reports the same `dev` and `ino`
  (`5629499535075994`, `nlink: 2`) — the true identity is right there and is not being
  used. Closing this needs *multi-key acquisition*: a file's identity would become the
  set `{resolved path, dev:ino}`, and two agents sharing either member would collide.
  That changes every signature in `lease.ts`, needs claims acquired in sorted key order
  to stay deadlock-free, and breaks the "claim before create" property unless the key
  set is allowed to grow mid-lease. It is the most interesting remaining problem in the
  project and it is deferred on budget, not on knowledge.
- **`subst` drives and mapped network drives** pointing into the same folder are
  different volume identities, and folding them would need the mount table.
- **The cache is never invalidated.** An ancestor junction repointed mid-process leaves
  a stale key until exit. The failure direction is a split identity, i.e. the bad one,
  which is why this is a documented weakness of a per-process optimization rather than a
  claim about identity itself.
- **Network shares are untested**, and their case and rename semantics differ again.
- Case-sensitive directories (`fsutil file setCaseSensitiveInfo`) are merged rather than
  distinguished — safe, but it means two genuinely different files can contend.
