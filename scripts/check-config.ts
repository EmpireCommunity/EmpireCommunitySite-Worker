import { readFileSync, readdirSync } from 'node:fs';
import { parse, type ParseError } from 'jsonc-parser';
import ts from 'typescript';

const errors: ParseError[] = [];
const config = parse(readFileSync('wrangler.jsonc', 'utf8'), errors) as Record<string, unknown>;
function requireRule(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}
function scanKeys(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    requireRule(!['route', 'routes', 'env', 'keep_vars'].includes(key), `Forbidden configuration key: ${key}`);
    scanKeys(child);
  }
}
requireRule(errors.length === 0 && config !== null && typeof config === 'object' && !Array.isArray(config), 'Invalid wrangler JSONC');
scanKeys(config);
requireRule(config.name === 'empirecommunity-members' && config.main === 'src/index.ts', 'Unexpected Worker identity/entrypoint');
requireRule(typeof config.compatibility_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date), 'Pin compatibility_date');
requireRule(config.workers_dev === false && config.preview_urls === false, 'Public alternate URLs must be disabled');
requireRule(JSON.stringify(config.observability) === '{"enabled":false}', 'Disable all observability');
requireRule(JSON.stringify(config.triggers) === '{"crons":["0 */12 * * *"]}', 'Only the twice-daily Cron is permitted');
const namespaces = config.kv_namespaces as { binding?: unknown; id?: unknown }[] | undefined;
requireRule(Array.isArray(namespaces) && namespaces.length === 1 && namespaces[0]?.binding === 'MEMBERS_KV'
  && typeof namespaces[0]?.id === 'string' && /^[a-fA-F0-9]{32}$/.test(namespaces[0].id), 'Exactly one MEMBERS_KV namespace required');
const vars = config.vars as Record<string, unknown> | undefined;
requireRule(vars !== undefined && Object.keys(vars).sort().join(',') === 'DISCORD_GUILD_ID,DISCORD_INVITE_CODE,MEMBERS_SOURCE', 'Only the three public vars are allowed');
requireRule(vars?.MEMBERS_SOURCE === 'discord-invite', 'Only discord-invite is implemented');
requireRule(typeof vars?.DISCORD_INVITE_CODE === 'string' && /^[A-Za-z0-9-]{2,32}$/.test(vars.DISCORD_INVITE_CODE), 'Invalid invite code');
requireRule(typeof vars?.DISCORD_GUILD_ID === 'string' && /^[0-9]{17,20}$/.test(vars.DISCORD_GUILD_ID), 'Guild ID must be a snowflake string');
for (const file of readdirSync('src', { recursive: true })) {
  if (typeof file === 'string' && file.endsWith('.ts')) {
    const source = readFileSync(`src/${file}`, 'utf8');
    requireRule(!/\bconsole\s*(?:\.|\[)/.test(source), `Logging forbidden: src/${file}`);
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        requireRule(ts.isStringLiteral(node.moduleSpecifier) && /^\.{1,2}\//.test(node.moduleSpecifier.text), `Runtime npm import forbidden: src/${file}`);
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
