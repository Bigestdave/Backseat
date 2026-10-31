export type BattleRole = "host" | "guest";

export type PublicParticipant = {
  displayName: string;
  role: BattleRole;
  chatConnected: boolean;
};

export type PublicChallenge = {
  position: 1 | 2 | 3;
  title: string;
  durationSeconds: number;
};

export type PublicRestriction = {
  targetDisplayName: string;
  title: string;
  instruction: string;
  endsAt: string | null;
  clearedAt: string | null;
};

// Deliberately contains no Twitch viewer, vote, or creator account identifiers.
// An overlay credential is allowed to broadcast the current state of the battle,
// not the private activity that led to that state.
export type OverlayPhase =
  | "waiting-for-rival"
  | "setup"
  | "ready-for-voting"
  | "voting"
  | "revealed"
  | "countdown"
  | "active"
  | "complete"
  | "no-votes"
  | "stopped"
  | "invalidated";

export type OverlaySnapshot = {
  kind: "overlay";
  mode: "real" | "simulated";
  serverTime: string;
  phase: OverlayPhase;
  participants: PublicParticipant[];
  challenges: PublicChallenge[];
  votingDeadlineAt: string | null;
  countdownStartsAt: string | null;
  restrictions: PublicRestriction[];
};

