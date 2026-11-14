import { describe, expect, it } from 'vitest';
import {
  checkFreshness, decide, parseInvite, parseRecord, runStatus, type Candidate, type FetchErrorCode, type MemberRecord,
} from '../src/rules.ts';

const now = '2026-11-10T12:00:00.000Z';
const config = { inviteCode: 'approved-invite', guildId: '123456789' };
const valid = { code: config.inviteCode, guild: { id: config.guildId }, approximate_member_count: 888 };
const last: MemberRecord = {
  members: 888, updatedAt: '2026-11-10T00:00:00.000Z', source: 'discord-invite',
  consecutiveFailures: 2, outOfBandStreak: 0, lastError: 'upstream_unavailable',
};

describe('parseInvite: upstream identity and integer bounds', () => {
  it.each([
    ['valid', valid, true],
    ['minimum', { ...valid, approximate_member_count: 1 }, true],
    ['maximum', { ...valid, approximate_member_count: 1_000_000 }, true],
    ['wrong code', { ...valid, code: 'other' }, false],
    ['wrong guild', { ...valid, guild: { id: 'other' } }, false],
    ['missing guild', { ...valid, guild: null }, false],
    ['zero', { ...valid, approximate_member_count: 0 }, false],
    ['overflow', { ...valid, approximate_member_count: 1_000_001 }, false],
    ['fraction', { ...valid, approximate_member_count: 1.5 }, false],
    ['string', { ...valid, approximate_member_count: '888' }, false],
    ['null', null, false],
    ['array', [], false],
  ])('%s', (_name, input, ok) => {
    const result = parseInvite(input, config);
    expect(result.ok).toBe(ok);
    if (!ok) expect(result).toEqual({ ok: false, code: 'invalid_response' });
  });
});

describe('decide: failure handling table (contract 2.4)', () => {
  it.each<FetchErrorCode>(['upstream_unavailable', 'rate_limited', 'invalid_response'])(
    '%s keeps last good, counts failure and breaks jump streak', (code) => {
      expect(decide({ ...last, outOfBandStreak: 2 }, { ok: false, code }, now)).toEqual({
        action: 'keep', record: { ...last, consecutiveFailures: 3, lastError: code },
      });
      expect(decide(null, { ok: false, code }, now)).toEqual({ action: 'keep', record: null });
    },
  );
  it.each([
    [888, 900, 0, 'write'], [888, 444, 0, 'write'], [888, 1776, 0, 'write'],
    [888, 443, 0, 'keep'], [888, 1777, 0, 'keep'], [888, 2000, 1, 'keep'],
    [888, 2000, 2, 'write'], [49, 999, 0, 'write'], [50, 101, 0, 'keep'],
  ] as const)('last=%i candidate=%i streak=%i -> %s', (members, candidate, streak, action) => {
    const previous = { ...last, members, outOfBandStreak: streak };
    const result = decide(previous, { ok: true, members: candidate }, now);
    expect(result.action).toBe(action);
    if (action === 'write') expect(result.record).toEqual({
      members: candidate, updatedAt: now, source: 'discord-invite',
      consecutiveFailures: 0, outOfBandStreak: 0, lastError: null,
    });
    else expect(result.record).toEqual({
      ...previous, consecutiveFailures: 3, outOfBandStreak: streak + 1, lastError: 'out_of_band',
    });
    expect(previous.outOfBandStreak).toBe(streak);
  });
  it('accepts first success and resets streak on an ordinary success', () => {
    for (const previous of [null, { ...last, outOfBandStreak: 2 }]) {
      expect(decide(previous, { ok: true, members: 888 }, now).record).toEqual({
        members: 888, updatedAt: now, source: 'discord-invite',
        consecutiveFailures: 0, outOfBandStreak: 0, lastError: null,
      });
    }
  });
});

describe('checkFreshness: the relay time (contract 2.5, B-WK1)', () => {
  const runAt = Date.parse(now);
  const at = (offsetMs: number) => new Date(runAt + offsetMs).toISOString();
  const hour = 60 * 60 * 1000;
  it.each([
    ['now', now, 'fresh'],
    ['exactly 24 h old', at(-24 * hour), 'fresh'],
    ['exactly 5 min ahead', at(5 * 60 * 1000), 'fresh'],
    ['older than 24 h', at(-24 * hour - 1), 'stale'],
    ['more than 5 min ahead', at(5 * 60 * 1000 + 1), 'stale'],
    ['missing', undefined, 'malformed'],
    ['a number', runAt, 'malformed'],
    ['without milliseconds', '2026-11-10T12:00:00Z', 'malformed'],
    ['with an offset', '2026-11-10T12:00:00.000+00:00', 'malformed'],
    ['a lowercase z', '2026-11-10T12:00:00.000z', 'malformed'],
    ['a date that does not exist', '2026-02-31T00:00:00.000Z', 'malformed'],
    ['hour 24', '2026-11-10T24:00:00.000Z', 'malformed'],
    ['text around it', ` ${now}`, 'malformed'],
  ] as const)('%s is %s', (_name, fetchedAt, expected) => {
    expect(checkFreshness({ fetchedAt }, runAt)).toBe(expected);
  });
  it.each([null, [], 'text'])('a body that is not an object (%j) is malformed', (body) => {
    expect(checkFreshness(body, runAt)).toBe('malformed');
  });
});

describe('runStatus: closed values only (contract 2.2, B-WK1)', () => {
  const ok: Candidate = { ok: true, members: 900 };
  const down: Candidate = { ok: false, code: 'upstream_unavailable' };
  it.each([
    ['a stored success', ok, 'write', 200, false, { outcome: 'written', lastError: null, httpStatus: 200 }],
    ['a failure', down, 'keep', 404, false, { outcome: 'kept', lastError: 'upstream_unavailable', httpStatus: 404 }],
    ['a jump kept out of band', ok, 'keep', 200, false, { outcome: 'kept', lastError: 'out_of_band', httpStatus: 200 }],
    ['no HTTP response', down, 'keep', null, false, { outcome: 'kept', lastError: 'upstream_unavailable', httpStatus: null }],
    ['a success whose record write threw', ok, 'write', 200, true, { outcome: 'kept', lastError: 'store_failed', httpStatus: 200 }],
    ['a failure whose record write threw', down, 'keep', 503, true, { outcome: 'kept', lastError: 'store_failed', httpStatus: 503 }],
    ['a status below 100', down, 'keep', 99, false, { outcome: 'kept', lastError: 'upstream_unavailable', httpStatus: null }],
    ['a status above 599', down, 'keep', 600, false, { outcome: 'kept', lastError: 'upstream_unavailable', httpStatus: null }],
  ] as const)('%s', (_name, candidate, action, httpStatus, storeFailed, expected) => {
    expect(runStatus(now, candidate, action, httpStatus, storeFailed)).toEqual({ at: now, ...expected });
  });
});

describe('parseRecord: an older record still parses', () => {
  it('accepts invite_not_found as a stored lastError, which is no longer produced', () => {
    expect(parseRecord({ ...last, lastError: 'invite_not_found' })).toEqual({ ...last, lastError: 'invite_not_found' });
  });
});
