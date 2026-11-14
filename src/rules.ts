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
// invite_not_found stays a valid stored value so an older record parses, but is no longer produced (B-WK1, 2.4).
export type FetchErrorCode = Exclude<ErrorCode, 'out_of_band' | 'invite_not_found'>;
export type Candidate = { ok: true; members: number } | { ok: false; code: FetchErrorCode };
export interface InviteConfig { inviteCode: string; guildId: string }

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function validMembers(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1_000_000;
}
/** The exact form `YYYY-MM-DDTHH:mm:ss.sssZ` naming a real instant (it survives a round trip). */
export function isoInstant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function parseInvite(json: unknown, config: InviteConfig): Candidate {
  if (!object(json) || json.code !== config.inviteCode || !object(json.guild)
      || json.guild.id !== config.guildId || !validMembers(json.approximate_member_count)) {
    return { ok: false, code: 'invalid_response' };
  }
  return { ok: true, members: json.approximate_member_count };
}
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_AHEAD_MS = 5 * 60 * 1000;
/** Freshness of the relay's `fetchedAt` against the injected run time (contract 2.5, B-WK1). */
export function checkFreshness(json: unknown, now: number): 'fresh' | 'stale' | 'malformed' {
  if (!object(json) || !isoInstant(json.fetchedAt)) return 'malformed';
  const age = now - Date.parse(json.fetchedAt);
  return age > MAX_AGE_MS || -age > MAX_AHEAD_MS ? 'stale' : 'fresh';
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
  if (!object(value) || !validMembers(value.members)
      || !isoInstant(value.updatedAt)
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

export type StatusError = ErrorCode | 'store_failed';
export interface RunStatus { at: string; outcome: 'written' | 'kept'; lastError: StatusError | null; httpStatus: number | null }
/**
 * The run status key (contract 2.2, B-WK1), built from closed values only and after the record write was attempted:
 * `written` only when a new value was accepted and stored; `store_failed` when the record write threw.
 */
export function runStatus(
  at: string, candidate: Candidate, action: 'write' | 'keep', httpStatus: number | null, storeFailed: boolean,
): RunStatus {
  const runError: ErrorCode | null = action === 'write' ? null : candidate.ok ? 'out_of_band' : candidate.code;
  const status = httpStatus !== null && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
  return {
    at,
    outcome: action === 'write' && !storeFailed ? 'written' : 'kept',
    lastError: storeFailed ? 'store_failed' : runError,
    httpStatus: status,
  };
}
