import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { permissions?: unknown; steps?: Step[]; uses?: string; 'timeout-minutes'?: number };
type Workflow = { on?: unknown; permissions?: unknown; jobs?: Record<string, Job> };
function requireRule(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}
function readOnly(value: unknown): boolean {
  return JSON.stringify(value) === '{"contents":"read"}';
}
for (const file of readdirSync('.github/workflows').filter((name) => /\.ya?ml$/.test(name))) {
  const raw = readFileSync(`.github/workflows/${file}`, 'utf8');
  const workflow = parse(raw) as Workflow;
  requireRule(!/CLOUDFLARE_|wrangler\s+deploy/.test(raw), `${file}: CI must never deploy or use build credentials`);
  const triggers = typeof workflow.on === 'string' ? [workflow.on]
    : Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on ?? {});
  requireRule(triggers.length > 0 && triggers.every((trigger) => ['push', 'pull_request'].includes(String(trigger))), `${file}: unsupported trigger`);
  requireRule(readOnly(workflow.permissions), `${file}: require contents: read only`);
  requireRule(Object.keys(workflow.jobs ?? {}).length > 0, `${file}: jobs required`);
  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    requireRule(job.permissions === undefined || readOnly(job.permissions), `${file}/${name}: excessive permissions`);
    requireRule(job.uses === undefined && Array.isArray(job.steps), `${file}/${name}: inline steps required`);
    requireRule(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes']! > 0 && job['timeout-minutes']! <= 15, `${file}/${name}: bounded timeout required`);
    for (const step of job.steps ?? []) {
      if (step.uses !== undefined) {
        requireRule(/^[^@\s]+@[a-f0-9]{40}$/.test(step.uses), `${file}/${name}: action needs full SHA`);
        if (step.uses.startsWith('actions/checkout@')) {
          requireRule(step.with?.['persist-credentials'] === false, `${file}/${name}: checkout credentials must not persist`);
        }
      }
      requireRule(!/\$\{\{/.test(step.run ?? ''), `${file}/${name}: pass expression data through env, never shell interpolation`);
    }
  }
}
process.stdout.write('Workflow controls passed.\n');
