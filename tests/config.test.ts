import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
