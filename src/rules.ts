export type Source = 'discord-invite' | 'empirebot' | 'built-in';
export type ErrorCode = 'upstream_unavailable' | 'rate_limited' | 'invite_not_found' | 'invalid_response' | 'out_of_band';
export interface MemberRecord {
  members: number;
  updatedAt: string;
  source: Source;
  consecutiveFailures: number;
  outOfBandStreak: number;
  lastError: ErrorCode | null;
}
export type Candidate = { ok: true; members: number } | { ok: false; code: Exclude<ErrorCode, 'out_of_band'> };
export interface InviteConfig { inviteCode: string; guildId: string }

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function validMembers(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1_000_000;
}
export function parseInvite(json: unknown, config: InviteConfig): Candidate {
  if (!object(json) || json.code !== config.inviteCode || !object(json.guild)
      || json.guild.id !== config.guildId || !validMembers(json.approximate_member_count)) {
    return { ok: false, code: 'invalid_response' };
  }
  return { ok: true, members: json.approximate_member_count };
}
export function decide(last: MemberRecord | null, candidate: Candidate, now: string): {
  action: 'write' | 'keep'; record: MemberRecord | null;
} {
  if (!candidate.ok) return {
    action: 'keep', record: last === null ? null : {
      ...last, consecutiveFailures: last.consecutiveFailures + 1,
      outOfBandStreak: 0, lastError: candidate.code,
    },
  };
  const jump = last !== null && last.members >= 50
    && (candidate.members < last.members * 0.5 || candidate.members > last.members * 2);
  if (jump && last.outOfBandStreak < 2) return {
    action: 'keep', record: {
      ...last, consecutiveFailures: last.consecutiveFailures + 1,
      outOfBandStreak: last.outOfBandStreak + 1, lastError: 'out_of_band',
    },
  };
  return { action: 'write', record: {
    members: candidate.members, updatedAt: now, source: 'discord-invite',
    consecutiveFailures: 0, outOfBandStreak: 0, lastError: null,
  } };
}

const errors: readonly unknown[] = [null, 'upstream_unavailable', 'rate_limited', 'invite_not_found', 'invalid_response', 'out_of_band'];
export function parseRecord(value: unknown): MemberRecord | null {
  if (!object(value) || !validMembers(value.members) || typeof value.updatedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt)
      || !Number.isFinite(Date.parse(value.updatedAt))
      || new Date(value.updatedAt).toISOString() !== value.updatedAt
      || typeof value.source !== 'string' || !['discord-invite', 'empirebot', 'built-in'].includes(value.source)
      || !Number.isSafeInteger(value.consecutiveFailures) || (value.consecutiveFailures as number) < 0
      || !Number.isInteger(value.outOfBandStreak) || (value.outOfBandStreak as number) < 0
      || (value.outOfBandStreak as number) > 2 || !errors.includes(value.lastError)) return null;
  return {
    members: value.members, updatedAt: value.updatedAt, source: value.source as Source,
    consecutiveFailures: value.consecutiveFailures as number,
    outOfBandStreak: value.outOfBandStreak as number, lastError: value.lastError as ErrorCode | null,
  };
}
