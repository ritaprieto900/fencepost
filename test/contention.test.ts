import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createStore } from '../src/index.ts';

const HELPER = fileURLToPath(new URL('./helpers/holder.ts', import.meta.url));

function runWorker(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HELPER, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/**
 * N processes contend for one resource, each mutating it only while the fence
 * authorizes its token. Every append therefore happens inside a distinct,
 * serialized critical section -- which makes the log itself the oracle:
 *
 *  - strictly increasing fence numbers in file order prove no two holders were
 *    ever live at once (a double-holder appends out of order or repeats a
 *    token), and
 *  - the line count proves no holder was lost silently along the way.
 *
 * This is the property a lockfile-plus-PID design cannot give you: with a
 * lockfile, a racing pair of holders both append and both look valid.
 */
const WORKERS = 8;
const ROUNDS = 6;

test(
  'concurrent holders serialize and the fence number only ever advances',
  { timeout: 120_000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fencepost-contend-'));
    const log = path.join(root, 'append.log');
    fs.writeFileSync(log, '');
    createStore(root);

    const results = await Promise.all(
      Array.from({ length: WORKERS }, () =>
        runWorker([
          '--store', root,
          '--resource', 'shared-append',
          '--rounds', String(ROUNDS),
          '--hold', '3',
          '--ttl', '3000',
          '--out', log,
        ])
      )
    );

    const failures = results.filter((r) => r.code !== 0);
    assert.equal(
      failures.length,
      0,
      `workers reported violations:\n${failures.map((f) => f.stderr).join('\n')}`
    );

    const rows = fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => {
        const [token, pid, holder] = l.split('\t');
        return { token: Number(token), pid, holder };
      });

    assert.equal(
      rows.length,
      WORKERS * ROUNDS,
      'every holder must have appended exactly once per round'
    );

    let prev = 0;
    for (const [i, row] of rows.entries()) {
      assert.ok(
        row.token > prev,
        `fence number went backwards at log position ${i}: ${prev} -> ${row.token} ` +
          `(pid=${row.pid} holder=${row.holder}). Two processes held the resource at once.`
      );
      prev = row.token;
    }

    const seen = new Set<string>();
    for (const row of rows) {
      const id = `${row.holder}#${row.token}`;
      assert.ok(!seen.has(id), `a holder was issued the same fence number twice: ${id}`);
      seen.add(id);
    }
  }
);
