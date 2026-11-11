import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import ts from 'typescript';

const errors: ParseError[] = [];
const config = parse(readFileSync('wrangler.jsonc', 'utf8'), errors) as Record<string, unknown>;
function requireRule(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}
requireRule(!existsSync('.wrangler/deploy/config.json'), 'Generated configuration forbidden');
for (const file of readdirSync('.')) {
  requireRule(file === 'wrangler.jsonc' || !/^wrangler(?:\..+)?\.(?:jsonc?|toml)$/i.test(file),
    `Unexpected Wrangler configuration file: ${file}`);
}
requireRule(errors.length === 0 && config !== null && typeof config === 'object' && !Array.isArray(config), 'Invalid wrangler JSONC');
const allowedKeys = new Set([
  '$schema', 'name', 'main', 'compatibility_date', 'workers_dev', 'preview_urls',
  'triggers', 'kv_namespaces', 'vars', 'observability',
]);
for (const key of Object.keys(config)) requireRule(allowedKeys.has(key), `Unexpected configuration key: ${key}`);
requireRule(config.name === 'empirecommunitysite-worker' && config.main === 'src/index.ts', 'Unexpected Worker identity/entrypoint');
requireRule(typeof config.compatibility_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date), 'Pin compatibility_date');
requireRule(config.workers_dev === false && config.preview_urls === false, 'Public alternate URLs must be disabled');
requireRule(JSON.stringify(config.observability) === '{"enabled":false}', 'Disable all observability');
requireRule(JSON.stringify(config.triggers) === '{"crons":["0 */12 * * *"]}', 'Only the twice-daily Cron is permitted');
const namespaces = config.kv_namespaces as { binding?: unknown; id?: unknown }[] | undefined;
requireRule(Array.isArray(namespaces) && namespaces.length === 1 && namespaces[0]?.binding === 'MEMBERS_KV'
  && typeof namespaces[0]?.id === 'string' && /^[a-fA-F0-9]{32}$/.test(namespaces[0].id)
  && namespaces[0].id !== '0'.repeat(32), 'Exactly one MEMBERS_KV namespace required');
const vars = config.vars as Record<string, unknown> | undefined;
requireRule(vars !== undefined && Object.keys(vars).sort().join(',') === 'DISCORD_GUILD_ID,DISCORD_INVITE_CODE,MEMBERS_SOURCE', 'Only the three public vars are allowed');
requireRule(vars?.MEMBERS_SOURCE === 'discord-invite', 'Only discord-invite is implemented');
requireRule(typeof vars?.DISCORD_INVITE_CODE === 'string' && /^[A-Za-z0-9-]{2,32}$/.test(vars.DISCORD_INVITE_CODE), 'Invalid invite code');
requireRule(typeof vars?.DISCORD_GUILD_ID === 'string' && /^[0-9]{17,20}$/.test(vars.DISCORD_GUILD_ID), 'Guild ID must be a snowflake string');
const sourceRoot = resolve('src');
for (const entry of readdirSync('src', { recursive: true, withFileTypes: true })) {
  requireRule(!entry.isSymbolicLink(), 'Source symlinks forbidden');
  if (entry.isFile()) {
    const file = relative(sourceRoot, resolve(entry.parentPath, entry.name));
    const source = readFileSync(resolve(sourceRoot, file), 'utf8');
    requireRule(!/\bconsole\s*(?:\.|\[)/.test(source), `Logging forbidden: src/${file}`);
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        requireRule(ts.isStringLiteral(node.moduleSpecifier) && /^\.{1,2}\//.test(node.moduleSpecifier.text), `Runtime npm import forbidden: src/${file}`);
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          const target = relative(sourceRoot, resolve(dirname(resolve(sourceRoot, file)), node.moduleSpecifier.text));
          requireRule(target !== '..' && !target.startsWith('../') && !isAbsolute(target), `Import outside src forbidden: src/${file}`);
        }
      }
      requireRule(!ts.isImportEqualsDeclaration(node), `Import assignment forbidden: src/${file}`);
      if (ts.isCallExpression(node)) {
        requireRule(node.expression.kind !== ts.SyntaxKind.ImportKeyword
          && !(ts.isIdentifier(node.expression) && node.expression.text === 'require'), `Dynamic import/require forbidden: src/${file}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
}
process.stdout.write('Worker configuration controls passed.\n');
