# fencepost

Crash-safe leases with fencing tokens, for agents that share one working tree.

Several coding agents editing the same repository need mutual exclusion. The usual answer
is a lockfile holding a pid, and it fails in a way that is not fixable by better stale
detection: after a takeover, the evicted holder keeps everything it needs to write, and
nothing is in a position to refuse it. `fencepost` gives every claim a strictly increasing
number, and refuses any operation carrying a number that is no longer current — so a
holder that was declared dead, was written around, and then woke up cannot land a write.

```ts
import { createStore, acquire, check, release } from 'fencepost';

const store = createStore('.fencepost');
const migration = { kind: 'lock', target: 'db:migrations' } as const;

const lease = acquire(store, migration, { ttlMs: 30_000, owner: 'claude-code' });
if (check(store, migration, lease.token)) {
  // the only party whose write is authorized
}
release(store, lease);
```

Every protocol step is an exclusive file creation. No rename, no replace, no
compare-and-swap, no third-party coordinator — which is also why it behaves on Windows,
where renaming a directory another process holds a handle inside fails with `EBUSY` and
stays failed under real contention.

**Status: v0.0.2, units 1–2.** The lease engine, the fence, resource identity, and the
tests exist. Not published to npm, no CLI, no MCP server, no benchmarks. Resource identity
resolves 8.3 short names, junctions, symlinks, `..`, mixed case, trailing dots, the
extended-length prefix and loopback admin shares down to one key — verified against a real
NTFS volume. What it still does **not** unify is hard links (see
[`docs/design-02-resource-identity.md`](docs/design-02-resource-identity.md), which states
why and what closing it costs), and it is untested on network shares. Read
[`docs/design-01-lease-and-fence.md`](docs/design-01-lease-and-fence.md) for the safety
argument and the parts that are not guaranteed.

## Layout

| path | what it holds |
| --- | --- |
| `src/atomic.ts` | the filesystem primitives, restricted to operations Windows promises |
| `src/record.ts` | claim wire format, and the live/expiry rule |
| `src/identity.ts` | resource identity — the equality test the whole lock rests on |
| `src/lease.ts` | the protocol: acquire, renew, release, and the fence gate |
| `test/` | multi-process contention, hard-kill, clock-step, corruption properties |
| `docs/` | design notes and stated limits |

## Running it

Requires Node 22.6 or newer; it runs `.ts` directly, so there is no build step and no
runtime dependency.

```sh
npm install
npm test        # 23 tests, ~8s
npm run typecheck
```

## License

MIT.
