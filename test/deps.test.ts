import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every bare package an import reaches must be declared somewhere.
 *
 * This exists because a package.json rewrite silently dropped `proper-lockfile`,
 * which only `npm run bench` imports -- so the README advertised a command that
 * crashed on arrival for anyone following the setup instructions. Neither
 * `npm test` nor `tsc` catches it: the tests never load the benchmark, and the
 * ambient declaration in `bench/proper-lockfile.d.ts` means TypeScript is
 * perfectly happy about an uninstalled module. Import graphs and dependency
 * manifests are checked separately by the ecosystem, and the gap between them is
 * where this kind of bug lives.
 */
const DECLARED = (() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
})();

const SELF = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name as string;

function bareSpecifier(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  // `@scope/name/sub/path` -> `@scope/name`; `name/sub` -> `name`
  const parts = spec.split('/');
  return spec.startsWith('@') ? (parts.slice(0, 2).join('/') || null) : (parts[0] ?? null);
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, acc);
    else if (/\.m?ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

test('every imported bare package is declared in package.json', () => {
  const undeclared = new Map<string, string[]>();
  const unresolved = new Map<string, string[]>();
  const resolve = createRequire(path.join(ROOT, 'noop.cjs')).resolve;

  for (const file of [
    ...sourceFiles(path.join(ROOT, 'src')),
    ...sourceFiles(path.join(ROOT, 'test')),
    ...sourceFiles(path.join(ROOT, 'bench')),
  ]) {
    const rel = path.relative(ROOT, file);
    for (const match of fs.readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? null;
      if (!spec) continue;
      const name = bareSpecifier(spec);
      if (name === null || name === SELF) continue;
      // Declared: catches an import whose dependency was dropped from the manifest.
      if (!DECLARED.has(name)) undeclared.set(name, [...(undeclared.get(name) ?? []), rel]);
      // Resolvable: catches declared-but-not-installed, which fails at run time
      // for whoever follows the README rather than for whoever runs the tests.
      try {
        resolve(spec, { paths: [path.dirname(file)] });
      } catch {
        unresolved.set(spec, [...(unresolved.get(spec) ?? []), rel]);
      }
    }
  }

  assert.equal(
    undeclared.size,
    0,
    'imports not present in dependencies/devDependencies/peerDependencies/optionalDependencies:\n' +
      [...undeclared].map(([n, files]) => `  ${n}  <- ${files.join(', ')}`).join('\n')
  );
  assert.equal(
    unresolved.size,
    0,
    'imports that cannot be resolved from this checkout:\n' +
      [...unresolved].map(([n, files]) => `  ${n}  <- ${files.join(', ')}`).join('\n')
  );
});

test('the declared entry points and bin targets exist on disk after a build', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) return; // unit 1 of a fresh checkout: nothing to check yet

  const targets: string[] = [];
  const collect = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('./')) targets.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(pkg.exports);
  collect(pkg.bin);

  const missing = targets.filter((t) => !fs.existsSync(path.join(ROOT, t)));
  assert.equal(missing.length, 0, `package.json points at files that were not built: ${missing.join(', ')}`);
});
