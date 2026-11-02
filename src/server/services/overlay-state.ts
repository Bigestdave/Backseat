import type { OverlayPhase, OverlaySnapshot, PublicParticipant } from "../../shared/contracts";
import type { RoundPhase } from "../domain/rounds";

type OverlayChallenge = {
  position: 1 | 2 | 3 | 4;
  title: string;
  durationSeconds: number;
};

type OverlayAssignment = {
  targetDisplayName: string;
  title: string | null;
  instruction: string | null;
  endsAt: Date | null;
  clearedAt: Date | null;
};

type OverlayParticipant = {
  displayName: string;
  role: "host" | "guest";
  overlayConfirmedAt: Date | null;
  chatConnectedAt: Date | null;
};

type OverlayRound = {
  phase: RoundPhase;
  votingDeadlineAt: Date;
  countdownStartsAt: Date | null;
  assignments: OverlayAssignment[];
};

export type OverlayStateInput = {
  mode: "real" | "simulated";
  participants: OverlayParticipant[];
  challengeSet: {
    options: OverlayChallenge[];
    approvedByUserIds: string[];
  } | null;
  round: OverlayRound | null;
  now: Date;
};

function phaseFor(input: OverlayStateInput): OverlayPhase {
  const rivalJoined = input.participants.some((participant) => participant.role === "guest");
  if (!rivalJoined) return "waiting-for-rival";
  if (input.round) return input.round.phase;
  const approved = input.challengeSet?.approvedByUserIds.length === 2;
  const overlaysConfirmed = input.participants.length === 2
    && input.participants.every((participant) => participant.overlayConfirmedAt);
  const chatsConnected = input.participants.length === 2
    && input.participants.every((participant) => participant.chatConnectedAt);
  return input.challengeSet && approved && overlaysConfirmed && chatsConnected ? "ready-for-voting" : "setup";
}

// This function is intentionally a privacy boundary. Its input may contain
// controller-only metadata, but the returned contract can only contain public
// creator names, approved options, and the visible restriction state.
export function createPublicOverlaySnapshot(input: OverlayStateInput): OverlaySnapshot {
  const phase = phaseFor(input);
  const round = input.round;

  return {
    kind: "overlay",
    mode: input.mode,
    serverTime: input.now.toISOString(),
    phase,
    participants: input.participants.map(({ displayName, role, chatConnectedAt }) => ({
      displayName,
      role,
      chatConnected: Boolean(chatConnectedAt)
    })),
    challenges: (input.challengeSet?.options ?? []).map((option) => ({ ...option })),
    votingDeadlineAt: round?.phase === "voting" ? round.votingDeadlineAt.toISOString() : null,
    countdownStartsAt: round?.phase === "countdown" && round.countdownStartsAt
      ? round.countdownStartsAt.toISOString()
      : null,
    restrictions: (round?.assignments ?? [])
      .filter((assignment): assignment is OverlayAssignment & { title: string; instruction: string } => Boolean(assignment.title && assignment.instruction))
      .map((assignment) => ({
        targetDisplayName: assignment.targetDisplayName,
        title: assignment.title,
        instruction: assignment.instruction,
        endsAt: assignment.endsAt?.toISOString() ?? null,
        clearedAt: assignment.clearedAt?.toISOString() ?? null
      }))
  };
}
