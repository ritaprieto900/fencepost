# Unit 3 — the server, and where the guarantee actually lands

## Why put a server on top at all

Unit 1's gate is advisory. `check(token)` then edit is two steps performed by
somebody else's code, and the window between them is not something a library can
close from outside. Unit 2 shrank the identity half of the problem; this is the
half where the write itself moves to the side that owns the fence.

The `write` tool verifies the token, resolves the target, and **verifies again**
immediately before writing. That second check is not a superstition: resolving a
path costs a syscall, and a lease with a short ttl can be lost inside it. The
honest description is that the window got much smaller and both ends of it are now
on the authority's side of the boundary, which is a different kind of guarantee
from "we hope nobody writes in between".

The secondary reason is plumbing: MCP is the one interface all five agents here
already speak, so adoption is one config line rather than one plugin per vendor.

## There is no daemon, and that is a test, not a slogan

Each agent spawns its own `fencepost-server` process. No port, no leader, no
coordinator that both must reach. Mutual exclusion between two of them is produced
by the filesystem arbitrating an exclusive create, exactly as in unit 1.

`test/mcp.test.ts` proves it the way that can be faked least: two clients, two
server processes, one store. The first claim wins, the second is refused and told
who holds it, the second process can *see* the first one's token through `assert`,
and after the release the second process gets a strictly higher fence number. If
the design had quietly required a shared in-process registry, that test would fail.

The corollary worth stating: a coordinator would itself need liveness detection —
"is the server still there" is exactly the question unit 1 refuses to answer.

## Two things this layer deliberately does not pretend

- **Non-mediated writes stay advisory.** An agent editing with its own tool does
  not go through the server. The fence protects the resource for callers that ask;
  a caller that never asks cannot be stopped by a library. Any framing other than
  that would be false.
- **A heartbeat dies with its process.** The server renews while it lives, and when
  it does not, the lease expires. Which is the intended behaviour, not a gap.

## Three bugs found while building it

**The entry-point guard silently did nothing on Windows.** The usual
`import.meta.url === 'file://' + process.argv[1]` idiom is wrong here: the URL form
is `file:///C:/...`, so the comparison never matched, `main()` never ran, and every
CLI command exited **0 having done nothing**. A manual smoke pass read as success.
Only a test that asserts on exit codes caught it, which is the argument for asserting
on exit codes.

**`release` from the CLI was broken by a fabricated handle.** A fresh process has a
token and no memory of the claim, so the first version built a `Lease` with an empty
`holderId`. `release` compares the holder id before tearing anything down — so
`release` never released, and did so quietly, because a no-op is a legal outcome for
a caller that was already superseded. The fix is `holderOf`, which reads the real
claim and lets the ownership check run against actual values.

**Two views of one file, both plausible.** `target.txt.` and `target.txt` are two
files to Node and one file to Win32. Resolved in unit 2, but it belongs here too: the
server is where a native tool and a Node tool first meet over the same resource.

## Where the dependency line sits

The core is zero-dependency and the CLI imports nothing but `node:*`, so an agent
that can only shell out gets the whole protocol with nothing installed. The MCP SDK
— and through it zod, express, hono — is an `optionalDependency`, reached only by
`src/server.ts`. `npm install fencepost` should not pull a web framework into a
project that uses the library to take a lock.

## Security posture of the mediated write

Absolute paths are refused outright. Relative ones are resolved, and the check runs
against the *resolved* location, not the requested string — a `..` prefix and a
symlink or junction pointing out of the project are both defeated that way, since
`\\` traversal is invisible until you normalize and a link is invisible until you
resolve. Writes into the claim store are refused: a stray write there corrupts every
lease in the project at once, which makes it the one path worth special-casing.

There is no authentication and no multi-tenant story. Anyone who can write to the
project directory can forge a claim, so the model is "co-operating agents sharing one
checkout", and anything else is out of scope.
