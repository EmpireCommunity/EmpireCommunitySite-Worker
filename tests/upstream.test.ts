import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMembers, UPSTREAM_URL, type UpstreamIO } from '../src/upstream.ts';
const config = { inviteCode: 'approved-invite', guildId: '1010657521775681556' };
const RUN_AT = Date.parse('2026-11-14T12:00:00.000Z');
const valid = { code: config.inviteCode, guild: { id: config.guildId }, approximate_member_count: 888, fetchedAt: '2026-11-14T11:58:00.000Z' };
const candidateOf = async (input: typeof config, io: UpstreamIO) => (await fetchMembers(input, io, RUN_AT)).candidate;
function setup(...responses: (Response | Error)[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) fetcher.mockRejectedValueOnce(response);
    else fetcher.mockResolvedValueOnce(response);
  }
  const io: UpstreamIO = { fetch: fetcher, sleep: vi.fn(async () => {}) };
  return { io, fetcher };
}
afterEach(() => vi.useRealTimers());

describe('Relay external contract and retry rules (contract 2.3, 2.4)', () => {
  it('requests the fixed relay URL without credentials or redirects', async () => {
    const { io, fetcher } = setup(Response.json(valid));
    expect(await candidateOf(config, io)).toEqual({ ok: true, members: 888 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://empirecommunity.org/data/members-source.json');
    expect(url).toBe(UPSTREAM_URL);
    expect(init).toEqual({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'EmpireCommunitySite-members/1 (+https://empirecommunity.org)' } });
  });
  it.each([new Error('network'), new Response(null, { status: 503 })])('retries network/5xx at 2s and 6s, then succeeds', async (failure) => {
    const second = failure instanceof Error ? failure : new Response(null, { status: 500 });
    const { io, fetcher } = setup(failure, second, Response.json(valid));
    expect(await candidateOf(config, io)).toEqual({ ok: true, members: 888 });
    expect(vi.mocked(io.sleep).mock.calls).toEqual([[2000], [6000]]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('keeps unavailable after three failed attempts', async () => {
    const { io, fetcher } = setup(new Error('offline'), new Error('offline'), new Error('offline'));
    expect(await candidateOf(config, io)).toEqual({ ok: false, code: 'upstream_unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each(['0', '10'])('honors integer Retry-After=%s once', async (value) => {
    const { io, fetcher } = setup(new Response(null, { status: 429, headers: { 'Retry-After': value } }), Response.json(valid));
    expect(await candidateOf(config, io)).toEqual({ ok: true, members: 888 });
    expect(io.sleep).toHaveBeenCalledExactlyOnceWith(Number(value) * 1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([null, '11', '-1', 'NaN', '0.5', 'Wed, 11 Nov 2026 00:00:00 GMT'])('stops for Retry-After=%s', async (value) => {
    const { io, fetcher } = setup(new Response(null, { status: 429, headers: value === null ? {} : { 'Retry-After': value } }));
    expect(await candidateOf(config, io)).toEqual({ ok: false, code: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(io.sleep).not.toHaveBeenCalled();
  });
  it('does not retry a second 429 and caps mixed errors at three attempts', async () => {
    const rate = () => new Response(null, { status: 429, headers: { 'Retry-After': '1' } });
    const first = setup(rate(), rate());
    expect(await candidateOf(config, first.io)).toEqual({ ok: false, code: 'rate_limited' });
    expect(first.fetcher).toHaveBeenCalledTimes(2);
    const mixed = setup(new Error('offline'), rate(), new Error('offline'));
    expect(await candidateOf(config, mixed.io)).toEqual({ ok: false, code: 'upstream_unavailable' });
    expect(mixed.fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([
    [new Response('<html>edge challenge</html>', { status: 403, headers: { 'Content-Type': 'text/html' } }), 'invalid_response'],
    [new Response(null, { status: 403 }), 'invalid_response'],
    [new Response(null, { status: 302, headers: { Location: 'https://example.com/' } }), 'invalid_response'],
    [new Response('not JSON'), 'invalid_response'],
    [Response.json({ ...valid, guild: { id: 1010657521775681556 } }), 'invalid_response'],
  ])('does not retry invalid responses', async (response, code) => {
    const { io, fetcher } = setup(response);
    expect(await candidateOf(config, io)).toEqual({ ok: false, code });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    [403, undefined, 'invalid_response', false],
    [429, undefined, 'rate_limited', false],
    [429, '1', 'rate_limited', true],
    [302, undefined, 'invalid_response', false],
  ] as const)('preserves status %s when body cancellation rejects', async (status, retryAfter, code, retries) => {
    const cancel = vi.fn(async () => { throw new Error('cancel failed'); });
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
    });
    const { io, fetcher } = setup(response, Response.json(valid));
    expect(await candidateOf(config, io)).toEqual(retries ? { ok: true, members: 888 } : { ok: false, code });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(retries ? 2 : 1);
    expect(vi.mocked(io.sleep).mock.calls).toEqual(retries ? [[1000]] : []);
  });
  it.each([
    { ...config, inviteCode: '../bad' }, { ...config, inviteCode: 'x'.repeat(33) },
    { ...config, guildId: '123' }, { ...config, guildId: '1e18' },
  ])('rejects invalid public configuration before fetch', async (badConfig) => {
    const { io, fetcher } = setup();
    expect(await candidateOf(badConfig, io)).toEqual({ ok: false, code: 'invalid_response' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('counts streamed bytes rather than Content-Length and cancels past 64 KiB', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(40_000));
      controller.enqueue(new Uint8Array(30_000));
    }, cancel });
    const { io, fetcher } = setup(new Response(body, { headers: { 'Content-Length': '1' } }));
    expect(await candidateOf(config, io)).toEqual({ ok: false, code: 'invalid_response' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not retry an oversized response when abort errors its stream', async () => {
    const { io, fetcher } = setup();
    fetcher.mockImplementation(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_537));
        init!.signal!.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
      },
    })));
    expect(await candidateOf(config, io)).toEqual({ ok: false, code: 'invalid_response' });
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(io.sleep).not.toHaveBeenCalled();
  });
  it('accepts a valid JSON body at the cap', async () => {
    const body = JSON.stringify(valid).padEnd(65_536, ' ');
    const { io } = setup(new Response(body));
    expect(await candidateOf(config, io)).toEqual({ ok: true, members: 888 });
  });
  it('times out each attempt at 8 seconds with a fake clock', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const pending = candidateOf(config, { fetch: fetcher, sleep: async () => {} });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(await pending).toEqual({ ok: false, code: 'upstream_unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('keeps the 8 second timeout active while reading the response body', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Response(new ReadableStream({ start(controller) {
      init!.signal!.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
    } })));
    const pending = candidateOf(config, { fetch: fetcher, sleep: async () => {} });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(await pending).toEqual({ ok: false, code: 'upstream_unavailable' });
  });
});

describe('Relay answers specific to B-WK1 (contract 2.4, X1)', () => {
  const hour = 60 * 60 * 1000;
  const at = (offsetMs: number) => new Date(RUN_AT + offsetMs).toISOString();
  it('a 404 is the relay route missing: upstream_unavailable with the same retries, never invite_not_found', async () => {
    const { io, fetcher } = setup(new Response(null, { status: 404 }), new Response(null, { status: 404 }), new Response(null, { status: 404 }));
    expect(await fetchMembers(config, io, RUN_AT)).toEqual({ candidate: { ok: false, code: 'upstream_unavailable' }, httpStatus: 404 });
    expect(vi.mocked(io.sleep).mock.calls).toEqual([[2000], [6000]]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('a 404 then a good answer succeeds', async () => {
    const { io } = setup(new Response(null, { status: 404 }), Response.json(valid));
    expect(await fetchMembers(config, io, RUN_AT)).toEqual({ candidate: { ok: true, members: 888 }, httpStatus: 200 });
  });
  it.each([
    ['older than 24 h', at(-24 * hour - 1)],
    ['more than 5 minutes ahead', at(5 * 60 * 1000 + 1)],
  ])('a valid answer with fetchedAt %s is unavailable and retried', async (_name, fetchedAt) => {
    const stale = () => Response.json({ ...valid, fetchedAt });
    const { io, fetcher } = setup(stale(), stale(), stale());
    expect(await fetchMembers(config, io, RUN_AT)).toEqual({ candidate: { ok: false, code: 'upstream_unavailable' }, httpStatus: 200 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('a stale answer then a fresh one succeeds', async () => {
    const { io } = setup(Response.json({ ...valid, fetchedAt: at(-25 * hour) }), Response.json(valid));
    expect(await candidateOf(config, io)).toEqual({ ok: true, members: 888 });
  });
  it.each([
    ['missing', { ...valid, fetchedAt: undefined }],
    ['malformed', { ...valid, fetchedAt: '2026-11-14 11:58:00' }],
    ['not a real instant', { ...valid, fetchedAt: '2026-02-31T00:00:00.000Z' }],
  ])('a fetchedAt %s is invalid_response with no retry', async (_name, body) => {
    const { io, fetcher } = setup(Response.json(body));
    expect(await fetchMembers(config, io, RUN_AT)).toEqual({ candidate: { ok: false, code: 'invalid_response' }, httpStatus: 200 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('identity is checked before freshness: a wrong code with a stale time is invalid_response', async () => {
    const { io, fetcher } = setup(Response.json({ ...valid, code: 'other-invite', fetchedAt: at(-48 * hour) }));
    expect(await candidateOf(config, io)).toEqual({ ok: false, code: 'invalid_response' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['the last attempt had no response', [new Response(null, { status: 503 }), new Response(null, { status: 502 }), new Error('offline')], null],
    ['the last attempt answered after network errors', [new Error('offline'), new Error('offline'), new Response(null, { status: 404 })], 404],
    ['a refusal with no retry', [new Response('<html>blocked</html>', { status: 403 })], 403],
    ['a redirect', [new Response(null, { status: 301, headers: { Location: 'https://example.com/' } })], 301],
    ['a rate limit', [new Response(null, { status: 429 })], 429],
  ] as const)('httpStatus is the status of the last attempt: %s', async (_name, responses, httpStatus) => {
    const { io } = setup(...responses);
    expect((await fetchMembers(config, io, RUN_AT)).httpStatus).toBe(httpStatus);
  });
  it('invalid configuration makes no request and has no HTTP status', async () => {
    const { io, fetcher } = setup();
    expect(await fetchMembers({ ...config, guildId: '123' }, io, RUN_AT)).toEqual({ candidate: { ok: false, code: 'invalid_response' }, httpStatus: null });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
