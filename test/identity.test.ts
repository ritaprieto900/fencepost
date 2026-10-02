import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  acquire,
  check,
  createResolver,
  createStore,
  foldLoopbackShare,
  normalizeSyntax,
  release,
  trimComponentEnds,
} from '../src/index.ts';

const win32 = process.platform === 'win32';
const LONG = 'identitylongdirectoryname';

/* ------------------------------------------------------------------ pure rules */

test('trailing dots and spaces are trimmed, interior dots are not', () => {
  assert.equal(trimComponentEnds('report.txt.'), 'report.txt');
  assert.equal(trimComponentEnds('report.txt...'), 'report.txt');
  assert.equal(trimComponentEnds('report  '), 'report');
  assert.equal(trimComponentEnds('report.tar.gz.'), 'report.tar.gz');
  assert.equal(trimComponentEnds('a.b'), 'a.b', 'an interior dot is part of the name');
});

test('loopback admin shares fold to a drive letter, real shares do not', () => {
  assert.equal(foldLoopbackShare('\\\\localhost\\c$\\Users\\x\\a.ts'), 'C:\\Users\\x\\a.ts');
  assert.equal(foldLoopbackShare('\\\\127.0.0.1\\d$\\proj\\a.ts'), 'D:\\proj\\a.ts');
  assert.equal(foldLoopbackShare('\\\\localhost\\c$'), 'C:\\');

  // Folding these would be an under-merge: a remote share really can be a
  // different file, and pretending otherwise invents a conflict that is not there
  // while hiding one that is.
  assert.equal(foldLoopbackShare('\\\\fileserver\\share\\a.ts'), '\\\\fileserver\\share\\a.ts');
  assert.equal(foldLoopbackShare('C:\\Users\\x'), 'C:\\Users\\x');
});

test('win32 syntax folds separators, drive case, and the extended-length prefix', () => {
  const base = normalizeSyntax('C:\\repo\\src\\a.ts', true, 'C:\\repo');
  assert.equal(normalizeSyntax('c:/repo/src/a.ts', true, 'C:\\repo'), base);
  assert.equal(normalizeSyntax('\\\\?\\C:\\repo\\src\\a.ts', true, 'C:\\repo'), base);
  assert.equal(normalizeSyntax('\\\\.\\C:\\repo\\src\\a.ts', true, 'C:\\repo'), base);
  assert.equal(normalizeSyntax('C:\\repo\\src\\sub\\..\\a.ts', true, 'C:\\repo'), base);
  assert.ok(/^[A-Z]:\\/.test(base), `drive letter should be folded upper: ${base}`);

  // The prefix must be removed *before* separators collapse, or `\\?\C:\a` is
  // first flattened to `\?\C:\a` and then re-rooted as `C:\?\C:\a`.
  assert.equal(normalizeSyntax('c:/repo/src/../src/a.ts', true, 'C:\\repo'), base);
});

test('a UNC path keeps its authority instead of being re-rooted at the drive', () => {
  assert.equal(
    normalizeSyntax('\\\\server\\share\\a\\b.ts', true, 'C:\\repo'),
    '\\\\SERVER\\share\\a\\b.ts'
  );
  assert.equal(
    normalizeSyntax('//server/share/a/../b.ts', true, 'C:\\repo'),
    '\\\\SERVER\\share\\b.ts'
  );
  // Two servers, two shares: never one identity.
  assert.notEqual(
    normalizeSyntax('\\\\server\\share\\a.ts', true, 'C:\\repo'),
    normalizeSyntax('\\\\other\\share\\a.ts', true, 'C:\\repo')
  );
  assert.notEqual(
    normalizeSyntax('\\\\server\\one\\a.ts', true, 'C:\\repo'),
    normalizeSyntax('\\\\server\\two\\a.ts', true, 'C:\\repo')
  );
});

test('a drive root keeps its separator instead of becoming drive-relative', () => {
  // `C:` with no slash means "C: relative to the cwd on C:", so the key would
  // silently point at something different depending on where you started.
  assert.equal(normalizeSyntax('C:\\', true, 'D:\\elsewhere'), 'C:\\');
});

test('posix identity keeps case and does not trim', () => {
  assert.equal(normalizeSyntax('/repo/A.ts', false, '/repo'), '/repo/A.ts');
  assert.equal(normalizeSyntax('/repo//src/./a.ts', false, '/repo'), '/repo/src/a.ts');
  const r = createResolver({ platform: 'posix', cwd: '/repo', realp: () => null });
  assert.notEqual(
    r.key({ kind: 'file', target: '/repo/a.ts' }),
    r.key({ kind: 'file', target: '/repo/A.TS' })
  );
});

test('a named lock can never collide with a path claim', () => {
  const r = createResolver({ platform: 'posix', cwd: '/repo', realp: () => null });
  const asLock = r.key({ kind: 'lock', target: 'x' });
  assert.notEqual(r.key({ kind: 'file', target: 'x' }), asLock);

  // The namespace tag is separated by NUL, which cannot appear in a path, so no
  // target can be spelled to look like the other namespace.
  assert.notEqual(
    r.key({ kind: 'file', target: '\u0000lock\u0000x' }),
    asLock,
    'a crafted path forged into the lock namespace'
  );
});

/* ------------------------------------------------------- against a real volume */

/**
 * Everything above is arithmetic. This is what matters: these spellings all reach
 * one file on one volume, so they must produce one key. Where they do not, two
 * agents each hold a lease the library believes is uncontested -- and the
 * resulting corruption involves no fencing token at all, because the fence is per
 * key.
 */
type Volume = { root: string; dir: string; file: string; dispose(): void };

function makeVolume(): Volume {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-identity-'));
  const dir = path.join(root, LONG);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'target.txt');
  fs.writeFileSync(file, 'contents');
  return { root, dir, file, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** The store lives outside the volume so a sweep can never eat live claims. */
function storeBeside(vol: Volume): ReturnType<typeof createStore> {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-identity-store-'));
  const store = createStore(storeRoot, { cwd: vol.root });
  disposables.push(storeRoot);
  return store;
}

const disposables: string[] = [];
process.on('exit', () => {
  for (const dir of disposables) fs.rmSync(dir, { recursive: true, force: true });
});

function shortFormOf(filePath: string): string | null {
  const dir = path.dirname(filePath);
  const base = path.basename(dir);
  if (base.length <= 6) return null;
  const candidate = path.join(
    path.dirname(dir),
    `${base.slice(0, 6).toUpperCase()}~1`,
    path.basename(filePath)
  );
  return fs.existsSync(candidate) ? candidate : null;
}

function canMakeJunction(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-identity-jct-'));
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', path.join(probe, 'l'), probe], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

test(
  'one file, every spelling that reaches it, one key',
  { skip: win32 ? false : 'win32 alias behaviour is what is under test' },
  (t) => {
    const vol = makeVolume();
    try {
      const r = createResolver({ cwd: vol.root });
      const spellings = [
        vol.file,
        vol.file.toUpperCase(),
        vol.file.replace(/\\/g, '/'),
        path.join(vol.root, LONG, '..', LONG, 'target.txt'),
        `\\\\?\\${vol.file}`,
        `${vol.file}.`, // Node: a second file. Win32: the same one.
        path.join(path.dirname(vol.file), '.', 'target.txt'),
      ];

      // A relative spelling must agree with the absolute one, which is why cwd is
      // part of identity rather than a convenience.
      spellings.push(r.syntax('target.txt') === vol.file ? 'target.txt' : path.join(vol.dir, 'target.txt'));

      const short = shortFormOf(vol.file);
      if (short === null) {
        t.diagnostic('8.3 short name not generated on this volume; that alias was not exercised');
      } else {
        spellings.push(short);
      }

      const grouped = new Map<string, string[]>();
      for (const s of spellings) {
        const k = r.key({ kind: 'file', target: s });
        grouped.set(k, [...(grouped.get(k) ?? []), s]);
      }
      assert.equal(
        grouped.size,
        1,
        `identity split one file across ${grouped.size} keys:\n` +
          [...grouped.entries()]
            .map(([k, list]) => `  ${k.slice(0, 8)}\n    ${list.join('\n    ')}`)
            .join('\n')
      );

      const store = storeBeside(vol);
      const lease = acquire(store, { kind: 'file', target: vol.file }, { ttlMs: 60_000 });
      assert.equal(
        check(store, { kind: 'file', target: vol.file.toUpperCase() }, lease.token),
        true,
        'the fence could not see a lease taken under a different spelling'
      );
      release(store, lease);
    } finally {
      vol.dispose();
    }
  }
);

test(
  'a junction is an alias for its target, not a separate resource',
  { skip: !win32 || !canMakeJunction() ? 'needs win32 reparse-point support' : false },
  () => {
    const vol = makeVolume();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-identity-else-'));
    try {
      const realFile = path.join(elsewhere, 'shared.txt');
      fs.writeFileSync(realFile, 'y');
      const link = path.join(vol.root, 'mount');
      execFileSync('cmd', ['/c', 'mklink', '/J', link, elsewhere], { encoding: 'utf8' });

      const r = createResolver({ cwd: vol.root });
      assert.equal(
        r.key({ kind: 'file', target: path.join(link, 'shared.txt') }),
        r.key({ kind: 'file', target: realFile }),
        'a path through a junction got its own key, so two agents can hold one file'
      );
    } finally {
      fs.rmSync(path.join(vol.root, 'mount'), { force: true });
      vol.dispose();
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  }
);

/**
 * A claim is normally taken on a file that does not exist yet -- claiming before
 * writing is the point. `realpathSync.native` refuses any path whose final
 * component is missing, so identity resolves the deepest existing ancestor and
 * re-attaches the rest. Without that, `dir/new.ts` and `dir/x/../new.ts` diverge
 * precisely when it matters most.
 */
test('identity of a file that does not exist yet matches its eventual location', () => {
  const vol = makeVolume();
  try {
    const r = createResolver({ cwd: vol.root });
    const missing = path.join(vol.dir, 'brandnew.ts');
    assert.equal(fs.existsSync(missing), false, 'the target must not exist for this test');
    const viaDotDot = path.join(vol.dir, 'x', '..', 'brandnew.ts');
    assert.equal(r.key({ kind: 'file', target: missing }), r.key({ kind: 'file', target: viaDotDot }));

    const store = storeBeside(vol);
    const lease = acquire(store, { kind: 'file', target: missing }, { ttlMs: 60_000 });
    assert.equal(check(store, { kind: 'file', target: viaDotDot }, lease.token), true);

    // Once it exists, the same claim must still name the same resource.
    fs.writeFileSync(missing, 'now it exists');
    assert.equal(check(store, { kind: 'file', target: missing }, lease.token), true);
    release(store, lease);
  } finally {
    vol.dispose();
  }
});

/**
 * KNOWN LIMITATION, asserted so it cannot be forgotten or "fixed" silently.
 *
 * `realpath` does not unify hard links, so two links to one file get two keys and
 * two agents each hold an uncontested lease -- the one case where unit 1's fence
 * cannot help, because nothing is stale. `stat` reports the same `dev` and `ino`
 * for both, so the true identity is available and simply not being used.
 *
 * Closing it needs multi-key acquisition (identity = {path, dev:ino}, claims taken in
 * sorted key order to stay deadlock-free), which changes every signature in
 * `lease.ts`. See docs/design-02-resource-identity.md. This test deliberately fails
 * the day someone implements it, so the docs get updated with it.
 */
test(
  'hard links are two identities today',
  { skip: !win32 || !canMakeHardLink() ? 'needs win32 hard-link support' : false },
  () => {
    const vol = makeVolume();
    try {
      const link = path.join(vol.root, 'second-name.txt');
      execFileSync('cmd', ['/c', 'mklink', '/H', link, vol.file], { encoding: 'utf8' });

      const r = createResolver({ cwd: vol.root });
      const viaOriginal = r.key({ kind: 'file', target: vol.file });
      const viaLink = r.key({ kind: 'file', target: link });
      assert.notEqual(viaOriginal, viaLink, 'identity started unifying hard links: update the docs');

      // ...while the filesystem says unambiguously that it is one file.
      assert.equal(fs.statSync(vol.file).ino, fs.statSync(link).ino);
      assert.equal(fs.statSync(link).nlink, 2);
    } finally {
      vol.dispose();
    }
  }
);

function canMakeHardLink(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-identity-hl-'));
  try {
    const a = path.join(probe, 'a.txt');
    fs.writeFileSync(a, 'x');
    execFileSync('cmd', ['/c', 'mklink', '/H', path.join(probe, 'b.txt'), a], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

test('resolution is cached, so a hot resource does not re-syscall every check', () => {
  let calls = 0;
  const r = createResolver({
    cwd: '/repo',
    platform: 'posix',
    realp: (p) => {
      calls++;
      return p === '/repo/a.ts' ? '/repo/a.ts' : null;
    },
  });
  const target = { kind: 'file', target: '/repo/a.ts' } as const;
  r.key(target);
  const afterFirst = calls;
  r.key(target);
  assert.equal(calls, afterFirst, 'a resolved path should not issue another syscall');
  assert.equal(r.cacheSize(), 1);
});
