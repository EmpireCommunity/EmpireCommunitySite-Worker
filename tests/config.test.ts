import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'jsonc-parser';
import { expect, it } from 'vitest';

it.each([
  ['empirecommunitysite-worker', 'a'.repeat(32), true],
  ['empirecommunity-members', 'a'.repeat(32), false],
  ['empirecommunitysite-worker', '0'.repeat(32), false],
  ['empirecommunitysite-worker', 'invalid-id', false],
])('validates Worker identity %s and namespace %s', (name, id, accepted) => {
  const directory = mkdtempSync(join(tmpdir(), 'worker-config-'));
  try {
    const config = parse(readFileSync('wrangler.jsonc', 'utf8'));
    config.name = name;
    config.kv_namespaces[0].id = id;
    writeFileSync(join(directory, 'wrangler.jsonc'), JSON.stringify(config));
    symlinkSync(resolve('src'), join(directory, 'src'), 'dir');
    const result = spawnSync(process.execPath, [resolve('scripts/check-config.ts')], {
      cwd: directory, encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(accepted ? 0 : 1);
    if (!accepted) expect(result.stderr).toContain(name === 'empirecommunity-members'
      ? 'Unexpected Worker identity/entrypoint' : 'Exactly one MEMBERS_KV namespace required');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it.each([
  ['.wrangler/deploy/config.json', '{}', 'Generated configuration forbidden', undefined],
  ['wrangler.toml', 'name = "other"', 'Unexpected Wrangler configuration file', undefined],
  ['wrangler.json', '{}', 'Unexpected Wrangler configuration file', undefined],
  ['wrangler.other.jsonc', '{}', 'Unexpected Wrangler configuration file', undefined],
  [undefined, undefined, 'Unexpected configuration key', 'unexpected'],
  ['src/extra.js', 'console.log("test");', 'Logging forbidden', undefined],
  ['src/extra.js', 'import value from "external";', 'Runtime npm import forbidden', undefined],
  ['src/extra.js', 'import value from "../outside.js";', 'Import outside src forbidden', undefined],
  ['src/nested/extra.ts', 'export * from "../../outside.ts";', 'Import outside src forbidden', undefined],
  ['src/extra.js', 'import("./rules.ts");', 'Dynamic import/require forbidden', undefined],
  ['src/linked.ts', undefined, 'Source symlinks forbidden', undefined],
])('rejects invalid configuration or source: %s %s', (file, source, message, key) => {
  const directory = mkdtempSync(join(tmpdir(), 'worker-config-'));
  try {
    const config = parse(readFileSync('wrangler.jsonc', 'utf8'));
    if (key) config[key] = true;
    writeFileSync(join(directory, 'wrangler.jsonc'), JSON.stringify(config));
    cpSync(resolve('src'), join(directory, 'src'), { recursive: true });
    mkdirSync(join(directory, 'src/nested'));
    if (file && source) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), source);
    }
    else if (file) symlinkSync(join(directory, 'outside.ts'), join(directory, file));
    const result = spawnSync(process.execPath, [resolve('scripts/check-config.ts')], {
      cwd: directory, encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
