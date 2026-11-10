import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMembers, type UpstreamIO } from '../src/upstream.ts';
const config = { inviteCode: 'approved-invite', guildId: '1010657521775681556' };
const valid = { code: config.inviteCode, guild: { id: config.guildId }, approximate_member_count: 888 };
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

describe('Discord external contract and retry rules', () => {
  it('requests the fixed public API without credentials or redirects', async () => {
    const { io, fetcher } = setup(Response.json(valid));
    expect(await fetchMembers(config, io)).toEqual({ ok: true, members: 888 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://discord.com/api/v10/invites/approved-invite?with_counts=true');
    expect(init).toEqual({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'EmpireCommunitySite-members/1 (+https://empirecommunity.org)' } });
  });
  it.each([new Error('network'), new Response(null, { status: 503 })])('retries network/5xx at 2s and 6s, then succeeds', async (failure) => {
    const second = failure instanceof Error ? failure : new Response(null, { status: 500 });
    const { io, fetcher } = setup(failure, second, Response.json(valid));
    expect(await fetchMembers(config, io)).toEqual({ ok: true, members: 888 });
    expect(vi.mocked(io.sleep).mock.calls).toEqual([[2000], [6000]]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('keeps unavailable after three failed attempts', async () => {
    const { io, fetcher } = setup(new Error('offline'), new Error('offline'), new Error('offline'));
    expect(await fetchMembers(config, io)).toEqual({ ok: false, code: 'upstream_unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each(['0', '10'])('honors integer Retry-After=%s once', async (value) => {
    const { io, fetcher } = setup(new Response(null, { status: 429, headers: { 'Retry-After': value } }), Response.json(valid));
    expect(await fetchMembers(config, io)).toEqual({ ok: true, members: 888 });
    expect(io.sleep).toHaveBeenCalledExactlyOnceWith(Number(value) * 1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([null, '11', '-1', 'NaN', '0.5', 'Wed, 11 Nov 2026 00:00:00 GMT'])('stops for Retry-After=%s', async (value) => {
    const { io, fetcher } = setup(new Response(null, { status: 429, headers: value === null ? {} : { 'Retry-After': value } }));
    expect(await fetchMembers(config, io)).toEqual({ ok: false, code: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(io.sleep).not.toHaveBeenCalled();
  });
  it('does not retry a second 429 and caps mixed errors at three attempts', async () => {
    const rate = () => new Response(null, { status: 429, headers: { 'Retry-After': '1' } });
    const first = setup(rate(), rate());
    expect(await fetchMembers(config, first.io)).toEqual({ ok: false, code: 'rate_limited' });
    expect(first.fetcher).toHaveBeenCalledTimes(2);
    const mixed = setup(new Error('offline'), rate(), new Error('offline'));
    expect(await fetchMembers(config, mixed.io)).toEqual({ ok: false, code: 'upstream_unavailable' });
    expect(mixed.fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([
    [new Response(null, { status: 404 }), 'invite_not_found'],
    [new Response(null, { status: 403 }), 'invalid_response'],
    [new Response('not JSON'), 'invalid_response'],
    [Response.json({ ...valid, guild: { id: 1010657521775681556 } }), 'invalid_response'],
  ])('does not retry invalid responses or deleted invites', async (response, code) => {
    const { io, fetcher } = setup(response);
    expect(await fetchMembers(config, io)).toEqual({ ok: false, code });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...config, inviteCode: '../bad' }, { ...config, inviteCode: 'x'.repeat(33) },
    { ...config, guildId: '123' }, { ...config, guildId: '1e18' },
  ])('rejects invalid public configuration before fetch', async (badConfig) => {
    const { io, fetcher } = setup();
    expect(await fetchMembers(badConfig, io)).toEqual({ ok: false, code: 'invalid_response' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('counts streamed bytes rather than Content-Length and cancels past 64 KiB', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(40_000));
      controller.enqueue(new Uint8Array(30_000));
    }, cancel });
    const { io, fetcher } = setup(new Response(body, { headers: { 'Content-Length': '1' } }));
    expect(await fetchMembers(config, io)).toEqual({ ok: false, code: 'invalid_response' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('accepts a valid JSON body at the cap', async () => {
    const body = JSON.stringify(valid).padEnd(65_536, ' ');
    const { io } = setup(new Response(body));
    expect(await fetchMembers(config, io)).toEqual({ ok: true, members: 888 });
  });
  it('times out each attempt at 8 seconds with a fake clock', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const pending = fetchMembers(config, { fetch: fetcher, sleep: async () => {} });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(await pending).toEqual({ ok: false, code: 'upstream_unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('keeps the 8 second timeout active while reading the response body', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Response(new ReadableStream({ start(controller) {
      init!.signal!.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
    } })));
    const pending = fetchMembers(config, { fetch: fetcher, sleep: async () => {} });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(await pending).toEqual({ ok: false, code: 'upstream_unavailable' });
  });
});
