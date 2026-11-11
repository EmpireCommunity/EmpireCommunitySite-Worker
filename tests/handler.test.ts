import { describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import * as entrypoint from '../src/index.ts';
import worker from '../src/index.ts';
import { handleRequest, runScheduled, PUBLIC_URL, KV_KEY, type Env, type IO } from '../src/handlers.ts';

it('exports only the default Worker handler from the entrypoint', () => {
  expect(Object.keys(entrypoint)).toEqual(['default']);
  expect(entrypoint.default.fetch).toBeTypeOf('function');
  expect(entrypoint.default.scheduled).toBeTypeOf('function');
});

const now = '2026-11-10T12:00:00.000Z';
const record = { members: 888, updatedAt: now, source: 'discord-invite', consecutiveFailures: 0, outOfBandStreak: 0, lastError: null };
const publicBody = { schema: 1, discord: { members: 888, updatedAt: now, source: 'discord-invite' } };
function setup(value: unknown = record) {
  const store = { get: vi.fn<Env['MEMBERS_KV']['get']>(async () => value), put: vi.fn<Env['MEMBERS_KV']['put']>(async () => {}) };
  const cache = { match: vi.fn<Cache['match']>(async () => undefined), put: vi.fn<Cache['put']>(async () => {}) };
  const origin = new Response('built-in', { headers: { 'Cache-Control': 'public, max-age=300' } });
  const io: IO = {
    fetch: vi.fn<typeof fetch>(async () => origin), cache: () => cache,
    sleep: vi.fn(async () => {}), now: () => now,
  };
  const env: Env = { MEMBERS_KV: store, MEMBERS_SOURCE: 'discord-invite', DISCORD_INVITE_CODE: 'approved-invite', DISCORD_GUILD_ID: '1010657521775681556' };
  return { env, io, store, cache, origin };
}
// Normative public response schema from members-json v1; no internal KV fields.
const ajv = new Ajv2020();
addFormats(ajv);
const validate = ajv.compile({
  type: 'object', required: ['schema', 'discord'], properties: {
    schema: { const: 1 }, discord: {
      type: 'object', required: ['members', 'updatedAt', 'source'], properties: {
        members: { type: 'integer', minimum: 1, maximum: 1_000_000 },
        updatedAt: { type: 'string', format: 'date-time' },
        source: { enum: ['discord-invite', 'empirebot', 'built-in'] },
      },
    },
  },
});

describe('HTTP contract', () => {
  it.each(['GET', 'HEAD'])('%s serves validated KV with exact headers and a GET cache key', async (method) => {
    const { env, io, cache, store } = setup({ ...record, unexpected: '<script>' });
    const response = await handleRequest(new Request(PUBLIC_URL, { method, headers: { Range: 'bytes=0-1', Cookie: 'untrusted=value' } }), env, io);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({
      'cache-control': 'public, max-age=600', 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff',
    });
    expect(store.get).toHaveBeenCalledWith(KV_KEY, 'json');
    const [key, cached] = cache.put.mock.calls[0] as unknown as [Request, Response];
    expect(key.url).toBe(PUBLIC_URL);
    expect(key.method).toBe('GET');
    expect([...key.headers]).toEqual([]);
    const body = await cached.json();
    expect(validate(body)).toBe(true);
    expect(body).toEqual(publicBody);
    if (method === 'HEAD') expect(await response.text()).toBe('');
    else expect(await response.json()).toEqual(publicBody);
    expect(io.fetch).not.toHaveBeenCalled();
  });
  it.each(['GET', 'HEAD'])('%s cache hit skips KV and upstream', async (method) => {
    const { env, io, cache, store } = setup();
    cache.match.mockResolvedValue(new Response(JSON.stringify(publicBody)));
    const response = await handleRequest(new Request(PUBLIC_URL, { method }), env, io);
    expect(await response.text()).toBe(method === 'HEAD' ? '' : JSON.stringify(publicBody));
    expect(store.get).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['missing', null], ['wrong shape', {}], ['bad count', { ...record, members: '888' }],
    ['invalid timestamp', { ...record, updatedAt: '2026-02-31T00:00:00.000Z' }],
    ['invalid source', { ...record, source: 'untrusted' }],
  ])('%s KV passes original request to origin without caching it', async (_label, value) => {
    const { env, io, origin, cache } = setup(value);
    const request = new Request(PUBLIC_URL);
    expect(await handleRequest(request, env, io)).toBe(origin);
    expect(io.fetch).toHaveBeenCalledExactlyOnceWith(request);
    expect(cache.put).not.toHaveBeenCalled();
  });
  it.each(['read', 'cache match', 'cache put', 'cache unavailable'])('%s exception passes through once', async (failure) => {
    const { env, io, store, cache, origin } = setup();
    if (failure === 'read') store.get.mockRejectedValue(new Error('KV failure'));
    if (failure === 'cache match') cache.match.mockRejectedValue(new Error('cache failure'));
    if (failure === 'cache put') cache.put.mockRejectedValue(new Error('cache failure'));
    if (failure === 'cache unavailable') io.cache = () => { throw new Error('cache failure'); };
    expect(await handleRequest(new Request(PUBLIC_URL), env, io)).toBe(origin);
    expect(io.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS'])('%s gives 405 without I/O', async (method) => {
    const { env, io, store, cache } = setup();
    const response = await handleRequest(new Request(PUBLIC_URL, { method }), env, io);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
    expect(store.get).not.toHaveBeenCalled();
    expect(cache.match).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
  });
  it.each([`${PUBLIC_URL}?x=1`, `${PUBLIC_URL}/`, 'https://example.com/data/members.json'])(
    'does not cache or read KV outside exact URL %s', async (url) => {
      const { env, io, cache, store, origin } = setup();
      expect(await handleRequest(new Request(url), env, io)).toBe(origin);
      expect(cache.match).not.toHaveBeenCalled();
      expect(store.get).not.toHaveBeenCalled();
    },
  );
  it('default export accepts the real runtime ExecutionContext as its third argument', async () => {
    const { env, cache } = setup();
    vi.stubGlobal('caches', { default: cache });
    try {
      const entry: ExportedHandler<Env> = worker;
      const response = await entry.fetch!(new Request(PUBLIC_URL), env, {} as ExecutionContext);
      expect(await response.json()).toEqual(publicBody);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('Cron persistence contract', () => {
  it('writes only validated named fields with injected time', async () => {
    const { env, io, store } = setup();
    vi.mocked(io.fetch).mockResolvedValue(Response.json({ code: env.DISCORD_INVITE_CODE, guild: { id: env.DISCORD_GUILD_ID }, approximate_member_count: 900, private: 'discard' }));
    await runScheduled(env, io);
    expect(store.put).toHaveBeenCalledExactlyOnceWith(KV_KEY, JSON.stringify({ ...record, members: 900 }));
  });
  it('persists failure counters while keeping the last successful value and date', async () => {
    const { env, io, store } = setup();
    vi.mocked(io.fetch).mockResolvedValue(new Response(null, { status: 404 }));
    await runScheduled(env, io);
    expect(store.put).toHaveBeenCalledExactlyOnceWith(KV_KEY, JSON.stringify({ ...record, consecutiveFailures: 1, lastError: 'invite_not_found' }));
  });
  it('first failure leaves the key absent', async () => {
    const { env, io, store } = setup(null);
    vi.mocked(io.fetch).mockResolvedValue(new Response(null, { status: 404 }));
    await runScheduled(env, io);
    expect(store.put).not.toHaveBeenCalled();
  });
  it('does not overwrite unreadable KV, and contains KV write failures without logs', async () => {
    const { env, io, store } = setup();
    store.get.mockRejectedValueOnce(new Error('KV unavailable'));
    await runScheduled(env, io);
    expect(io.fetch).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
    store.put.mockRejectedValue(new Error('KV unavailable'));
    vi.mocked(io.fetch).mockResolvedValue(new Response(null, { status: 404 }));
    await expect(runScheduled(env, io)).resolves.toBeUndefined();
  });
  it('unknown source fails closed without an upstream call', async () => {
    const { env, io, store } = setup();
    await runScheduled({ ...env, MEMBERS_SOURCE: 'empirebot' }, io);
    expect(io.fetch).not.toHaveBeenCalled();
    expect(JSON.parse(store.put.mock.calls[0]![1] as string).lastError).toBe('invalid_response');
  });
});
