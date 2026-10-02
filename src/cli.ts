#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * Deliberately does not import the MCP SDK, so the CLI keeps the core's
 * zero-dependency property: an agent that can only shell out gets the whole
 * protocol with nothing installed.
 *
 * One asymmetry worth knowing, because it surprises people: a `claim` from the
 * CLI is held by a process that then *exits*, so nobody renews it and it expires
 * after the ttl. That is correct behaviour, not a bug -- the protocol does not
 * trust exit hooks (unit 1's position), so a lease is only as alive as the
 * process keeping it. For work that outlives a short ttl, use `run`, which stays
 * and renews.
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  LeaseHeldError,
  check,
  createStore,
  heartbeat,
  holderOf,
  listClaims,
  release,
  tryAcquire,
} from './lease.ts';
import type { Lease, Store } from './lease.ts';
import type { Resource } from './identity.ts';

const EXIT = { ok: 0, error: 1, held: 3 } as const;

type Parsed = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

function parseArgv(argv: string[]): Parsed {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? '';
    if (token === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { command, positional, flags };
}

/**
 * Resource selection is explicit rather than inferred. Guessing "does this look
 * like a path" would silently re-key the same resource between two callers --
 * which, given that the fence is per key, is the one error a CLI must not make.
 */
function resourceFrom(flags: Record<string, string | boolean>): Resource {
  const file = flags['file'];
  const lock = flags['lock'];
  if (typeof file === 'string' && typeof lock === 'string') {
    throw new Error('use --file or --lock, not both');
  }
  if (typeof file === 'string') return { kind: 'file', target: file };
  if (typeof lock === 'string') return { kind: 'lock', target: lock };
  throw new Error('specify --file <path> or --lock <name>');
}

function openStore(flags: Record<string, string | boolean>): Store {
  const root = typeof flags['store'] === 'string' ? flags['store'] : '.fencepost';
  const cwd = typeof flags['cwd'] === 'string' ? flags['cwd'] : process.cwd();
  return createStore(root, { cwd });
}

function num(flags: Record<string, string | boolean>, name: string, fallback: number): number {
  const v = flags[name];
  if (typeof v !== 'string') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} expects a non-negative integer`);
  return n;
}

function print(value: unknown, asJson: boolean, human: () => string): void {
  process.stdout.write(asJson ? JSON.stringify(value) + '\n' : human() + '\n');
}

function needToken(positional: string[], command: string): number {
  const raw = positional[0];
  const token = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(token)) throw new Error(`${command} expects a token`);
  return token;
}

function cmdClaim(parsed: Parsed): number {
  const s = openStore(parsed.flags);
  const resource = resourceFrom(parsed.flags);
  const out = tryAcquire(s, resource, {
    ttlMs: num(parsed.flags, 'ttl', 30_000),
    waitMs: num(parsed.flags, 'wait', 0),
    owner: typeof parsed.flags['owner'] === 'string' ? parsed.flags['owner'] : 'cli',
  });
  if (!out.ok) {
    print({ ok: false, heldBy: out.heldBy }, json(parsed), () =>
      `held${out.heldBy ? ` by ${out.heldBy}` : ''}`
    );
    return EXIT.held;
  }
  // The lease is not renewed after this process exits; see the header note.
  print(
    { ok: true, token: out.lease.token, expiresAtMs: out.lease.expiresAtMs, holderId: out.lease.holderId },
    json(parsed),
    () => `${out.lease.token}`
  );
  return EXIT.ok;
}

function cmdCheck(parsed: Parsed): number {
  const s = openStore(parsed.flags);
  const resource = resourceFrom(parsed.flags);
  const token = needToken(parsed.positional, 'check');
  const authorized = check(s, resource, token);
  print({ authorized }, json(parsed), () => (authorized ? 'current' : 'stale'));
  return authorized ? EXIT.ok : EXIT.held;
}

/**
 * `release` arrives as a fresh process with a token and nothing else, so the
 * handle is rebuilt from the live claim rather than from memory. The token alone
 * is not enough to do that: the claim carries the holder id, and passing it
 * through is what lets `release`'s own ownership check run instead of being
 * silently bypassed by a fabricated handle.
 */
function cmdRelease(parsed: Parsed): number {
  const s = openStore(parsed.flags);
  const resource = resourceFrom(parsed.flags);
  const token = needToken(parsed.positional, 'release');
  const claim = holderOf(s, resource);
  if (claim === null) {
    print({ released: false, reason: 'no-claim' }, json(parsed), () => 'nothing is claimed');
    return EXIT.held;
  }
  if (claim.token !== token) {
    print({ released: false, reason: 'not-current', current: claim.token }, json(parsed), () =>
      `not the current holder (current is ${claim.token})`
    );
    return EXIT.held;
  }
  release(s, {
    resourceKey: s.resolver.key(resource),
    holderId: claim.holderId,
    owner: claim.owner,
    label: claim.label ?? resource.target,
    token: claim.token,
    ttlMs: claim.ttlMs,
    expiresAtMs: claim.expiresAtMs,
  });
  print({ released: true }, json(parsed), () => 'released');
  return EXIT.ok;
}

function cmdStatus(parsed: Parsed): number {
  const s = openStore(parsed.flags);
  const claims = listClaims(s);
  print(claims, json(parsed), () =>
    claims.length === 0
      ? 'no claims'
      : claims
          .map((c) =>
            `${c.live ? 'held  ' : 'free  '} ${c.label.padEnd(34)} token=${c.token}` +
            `${c.owner ? ` owner=${c.owner}` : ''}` +
            `${c.expiresAtMs ? ` expires in ${Math.max(0, c.expiresAtMs - Date.now())}ms` : ''}`
          )
          .join('\n')
  );
  return EXIT.ok;
}

/** Hold a lease across a subprocess, renewing for its whole duration. */
function cmdRun(parsed: Parsed): number {
  const s = openStore(parsed.flags);
  const resource = resourceFrom(parsed.flags);
  const [child, ...args] = parsed.positional;
  if (child === undefined) throw new Error('run expects a command after --');

  let lease: Lease;
  try {
    lease = acquireFor(s, resource, parsed.flags);
  } catch (e) {
    if (e instanceof LeaseHeldError) {
      process.stdout.write(`held by ${e.heldBy ?? 'another holder'}\n`);
      return EXIT.held;
    }
    throw e;
  }

  // Without this, a command longer than the ttl loses its lease mid-flight and
  // the isolation the wrapper promises is quietly false.
  const stop = heartbeat(s, lease, (reason) => {
    process.stderr.write(`fencepost: lost the lease (${reason})\n`);
    process.exitCode = EXIT.held;
  });

  try {
    const result = spawnSync(child, args, { stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    return result.status ?? EXIT.error;
  } finally {
    stop();
    release(s, lease);
  }
}

function acquireFor(s: Store, resource: Resource, flags: Record<string, string | boolean>): Lease {
  return tryAcquireOrThrow(
    s,
    resource,
    num(flags, 'ttl', 300_000),
    num(flags, 'wait', 0),
    typeof flags['owner'] === 'string' ? flags['owner'] : 'cli'
  );
}

function tryAcquireOrThrow(
  s: Store,
  resource: Resource,
  ttlMs: number,
  waitMs: number,
  owner: string
): Lease {
  const out = tryAcquire(s, resource, { ttlMs, waitMs, owner });
  if (!out.ok) throw new LeaseHeldError(out.heldBy, s.resolver.key(resource));
  return out.lease;
}

const json = (parsed: Parsed): boolean => parsed.flags.json === true;

const USAGE = `fencepost -- Windows-safe leases for agents sharing one tree

  fencepost status                       [--store DIR] [--cwd DIR] [--json]
  fencepost claim   (--file PATH | --lock NAME)
                                        [--ttl MS] [--wait MS] [--owner NAME] [--json]
  fencepost check   (--file PATH | --lock NAME) TOKEN
  fencepost release (--file PATH | --lock NAME) TOKEN
  fencepost run     (--file PATH | --lock NAME) -- COMMAND [ARGS...]

Exit codes: 0 success, 1 error, 3 resource held or token stale.

A token from \`claim\` is printed on stdout, and the claim is kept only until
its ttl: the CLI process exits, nothing renews it. Use \`run\` for work that
outlasts a ttl -- it stays alive and renews at ttl/3.`;

const COMMANDS: Record<string, (p: Parsed) => number> = {
  status: cmdStatus,
  claim: cmdClaim,
  check: cmdCheck,
  release: cmdRelease,
  run: cmdRun,
};

export function main(argv: string[]): number {
  const parsed = parseArgv(argv);
  if (parsed.command === 'help' || parsed.flags.help === true) {
    process.stdout.write(USAGE + '\n');
    return EXIT.ok;
  }
  const handler = COMMANDS[parsed.command];
  if (!handler) {
    // A leading flag reads as a command name, and `--store DIR claim` is a natural
    // thing to type. Say what is wrong instead of dumping the whole usage on it.
    const complaint = parsed.command.startsWith('--')
      ? `the command must come first, e.g. \`fencepost claim ${parsed.command} ...\``
      : `unknown command: ${parsed.command}`;
    process.stderr.write(`fencepost: ${complaint}\n\n${USAGE}\n`);
    return EXIT.error;
  }
  try {
    return handler(parsed);
  } catch (e) {
    process.stderr.write(`fencepost: ${(e as Error).message}\n`);
    return EXIT.error;
  }
}

// Comparing `import.meta.url` against a hand-built `file://` string is wrong on
// Windows, where the URL form is `file:///C:/...` -- the mismatch is silent, and
// every command exits 0 having done nothing.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
