import { checkFreshness, parseInvite, type Candidate, type InviteConfig } from './rules.ts';

export interface UpstreamIO {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
}
/** The relay on the VPS (contract 2.11, B-WK1): a constant, never a variable, so the Worker has one destination. */
export const UPSTREAM_URL = 'https://empirecommunity.org/data/members-source.json';
/** The candidate of a run and the HTTP status of its last attempt, `null` when that attempt got no HTTP response. */
export interface Fetched { candidate: Candidate; httpStatus: number | null }
const BODY_LIMIT = 64 * 1024;
const TIMEOUT_MS = 8000;
const unavailable: Candidate = { ok: false, code: 'upstream_unavailable' };
const invalid: Candidate = { ok: false, code: 'invalid_response' };

async function readBody(response: Response, controller: AbortController): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) {
        controller.abort();
        await reader.cancel().catch(() => { /* Abort may already have errored the stream. */ });
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
    catch { return null; }
  } finally { reader.releaseLock(); }
}

/** Identity and bounds first (`invalid_response`), then the relay time: stale is unavailable, malformed is invalid. */
function validate(json: unknown, config: InviteConfig, now: number): Candidate {
  const parsed = parseInvite(json, config);
  if (!parsed.ok) return parsed;
  const freshness = checkFreshness(json, now);
  if (freshness === 'fresh') return parsed;
  return freshness === 'stale' ? unavailable : invalid;
}

async function attempt(config: InviteConfig, io: UpstreamIO, now: number): Promise<Fetched & { retryAfter?: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let httpStatus: number | null = null;
  try {
    const response = await io.fetch(UPSTREAM_URL, { method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { 'User-Agent': 'EmpireCommunitySite-members/1 (+https://empirecommunity.org)' } });
    httpStatus = response.status;
    if (response.status === 200) return { candidate: validate(await readBody(response, controller), config, now), httpStatus };
    await response.body?.cancel().catch(() => { /* Preserve the HTTP status if cleanup fails. */ });
    if (response.status === 429) {
      const header = response.headers.get('Retry-After');
      const retryAfter = header !== null && /^(?:[0-9]|10)$/.test(header) ? Number(header) * 1000 : undefined;
      return { candidate: { ok: false, code: 'rate_limited' }, httpStatus, ...(retryAfter !== undefined ? { retryAfter } : {}) };
    }
    // A 404 is the relay router missing or outranked (the site answered), never a removed invite (X1).
    if (response.status === 404 || response.status >= 500) return { candidate: unavailable, httpStatus };
    return { candidate: invalid, httpStatus };
  } catch { return { candidate: unavailable, httpStatus }; }
  finally { clearTimeout(timeout); }
}

/** `now` is the run time in milliseconds, injected for the freshness rule. */
export async function fetchMembers(config: InviteConfig, io: UpstreamIO, now: number): Promise<Fetched> {
  if (!/^[A-Za-z0-9-]{2,32}$/.test(config.inviteCode) || !/^[0-9]{17,20}$/.test(config.guildId)) {
    return { candidate: invalid, httpStatus: null };
  }
  let rateRetried = false;
  let networkRetries = 0;
  for (let count = 0; ; count++) {
    const { candidate, httpStatus, retryAfter } = await attempt(config, io, now);
    const result = { candidate, httpStatus };
    if (candidate.ok || count === 2) return result;
    if (candidate.code === 'upstream_unavailable' && networkRetries < 2) {
      await io.sleep(networkRetries++ === 0 ? 2000 : 6000);
    } else if (candidate.code === 'rate_limited' && !rateRetried && retryAfter !== undefined) {
      rateRetried = true;
      await io.sleep(retryAfter);
    } else return result;
  }
}
