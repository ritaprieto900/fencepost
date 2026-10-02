import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));

type ToolResult = { text: string; isError: boolean };

async function connect(store: string, root: string, owner: string): Promise<Client> {
  const client = new Client({ name: 'fencepost-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER, '--store', store, '--root', root, '--owner', owner],
      env: getDefaultEnvironment(),
      cwd: root,
    })
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = (result.content ?? []).map((c) => c.text ?? '').join('');
  return { text, isError: result.isError === true };
}

const asJson = <T>(r: ToolResult): T => JSON.parse(r.text) as T;

const claim = { kind: 'lock', target: 'db:migrations' } as const;

function workspace(): { store: string; root: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-mcp-'));
  return { store: path.join(base, '.fencepost'), root: base };
}

/**
 * Two agents, two machine boundaries, one shared truth.
 *
 * Each client spawns its own server process. Neither knows the other exists,
 * there is no daemon, no port, and no coordinator deciding who wins -- the
 * mutual exclusion is produced by the two processes racing an exclusive create on
 * one directory, which is the property the whole design rests on and the one
 * worth testing at this layer rather than at unit 1's.
 */
test(
  'two independent server processes contend, and neither is the other\'s coordinator',
  { timeout: 60_000 },
  async () => {
    const { store, root } = workspace();
    const a = await connect(store, root, 'agent-a');
    const b = await connect(store, root, 'agent-b');
    try {
      const taken = await call(a, 'claim', { resource: claim, ttlMs: 30_000 });
      assert.equal(taken.isError, false, taken.text);
      const { token } = asJson<{ token: number }>(taken);

      const refused = await call(b, 'claim', { resource: claim, ttlMs: 30_000, waitMs: 500 });
      assert.equal(refused.isError, true, 'a rival got the resource it should have been refused');
      assert.match(refused.text, /agent-a/, 'the refusal should name who holds it');

      // B must not be able to authorize its own invented token, nor borrow A's.
      assert.equal(asJson<{ authorized: boolean }>(await call(b, 'assert', { resource: claim, token: 99 })).authorized, false);
      assert.equal(asJson<{ authorized: boolean }>(await call(b, 'assert', { resource: claim, token })).authorized, true,
        'a second server process could not see the first one\'s claim');

      const released = await call(a, 'release', { resource: claim, token });
      assert.equal(released.isError, false, released.text);

      const nowFree = await call(b, 'claim', { resource: claim, ttlMs: 30_000, waitMs: 2_000 });
      assert.equal(nowFree.isError, false, `b stayed locked out after release: ${nowFree.text}`);
      const bToken = asJson<{ token: number }>(nowFree).token;
      assert.ok(bToken > token, `the fence did not advance across processes: ${token} -> ${bToken}`);
      await call(b, 'release', { resource: claim, token: bToken });
    } finally {
      await a.close();
      await b.close();
    }
  }
);

/**
 * The mediated write is the reason this unit exists: verification and mutation
 * happen in the same step, on the side that owns the fence. The advisory gate in
 * unit 1 can only shrink the window, because the writer is somebody else's code.
 */
test(
  'a mediated write is authorized at the moment it happens',
  { timeout: 60_000 },
  async () => {
    const { store, root } = workspace();
    const client = await connect(store, root, 'writer');
    try {
      const { token } = asJson<{ token: number }>(
        await call(client, 'claim', { resource: claim, ttlMs: 30_000 })
      );

      const wrote = await call(client, 'write', {
        resource: claim,
        token,
        path: 'migrations/0001_init.sql',
        content: 'create table t(id int);',
      });
      assert.equal(wrote.isError, false, wrote.text);
      assert.equal(
        fs.readFileSync(path.join(root, 'migrations', '0001_init.sql'), 'utf8'),
        'create table t(id int);'
      );

      // A stale token is refused at write time, not discovered afterwards.
      const stale = await call(client, 'write', {
        resource: claim,
        token: token + 100,
        path: 'migrations/0002_evil.sql',
        content: 'drop table t;',
      });
      assert.equal(stale.isError, true, 'a stale token performed a write');
      assert.equal(fs.existsSync(path.join(root, 'migrations', '0002_evil.sql')), false);
    } finally {
      await client.close();
    }
  }
);

test(
  'a mediated write cannot leave the project',
  { timeout: 60_000 },
  async () => {
    const { store, root } = workspace();
    const client = await connect(store, root, 'writer');
    const outside = path.join(root, '..', 'escaped.txt');
    try {
      const { token } = asJson<{ token: number }>(
        await call(client, 'claim', { resource: claim, ttlMs: 30_000 })
      );

      for (const bad of ['../escaped.txt', 'a/../../escaped.txt', path.join(os.tmpdir(), 'abs-escaped.txt')]) {
        const r = await call(client, 'write', { resource: claim, token, path: bad, content: 'x' });
        assert.equal(r.isError, true, `refused nothing for ${JSON.stringify(bad)}`);
      }
      assert.equal(fs.existsSync(outside), false, 'a traversal wrote outside the root');

      // The claim store itself is not writable through the tool: a stray write
      // there would silently corrupt every lease in the project.
      const intoStore = await call(client, 'write', {
        resource: claim,
        token,
        path: path.relative(root, path.join(store, 'claims', 'x.json')),
        content: '{}',
      });
      assert.equal(intoStore.isError, true, 'a mediated write landed inside the claim store');
    } finally {
      await client.close();
    }
  }
);

test(
  'status reports claims across processes, by label',
  { timeout: 60_000 },
  async () => {
    const { store, root } = workspace();
    const a = await connect(store, root, 'lister');
    try {
      await call(a, 'claim', { resource: { kind: 'lock', target: 'port:5173' }, ttlMs: 30_000 });
      const listed = asJson<{ claims: { label: string; live: boolean; owner: string | null }[] }>(
        await call(a, 'status', {})
      );
      const hit = listed.claims.find((c) => c.label === 'port:5173');
      assert.ok(hit, `status lost the label: ${JSON.stringify(listed.claims)}`);
      assert.equal(hit.live, true);
      assert.equal(hit.owner, 'lister');
    } finally {
      await a.close();
    }
  }
);
