/**
 * The MCP server.
 *
 * Why this exists, stated without overselling: unit 1's gate is advisory. An
 * agent that calls `check()` and then edits with its own tool still has a window
 * between the two, and no fence can close that from the outside -- the writer is
 * a different program that may not ask. What the server adds is a *mediated*
 * path: `write` verifies the token and performs the write itself, so for the
 * resources where the race actually costs something (migration ordering, a
 * lockfile, a port registry) the window is gone rather than merely narrow.
 *
 * The second reason is plumbing. Every agent here already speaks MCP, and this
 * is the one interface that does not need a per-vendor plugin.
 *
 * There is no daemon. Each agent spawns its own server process; they share state
 * through the claim store on disk, and mutual exclusion between them comes from
 * the exclusive-create arbitration in lease.ts, not from a coordinator both have
 * to go through. That is deliberate: a coordinator would be a single point of
 * failure and would need liveness detection -- the exact thing unit 1 refuses to
 * trust.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  acquire,
  check,
  createStore,
  heartbeat,
  listClaims,
  release,
  renew,
  tryAcquire,
} from './lease.ts';
import type { Lease, Resource, Store } from './index.ts';

export type ServerConfig = {
  /** where claims live */
  storeRoot: string;
  /** what relative file resources and mediated writes are resolved against */
  projectRoot: string;
  /** name reported into claims, so a holder is identifiable in `status` */
  owner: string;
};

export function parseConfig(argv: string[]): ServerConfig {
  const flag = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : (argv[i + 1] ?? null);
  };
  const projectRoot = path.resolve(flag('root') ?? process.cwd());
  const storeRoot = path.resolve(flag('store') ?? path.join(projectRoot, '.fencepost'));
  return {
    storeRoot,
    projectRoot,
    owner: flag('owner') ?? process.env.FENCEPOST_OWNER ?? 'agent',
  };
}

/**
 * Mediated writes are confined to the project, and the confinement is re-checked
 * through the resolved path rather than the requested one.
 *
 * Checking only the requested string is the classic mistake: `src\..\..\windows`
 * *looks* like it is inside if you test the prefix before resolving, and a
 * symlink or junction inside the project can point straight out of it. So the
 * parent is resolved on the volume first, and the *resolved* location is what has
 * to be inside.
 */
function isInside(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Mediated writes are confined to the project, and the confinement is checked
 * through the resolved location rather than the requested string.
 *
 * Checking the requested string is the classic mistake: `src\..\..\windows`
 * passes a naive prefix test, and a symlink or junction *inside* the project can
 * point straight out of it. So the parent directory is resolved on the volume
 * first, and it is the resolved location that has to be inside.
 */
export function guardWriteTarget(
  projectRoot: string,
  storeRoot: string,
  requested: string
): string {
  if (path.isAbsolute(requested)) {
    throw new Error('absolute write targets are refused; resolve against the project root');
  }
  const abs = path.resolve(projectRoot, requested);
  if (!isInside(projectRoot, abs)) {
    throw new Error(`target escapes the project root: ${requested}`);
  }
  // Only meaningful once something exists to point at: resolve what is there.
  const realParent = realpathOrParent(abs);
  if (!isInside(projectRoot, realParent)) {
    throw new Error(
      `target reaches the project through a link that leaves it: ${requested} -> ${realParent}`
    );
  }
  if (isInside(storeRoot, abs)) {
    throw new Error(`the claim store is not a writable resource: ${requested}`);
  }
  return abs;
}

function realpathOrParent(p: string): string {
  const parent = path.dirname(p);
  try {
    return fs.realpathSync.native(parent);
  } catch {
    return parent;
  }
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

const resourceArg = z.object({
  kind: z.enum(['file', 'lock']).describe('file claims a path; lock claims a named resource'),
  target: z.string().min(1).describe('path relative to the project root, or a resource name'),
});

export function buildServer(cfg: ServerConfig): { server: McpServer; store: Store } {
  const store = createStore(cfg.storeRoot, { cwd: cfg.projectRoot });
  const held = new Map<number, { lease: Lease; resource: Resource; stop: () => void }>();

  const server = new McpServer({ name: 'fencepost', version: '0.0.3' });

  server.registerTool(
    'claim',
    {
      title: 'Claim a resource',
      description:
        'Take an exclusive lease on a path or named resource. Returns a fencing token that ' +
        'must be presented for every later step. The server keeps the lease alive for you.',
      inputSchema: {
        resource: resourceArg,
        ttlMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
        waitMs: z.number().int().min(0).max(120_000).default(0),
      },
    },
    async ({ resource, ttlMs, waitMs }) => {
      const res = resource as Resource;
      try {
        const out = tryAcquire(store, res, { ttlMs, waitMs, owner: cfg.owner });
        if (!out.ok) {
          return failure(
            `held by ${out.heldBy ?? 'another holder'}; the resource is not free within ${waitMs}ms`
          );
        }
        const stop = heartbeat(store, out.lease, (reason) => {
          process.stderr.write(`fencepost: lease ${out.lease.token} lost (${reason})\n`);
          held.delete(out.lease.token);
        });
        held.set(out.lease.token, { lease: out.lease, resource: res, stop });
        return json({ token: out.lease.token, expiresAtMs: out.lease.expiresAtMs, holderId: out.lease.holderId });
      } catch (e) {
        return failure(String(e));
      }
    }
  );

  server.registerTool(
    'assert',
    {
      title: 'Check a fencing token',
      description:
        'Returns whether this token is still the current one for the resource. Call before any ' +
        'write that goes through a tool other than `write`, and refuse to proceed when it says no.',
      inputSchema: { resource: resourceArg, token: z.number().int() },
    },
    async ({ resource, token }) =>
      json({ authorized: check(store, resource as Resource, token) })
  );

  server.registerTool(
    'renew',
    {
      title: 'Renew a lease',
      description: 'Extend a lease you already hold. Fails if the fence has moved past you.',
      inputSchema: { resource: resourceArg, token: z.number().int() },
    },
    async ({ resource, token }) => {
      const entry = held.get(token);
      if (!entry) return failure(`this server does not hold token ${token}`);
      const out = renew(store, entry.lease);
      if (out.status === 'lost') return failure(`renew refused: ${out.reason}`);
      return json({ token: out.token, expiresAtMs: out.expiresAtMs });
    }
  );

  server.registerTool(
    'release',
    {
      title: 'Release a lease',
      description: 'Give a resource back. A release by a holder that was already superseded is a no-op.',
      inputSchema: { resource: resourceArg, token: z.number().int() },
    },
    async ({ resource, token }) => {
      const entry = held.get(token);
      if (!entry) {
        // Still worth honoring: the caller may have restarted and lost its handle
        // but kept a live claim. Only release if the token genuinely matches.
        if (!check(store, resource as Resource, token)) return failure(`token ${token} is not current`);
        return json({ released: false, note: 'refusing to release a claim this server did not take' });
      }
      entry.stop();
      release(store, entry.lease);
      held.delete(token);
      return json({ released: true });
    }
  );

  server.registerTool(
    'write',
    {
      title: 'Mediated write',
      description:
        'Write a file only if the fencing token is current, deciding at the moment of the write. ' +
        'This is the path that closes the check-then-write window: the verification and the write ' +
        'happen here, in one step, instead of in the caller across two.',
      inputSchema: {
        resource: resourceArg,
        token: z.number().int(),
        // Separate from resource.target: what you claim need not be what you write,
        // e.g. claim a lock named `db:migrations` and write a file under it.
        path: z.string().min(1).describe('project-relative path of the file to write'),
        content: z.string(),
      },
    },
    async ({ resource, token, path: relPath, content }) => {
      // Order matters. Authorize first, then resolve the target: doing it the
      // other way would leak which paths exist to a caller holding a dead token.
      if (!check(store, resource as Resource, token)) {
        return failure('refused: this token is no longer current for that resource');
      }
      let abs: string;
      try {
        abs = guardWriteTarget(cfg.projectRoot, cfg.storeRoot, relPath);
      } catch (e) {
        return failure(String(e));
      }
      // Re-authorize immediately before the write, because resolving the target
      // took time and the fence may have moved during it. This is a smaller window,
      // not none -- the honest description is that both steps now happen on the
      // side that owns the fence, which is what makes the difference.
      if (!check(store, resource as Resource, token)) {
        return failure('refused: the fence moved while the target was being resolved');
      }
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      } catch (e) {
        return failure(`write failed: ${String(e)}`);
      }
      return json({ written: relPath, bytes: Buffer.byteLength(content) });
    }
  );

  server.registerTool(
    'status',
    {
      title: 'List claims',
      description: 'Every resource with a claim on it, whether it is currently held, and by whom.',
      inputSchema: {},
    },
    async () => json({ claims: listClaims(store) })
  );

  // No shutdown hook, deliberately. Unit 1's position is that a lease must
  // survive a holder dying at any instant -- SIGKILL, a power cut, a crashed
  // runtime -- which means the protocol cannot be relying on the holder to clean
  // up. Hooking exit here would make the tests pass while teaching the design to
  // depend on something that is not guaranteed. When a server dies, its leases
  // expire and the next holder takes over.
  return { server, store };
}

export async function runServer(argv: string[]): Promise<void> {
  const cfg = parseConfig(argv);
  const { server } = buildServer(cfg);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runServer(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`fencepost-server: ${String(e)}\n`);
    process.exitCode = 1;
  });
}
