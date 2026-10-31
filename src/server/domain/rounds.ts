export const ROUND_PHASES = [
  "voting",
  "revealed",
  "countdown",
  "active",
  "complete",
  "no-votes",
  "stopped",
  "invalidated"
] as const;

export type RoundPhase = (typeof ROUND_PHASES)[number];
export type CreatorRole = "host" | "guest";
export type VoteOption = 1 | 2 | 3;

export type ChallengeDraft = {
  position: VoteOption;
  title: string;
  instruction: string;
  durationSeconds: number;
};

export type RoundReadiness = Partial<Record<CreatorRole, Date>>;

export type VoteTally = Record<VoteOption, number>;

export type VoteResolution =
  | { kind: "no-votes" }
  | { kind: "selected"; option: VoteOption; tiedOptions: VoteOption[] };

export class DomainRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainRuleError";
  }
}

export const DEFAULT_CHALLENGES: readonly ChallengeDraft[] = [
  {
    position: 1,
    title: "No boosting",
    instruction: "Do not use boost.",
    durationSeconds: 20
  },
  {
    position: 2,
    title: "No jumping",
    instruction: "Keep all wheels on the ground.",
    durationSeconds: 20
  },
  {
    position: 3,
    title: "Reverse only",
    instruction: "Move only in reverse.",
    durationSeconds: 10
  }
] as const;

const TRANSITIONS: Readonly<Record<RoundPhase, readonly RoundPhase[]>> = {
  voting: ["revealed", "no-votes", "stopped", "invalidated"],
  revealed: ["countdown", "stopped", "invalidated"],
  countdown: ["active", "stopped", "invalidated"],
  active: ["complete", "stopped", "invalidated"],
  complete: [],
  "no-votes": [],
  stopped: [],
  invalidated: []
};

function copyReadiness(readiness: RoundReadiness): RoundReadiness {
  return { ...readiness };
}

export function validateChallengeDrafts(options: readonly ChallengeDraft[]): void {
  if (options.length !== 3) {
    throw new DomainRuleError("A challenge set must contain exactly three options.");
  }

  const seen = new Set<number>();
  for (const option of options) {
    if (!Number.isInteger(option.position) || option.position < 1 || option.position > 3 || seen.has(option.position)) {
      throw new DomainRuleError("Challenge options must use positions 1, 2, and 3 exactly once.");
    }
    seen.add(option.position);
    if (!option.title.trim() || !option.instruction.trim()) {
      throw new DomainRuleError("Every challenge needs a title and an exact instruction.");
    }
    if (!Number.isInteger(option.durationSeconds) || option.durationSeconds < 1 || option.durationSeconds > 300) {
      throw new DomainRuleError("Challenge durations must be whole seconds between 1 and 300.");
    }
  }
}

export function canTransitionRound(from: RoundPhase, to: RoundPhase): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertRoundTransition(from: RoundPhase, to: RoundPhase): void {
  if (!canTransitionRound(from, to)) {
    throw new DomainRuleError(`Cannot transition a round from ${from} to ${to}.`);
  }
}

export function approveChallengeSet(
  approvals: ReadonlySet<CreatorRole>,
  approver: CreatorRole
): Set<CreatorRole> {
  return new Set([...approvals, approver]);
}

export function challengeSetIsApproved(approvals: ReadonlySet<CreatorRole>): boolean {
  return approvals.has("host") && approvals.has("guest");
}

export function setCreatorReady(
  readiness: RoundReadiness,
  role: CreatorRole,
  now: Date,
  countdownSeconds = 3
): { readiness: RoundReadiness; countdownStartsAt: Date | null } {
  if (!Number.isInteger(countdownSeconds) || countdownSeconds < 1 || countdownSeconds > 10) {
    throw new DomainRuleError("Countdown length must be a whole number of seconds between 1 and 10.");
  }

  const next = copyReadiness(readiness);
  next[role] = now;
  const bothReady = next.host && next.guest;
  return {
    readiness: next,
    countdownStartsAt: bothReady ? new Date(now.getTime() + countdownSeconds * 1_000) : null
  };
}

export function clearCreatorReady(readiness: RoundReadiness, role: CreatorRole): RoundReadiness {
  const next = copyReadiness(readiness);
  delete next[role];
  return next;
}

export function resolveVoteTally(
  tally: VoteTally,
  chooseTiedIndex: (exclusiveMaximum: number) => number
): VoteResolution {
  const highest = Math.max(tally[1], tally[2], tally[3]);
  if (highest === 0) return { kind: "no-votes" };

  const tiedOptions = ([1, 2, 3] as const).filter((option) => tally[option] === highest);
  const index = tiedOptions.length === 1 ? 0 : chooseTiedIndex(tiedOptions.length);
  if (!Number.isInteger(index) || index < 0 || index >= tiedOptions.length) {
    throw new DomainRuleError("Tie resolver returned an invalid option index.");
  }
  return { kind: "selected", option: tiedOptions[index], tiedOptions };
}

export function votingDeadline(now: Date, durationSeconds: number): Date {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 120) {
    throw new DomainRuleError("Voting must last a whole number of seconds between 5 and 120.");
  }
  return new Date(now.getTime() + durationSeconds * 1_000);
}

export function voteIsTimely(receivedAt: Date, deadline: Date): boolean {
  return receivedAt.getTime() < deadline.getTime();
}
