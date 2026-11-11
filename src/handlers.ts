import { decide, parseRecord } from './rules.ts';
import { fetchMembers, type UpstreamIO } from './upstream.ts';

export const PUBLIC_URL = 'https://empirecommunity.org/data/members.json';
export const KV_KEY = 'members:v1';
export interface Env {
  MEMBERS_KV: {
    get(key: string, type: 'json'): Promise<unknown>;
    put(key: string, value: string): Promise<void>;
  };
  MEMBERS_SOURCE: string;
  DISCORD_INVITE_CODE: string;
  DISCORD_GUILD_ID: string;
}
export interface IO extends UpstreamIO {
  now: () => string;
  cache: () => Pick<Cache, 'match' | 'put'>;
}
const runtime: IO = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date().toISOString(),
  cache: () => caches.default,
};
const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=600',
  'X-Content-Type-Options': 'nosniff',
};
function head(response: Response, request: Request): Response {
  return request.method === 'HEAD' ? new Response(null, response) : response;
}

export async function handleRequest(request: Request, env: Env, io: IO = runtime): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  try {
    if (request.url === PUBLIC_URL) {
      const cache = io.cache();
      const key = new Request(PUBLIC_URL, { method: 'GET' });
      const cached = await cache.match(key);
      if (cached) return head(cached, request);
      const record = parseRecord(await env.MEMBERS_KV.get(KV_KEY, 'json'));
      if (record !== null) {
        const response = new Response(JSON.stringify({ schema: 1, discord: {
          members: record.members, updatedAt: record.updatedAt, source: record.source,
        } }), { status: 200, headers });
        await cache.put(key, response.clone());
        return head(response, request);
      }
    }
  } catch {
    // Cache/KV/response errors fall through exactly once to the original request.
  }
  return io.fetch(request);
}

export async function runScheduled(env: Env, io: IO = runtime): Promise<void> {
  try {
    const last = parseRecord(await env.MEMBERS_KV.get(KV_KEY, 'json'));
    const candidate = env.MEMBERS_SOURCE === 'discord-invite'
      ? await fetchMembers({ inviteCode: env.DISCORD_INVITE_CODE, guildId: env.DISCORD_GUILD_ID }, io)
      : { ok: false as const, code: 'invalid_response' as const };
    const { record } = decide(last, candidate, io.now());
    if (record !== null) await env.MEMBERS_KV.put(KV_KEY, JSON.stringify(record));
  } catch {
    // A failed KV read must not overwrite the last good value; no logs (D-20).
  }
}
