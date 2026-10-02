# Unit 1 — why a lease and a fence, not a lockfile

## The problem

Several coding agents edit one working tree at once. The common answer is isolation:
give every agent its own `git worktree` and merge afterwards. That is a real answer to
"they corrupt each other's files", and it leaves two others unanswered:

- Some things cannot be worktree-partitioned. A database migration sequence, a free
  TCP port, a lockfile, a shared fixture, a release tag. These are one logical resource
  that several worktrees contend for.
- Isolation makes conflicts *mergeable*, not *absent*. Whoever merges a migration
  ordering conflict is still resolving a collision that a lease would have prevented.

So there is a place for mutual exclusion that is aware it is being taken by agents. This
library is that place. It is not an orchestrator and does not schedule work.

## Why lockfile + PID is not enough

The usual implementation writes `pid` into a file, and a would-be taker checks whether
that pid is alive; if not, it deletes the file. Three failures, in increasing order of
severity.

**1. A pid is not an identity.** On Windows pids are recycled aggressively, so "is pid
4210 alive" can answer yes about an unrelated process and hold the resource forever — or
answer no about a holder that is merely wedged. Correcting it needs a *pair* (pid,
process start time), which is not available from portable Node without a native
dependency, and which still only identifies a process on *this* machine.

**2. "Stale" is a guess about the future.** Time-based takeover — the `stale` option most
lock libraries expose — deletes a lock whose owner has not refreshed recently. That owner
may simply be slow: a long GC pause, a laptop that slept, a filesystem that stalled under
an antivirus scan. It is alive, it does not know it was evicted, and it keeps writing.
There is no way to notice from inside it, because it is running code that predates the
eviction.

**3. Nothing refuses the old holder.** This is the one that actually costs data. After a
takeover, both processes hold everything they need to write, and no step in a lockfile
design is in a position to say no. Failure 3 is what a fencing token fixes, and it is
independent of how accurate your liveness detection is — which is the useful part: the
design does not require getting failure 1 or 2 right.

A reclaimed holder is not prevented from existing. It is prevented from *landing*.

## The design

One resource, one directory. A claim is an immutable file named by a strictly increasing
generation number:

```
.fencepost/claims/<key>/g00000001.json
.fencepost/claims/<key>/g00000002.json
```

The generation number *is* the fencing token. The holder is whoever owns the highest
generation, and only while its lease is unexpired.

Every protocol step — acquire, renew, release — is **the exclusive creation of a file
name that must not yet exist**. That is the whole arbitration story: two contenders
compute the same next number, the filesystem gives the create to exactly one of them, and
the loser's re-read now shows a live claim above it. No lock, no compare-and-swap, no
third party, no assumption about who was there first.

Three consequences worth naming:

- **Renewal is a self-supersede.** Extending a lease writes generation `n+1` rather than
  editing `n`. Editing is what would require rename or replace (see below), and as a side
  effect the instant we move to `n+1`, a stale operation still carrying `n` is refused by
  our own store.
- **Release writes an already-expired successor — a tombstone.** It does not delete our
  claim, because that file is the only record of how high the numbers have gone. Delete
  it and the next grantor restarts from a lower number, which re-arms every token issued
  before. Freeing a resource must never lower the fence.
- **Sweeping is therefore bounded and careful:** superseded generations may be collected,
  the newest may not.

## Why only exclusive-create, on Windows specifically

The first revision arbitrated expired-claim reclamation by renaming the claim directory
aside — a sound design, and the standard one. The multi-process contention test killed it
immediately with an error that cannot be worked around by retrying:

```
EBUSY: resource busy or locked, rename 'claims/<key>' -> 'quarantine/<key>.<stamp>'
EPERM: operation not permitted, rename ...
```

Windows will not rename a directory while another process holds a handle inside it, and a
*reader* of the record is enough to be that process. Under eight contending agents it
reproduced every time, turning a 1s test into an 8s one full of timeouts. Antivirus
scanning makes it worse and is not optional on a dev machine.

Rename and replace are the two operations Windows does not promise. So this library
performs neither. Every action is `mkdir` or "create this name if absent", both of which
fail loudly and unambiguously when someone else won — and both of which are already the
primitive `git`, `npm` and package managers use for exactly this reason.

## Time

Expiry is compared across processes, so it has to be wall-clock. Scheduling renewals
locally is monotonic-only, so a clock adjustment cannot make a holder miss its own
deadline.

The gap between those two clocks is where the bugs live. One rule handles the direction
that can be detected: if the wall clock now reads *earlier* than the newest grant time,
time stepped backwards (manual set, DST, an NTP correction) and expiry is unknowable, so
the lease is treated as still held. The asymmetry is the argument — wrongly blocking one
agent is recoverable, wrongly freeing one is not.

The other direction is not solved and is stated rather than hidden: a large *forward* jump
makes unexpired leases look expired. What bounds the damage is not clock logic, it is the
fence — a lease taken wrongly is superseded, and the party that was wrongly evicted is
refused when it tries to write. Renewing at `ttl/3` keeps the practical window small.

## What this does not do

- **It does not make the check-then-write sequence atomic.** `check(token)` followed by an
  edit still has a window. Shrinking it requires the *resource* to reject stale tokens,
  which is the argument for the server added in unit 3: when writes go through the
  process that owns the fence, the window closes instead of merely narrowing. Until
  then, callers that bypass the gate are outside the guarantee.
- **It assumes both sides agree on resource identity.** Two spellings of one path are one
  resource; if normalization splits them, each gets a lease the library considers
  uncontested and no fence fixes that, because the fence is per key. This is the one
  failure mode where unit 1's argument buys nothing, so identity is treated as its own
  module with its own evidence — see `design-02-resource-identity.md`. Hard links remain
  ununified there, and are the honest hole.
- **A hard-killed holder blocks until its ttl elapses.** Nothing inspects the dead
  process — no heartbeat, no exit hook, no pid check. That window is the price of not
  trusting liveness detection, which is why ttl is a tuning knob rather than a formality.
- **Not tested against network shares**, where rename and lock semantics differ again.
- **No performance claims.** Every step fsyncs, which is correct and slow; the cost is
  unmeasured.
