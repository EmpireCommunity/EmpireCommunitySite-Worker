import { parseInvite, type Candidate, type InviteConfig } from './rules.ts';

export interface UpstreamIO {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
}
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

async function attempt(config: InviteConfig, io: UpstreamIO): Promise<{ candidate: Candidate; retryAfter?: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await io.fetch(
      `https://discord.com/api/v10/invites/${encodeURIComponent(config.inviteCode)}?with_counts=true`,
      { method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { 'User-Agent': 'EmpireCommunitySite-members/1 (+https://empirecommunity.org)' } },
    );
    if (response.status === 200) return { candidate: parseInvite(await readBody(response, controller), config) };
    await response.body?.cancel();
    if (response.status === 429) {
      const header = response.headers.get('Retry-After');
      const retryAfter = header !== null && /^(?:[0-9]|10)$/.test(header) ? Number(header) * 1000 : undefined;
      return { candidate: { ok: false, code: 'rate_limited' }, ...(retryAfter !== undefined ? { retryAfter } : {}) };
    }
    if (response.status === 404) return { candidate: { ok: false, code: 'invite_not_found' } };
    return { candidate: response.status >= 500 ? unavailable : invalid };
  } catch { return { candidate: unavailable }; }
  finally { clearTimeout(timeout); }
}

export async function fetchMembers(config: InviteConfig, io: UpstreamIO): Promise<Candidate> {
  if (!/^[A-Za-z0-9-]{2,32}$/.test(config.inviteCode) || !/^[0-9]{17,20}$/.test(config.guildId)) return invalid;
  let rateRetried = false;
  let networkRetries = 0;
  for (let count = 0; count < 3; count++) {
    const { candidate, retryAfter } = await attempt(config, io);
    if (candidate.ok || count === 2) return candidate;
    if (candidate.code === 'upstream_unavailable' && networkRetries < 2) {
      await io.sleep(networkRetries++ === 0 ? 2000 : 6000);
    } else if (candidate.code === 'rate_limited' && !rateRetried && retryAfter !== undefined) {
      rateRetried = true;
      await io.sleep(retryAfter);
    } else return candidate;
  }
  return unavailable;
}
