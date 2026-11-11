import { describe, expect, it } from 'vitest';
import { decide, parseInvite, type ErrorCode, type MemberRecord } from '../src/rules.ts';

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
  it.each<Exclude<ErrorCode, 'out_of_band'>>(['upstream_unavailable', 'rate_limited', 'invite_not_found', 'invalid_response'])(
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
