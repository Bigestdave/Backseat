import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OverlaySnapshot } from "../shared/contracts";

type SessionUser = {
  id: string;
  twitchId: string;
  login: string;
  displayName: string;
  isDemo: boolean;
};

type Participant = {
  userId: string;
  displayName: string;
  role: "host" | "guest";
  overlayConfirmedAt: string | null;
  chatConnectedAt: string | null;
};

type PickPosition = 1 | 2 | 3 | 4;

type ChallengeDraft = {
  position: PickPosition;
  title: string;
  instruction: string;
  durationSeconds: number;
  sourceOptionId?: string;
};

type ChallengeSet = {
  id: string;
  version: number;
  votingDurationSeconds: number;
  options: Array<ChallengeDraft & { id: string; addedByUserId: string; addedByDisplayName: string }>;
  approvedByUserIds: string[];
};

type RoundAssignment = {
  targetUserId: string;
  targetDisplayName: string;
  title: string | null;
  instruction: string | null;
  durationSeconds: number | null;
  resolution: "winner" | "tie-break" | "no-votes";
  startsAt: string | null;
  endsAt: string | null;
  clearedAt: string | null;
};

type Round = {
  id: string;
  phase: "voting" | "revealed" | "countdown" | "active" | "complete" | "no-votes" | "stopped" | "invalidated";
  stateVersion: number;
  votingDeadlineAt: string;
  countdownStartsAt: string | null;
  activeAt: string | null;
  completedAt: string | null;
  terminalReason: string | null;
  stoppedByDisplayName: string | null;
  outcome: "host" | "guest" | "draw" | "stopped" | "none" | null;
  readyUserIds: string[];
  assignments: RoundAssignment[];
};

type LastAcceptedVote = {
  option: "1" | "2" | "3" | "4";
  sourceDisplayName: string;
  targetDisplayName: string;
  receivedAt: string;
};

type Battle = {
  id: string;
  mode: "real" | "simulated";
  status: "setup" | "integration-proof" | "ended";
  role: "host" | "guest";
  stateVersion: number;
  participants: Participant[];
  challengeSet: ChallengeSet | null;
  round: Round | null;
  history: Array<Round & { sequence: number }>;
  score: { host: number; guest: number };
  lastAcceptedVote: LastAcceptedVote | null;
};

type SessionResponse = { user: SessionUser | null };
type CurrentBattleResponse = { battle: Battle | null };
type CreateBattleResponse = { inviteUrl: string };
type OverlayCredentialResponse = { overlayUrl: string };
type OverlayConnection = "connecting" | "live" | "lost" | "error";

const PENDING_INVITE_KEY = "backseat.pendingInvite";

const DEFAULT_CHALLENGES: ChallengeDraft[] = [
  { position: 1, title: "No boosting", instruction: "Do not use boost.", durationSeconds: 20 },
  { position: 2, title: "No jumping", instruction: "Keep all wheels on the ground.", durationSeconds: 20 },
  { position: 3, title: "Reverse only", instruction: "Move only in reverse.", durationSeconds: 10 }
];

const DURATION_OPTIONS = [10, 20, 30, 60] as const;

function draftOptions(challengeSet: ChallengeSet | null): ChallengeDraft[] {
  if (!challengeSet) return DEFAULT_CHALLENGES.map((option) => ({ ...option }));
  return challengeSet.options.map((option) => ({
    position: option.position,
    title: option.title,
    instruction: option.instruction,
    durationSeconds: option.durationSeconds,
    sourceOptionId: option.id
  }));
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(body?.error ?? "Backseat could not complete that request.", response.status);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function queryInvite(): string | null {
  const invite = new URLSearchParams(window.location.search).get("invite");
  if (invite) {
    try {
      window.sessionStorage.setItem(PENDING_INVITE_KEY, invite);
    } catch {
      // The visible query remains available if the browser blocks session storage.
    }
    return invite;
  }

  try {
    return window.sessionStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    return null;
  }
}

function clearInviteFromPage(): void {
  try {
    window.sessionStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    // Nothing sensitive has been persisted by this app if storage is unavailable.
  }
  const url = new URL(window.location.href);
  url.searchParams.delete("invite");
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
}

function cleanOAuthQuery(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("connected") && !url.searchParams.has("oauth")) return;
  url.searchParams.delete("connected");
  url.searchParams.delete("oauth");
  url.searchParams.delete("reason");
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
}

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "at an unknown time"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  return Promise.reject(new Error("Clipboard access is unavailable in this browser."));
}

function Logo({ compact = false }: { compact?: boolean }): ReactNode {
  return (
    <span className={`brand ${compact ? "brand--compact" : ""}`}>
      <img src="/assets/wordmark-brand.png" alt="Backseat" />
      <img className="brand__bolt" src="/assets/lightning.png" alt="" aria-hidden="true" />
    </span>
  );
}

function CreatorMark({ name, role }: { name: string; role: "host" | "guest" }): ReactNode {
  const initial = name.trim().slice(0, 1).toUpperCase() || "?";
  const normalized = name.toLowerCase();
  const avatar = normalized.includes("fredlock")
    ? "/assets/fredlocks-avatar.png"
    : normalized.includes("rampage")
      ? "/assets/rampagegod-avatar.png"
      : null;
  return (
    <span className={`creator-mark creator-mark--${role}`} aria-hidden="true">
      {avatar ? <img src={avatar} alt="" /> : <span>{initial}</span>}
    </span>
  );
}

function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warning" | "error" }): ReactNode {
  return <p className={`notice notice--${tone}`} role={tone === "error" ? "alert" : undefined}>{children}</p>;
}

function CopyControl({ value, label }: { value: string; label: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  async function copy(): Promise<void> {
    setCopyError(null);
    try {
      await copyText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopyError("Clipboard access is unavailable. Select and copy the link manually.");
    }
  }

  return (
    <div className="copy-control">
      <label className="sr-only" htmlFor={`${label}-value`}>{label}</label>
      <input id={`${label}-value`} readOnly value={value} onFocus={(event) => event.currentTarget.select()} />
      <button className="button button--secondary" type="button" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy link"}
      </button>
      {copyError && <Notice tone="warning">{copyError}</Notice>}
    </div>
  );
}

function PageShell({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="app-shell">
      <header className="site-header">
        <Logo />
        <span className="site-header__label">Two streamers. Two chats.</span>
      </header>
      {children}
    </div>
  );
}

function CreatorLanding({ invite, oauthMessage, startingDemo, onStartDemo }: {
  invite: string | null;
  oauthMessage: string | null;
  startingDemo: boolean;
  onStartDemo: () => Promise<void>;
}): ReactNode {
  function beginOAuth(): void {
    if (invite) {
      try {
        window.sessionStorage.setItem(PENDING_INVITE_KEY, invite);
      } catch {
        // The user can still return through the invite URL after authenticating.
      }
    }
    window.location.assign("/auth/twitch");
  }

  return (
    <PageShell>
      <main className="landing-stage">
        <section className="paired-portraits" aria-label="Backseat is for two Twitch streamers">
          <div className="portrait-plate portrait-plate--host"><img src="/assets/fredlocks-cutout.png" alt="" /></div>
          <img className="stage-bolt" src="/assets/lightning.png" alt="" aria-hidden="true" />
          <div className="portrait-plate portrait-plate--guest"><img src="/assets/rampagegod-cutout.png" alt="" /></div>
        </section>
        <section className="lower-sheet lower-sheet--landing">
          <p className="eyebrow">Twitch head-to-head</p>
          <h1>Let chat backseat your rival.</h1>
          <p className="lede">Two streamers approve the challenges. Each chat picks which one the rival has to face.</p>
          {invite && <Notice>A battle invitation is waiting. Sign in, then explicitly choose whether to join.</Notice>}
          {oauthMessage && <Notice tone="error">{oauthMessage}</Notice>}
          <div className="landing-actions">
            <button className="button button--primary button--twitch" type="button" onClick={beginOAuth}>
              <span aria-hidden="true">▰</span> Connect Twitch
            </button>
            <button className="button button--text" type="button" disabled={startingDemo} onClick={() => void onStartDemo()}>
              {startingDemo ? "Starting simulated demo…" : "Try a simulated demo"}
            </button>
          </div>
          <p className="quiet-copy">This starts the server-side authorization flow. It is not a simulated login.</p>
          <p className="scope-copy">The demo is an isolated test loop. It does not prove Twitch, chat, or OBS integration.</p>
        </section>
      </main>
    </PageShell>
  );
}

function InviteDecision({ invite, battle, accepting, onAccept }: {
  invite: string;
  battle: Battle | null;
  accepting: boolean;
  onAccept: () => Promise<void>;
}): ReactNode {
  if (battle) {
    return (
      <section className="invite-decision" aria-labelledby="invite-title">
        <p className="eyebrow">Invitation pending</p>
        <h1 id="invite-title">You already have an open session.</h1>
        <p>Backseat keeps one open battle per streamer. Finish or leave the current battle before accepting another invitation.</p>
      </section>
    );
  }

  return (
    <section className="invite-decision" aria-labelledby="invite-title">
      <p className="eyebrow">You have been invited</p>
      <h1 id="invite-title">Join a Backseat session.</h1>
      <p>You will occupy the guest seat. Joining lets you review the shared challenges; it does not open picks or start a round.</p>
      <button className="button button--primary" type="button" disabled={accepting} onClick={() => void onAccept()}>
        {accepting ? "Joining…" : "Join session"}
      </button>
    </section>
  );
}

function BattleIdentity({ battle, user }: { battle: Battle; user: SessionUser }): ReactNode {
  const host = battle.participants.find((participant) => participant.role === "host");
  const guest = battle.participants.find((participant) => participant.role === "guest");

  return (
    <section className="battle-identity" aria-label="Battle streamers">
      <div className="battle-identity__creator">
        <CreatorMark name={host?.displayName ?? "?"} role="host" />
        <div><strong>@{host?.displayName ?? "Waiting for host"}</strong><span>{host?.userId === user.id ? "You" : "Streamer"} · {host?.chatConnectedAt ? (battle.mode === "simulated" ? "Simulated chat" : "Chat connected") : "Chat reconnecting"}</span></div>
      </div>
      <img className="battle-identity__bolt" src="/assets/lightning.png" alt="" aria-hidden="true" />
      <div className="battle-identity__creator battle-identity__creator--right">
        <div><strong>@{guest?.displayName ?? "Waiting for rival"}</strong><span>{guest ? `${guest.userId === user.id ? "You" : "Rival"} · ${guest.chatConnectedAt ? (battle.mode === "simulated" ? "Simulated chat" : "Chat connected") : "Chat reconnecting"}` : "Invite your rival"}</span></div>
        <CreatorMark name={guest?.displayName ?? "?"} role="guest" />
      </div>
    </section>
  );
}

type BattleFlowProps = {
  battle: Battle;
  user: SessionUser;
  overlayUrl: string | null;
  inviteUrl: string | null;
  busy: boolean;
  invitationBusy: boolean;
  onCreateInvitation: () => Promise<void>;
  onCreateOverlay: () => Promise<void>;
  onConfirmOverlay: () => Promise<boolean>;
  onProposeChallenges: (options: ChallengeDraft[], votingDurationSeconds: number) => Promise<boolean>;
  onApproveChallenges: () => Promise<boolean>;
  onOpenVoting: () => Promise<boolean>;
  onReady: (roundId: string) => Promise<boolean>;
  onUnready: (roundId: string) => Promise<boolean>;
  onCancelStart: (roundId: string) => Promise<boolean>;
  onLockInPicks: (roundId: string) => Promise<boolean>;
  onStopRound: (roundId: string) => Promise<boolean>;
  onRecordOutcome: (roundId: string, outcome: "host" | "guest" | "draw") => Promise<boolean>;
  onEndBattle: () => Promise<boolean>;
  onSimulateVote: (sourceRole: "host" | "guest", option: PickPosition) => Promise<boolean>;
  onSimulateRivalReady: (roundId: string) => Promise<boolean>;
  onSignOut: () => Promise<void>;
};

function BattleControls({
  battle,
  user,
  overlayUrl,
  busy,
  onCreateOverlay,
  onConfirmOverlay,
  onProposeChallenges,
  onApproveChallenges,
  onOpenVoting,
  onReady,
  onUnready,
  onCancelStart,
  onLockInPicks,
  onStopRound,
  onRecordOutcome,
  onEndBattle,
  onSimulateVote,
  onSimulateRivalReady
}: Omit<BattleFlowProps, "inviteUrl" | "invitationBusy" | "onCreateInvitation" | "onSignOut">): ReactNode {
  const [editorOpen, setEditorOpen] = useState(!battle.challengeSet);
  const [options, setOptions] = useState<ChallengeDraft[]>(() => draftOptions(battle.challengeSet));
  const [votingDurationSeconds, setVotingDurationSeconds] = useState(String(battle.challengeSet?.votingDurationSeconds ?? 18));
  const [stopArmed, setStopArmed] = useState(false);
  const [endArmed, setEndArmed] = useState(false);
  const hasRival = battle.participants.some((participant) => participant.role === "guest");
  const ownOverlayConfirmed = battle.participants.some((participant) => participant.userId === user.id && participant.overlayConfirmedAt);
  const bothOverlaysConfirmed = battle.participants.length === 2 && battle.participants.every((participant) => participant.overlayConfirmedAt);
  const bothChatsConnected = battle.participants.length === 2 && battle.participants.every((participant) => participant.chatConnectedAt);
  const challengeSet = battle.challengeSet;
  const ownApproval = Boolean(challengeSet?.approvedByUserIds.includes(user.id));
  const bothApproved = challengeSet?.approvedByUserIds.length === 2;
  const round = battle.round;
  const liveRound = Boolean(round && ["voting", "revealed", "countdown", "active"].includes(round.phase));
  const canEdit = !liveRound;

  useEffect(() => {
    if (!editorOpen) return;
    setOptions(draftOptions(battle.challengeSet));
    setVotingDurationSeconds(String(battle.challengeSet?.votingDurationSeconds ?? 18));
  }, [battle.challengeSet?.id, editorOpen]);

  function updateOption(position: PickPosition, field: "title" | "instruction" | "durationSeconds", value: string): void {
    setOptions((current) => current.map((option) => option.position === position
      ? { ...option, [field]: field === "durationSeconds" ? Number(value) : value }
      : option
    ));
  }

  function addOption(): void {
    setOptions((current) => current.length >= 4
      ? current
      : [...current, { position: (current.length + 1) as PickPosition, title: "", instruction: "Follow this challenge.", durationSeconds: 20 }]
    );
  }

  function removeOption(position: PickPosition): void {
    setOptions((current) => current.length <= 2
      ? current
      : current.filter((option) => option.position !== position).map((option, index) => ({ ...option, position: (index + 1) as PickPosition }))
    );
  }

  async function submitChallenges(): Promise<void> {
    if (await onProposeChallenges(options, Number(votingDurationSeconds))) setEditorOpen(false);
  }

  function requestStop(roundId: string): void {
    if (stopArmed) {
      setStopArmed(false);
      void onStopRound(roundId);
      return;
    }
    setStopArmed(true);
    window.setTimeout(() => setStopArmed(false), 2_500);
  }

  function requestEndBattle(): void {
    if (endArmed) {
      setEndArmed(false);
      void onEndBattle();
      return;
    }
    setEndArmed(true);
    window.setTimeout(() => setEndArmed(false), 2_500);
  }

  return (
    <>
      <section className="integration-proof" aria-labelledby="battle-title">
        <div>
          <p className="eyebrow">Head-to-head</p>
          <h2 id="battle-title">Agree on challenges. Let chat choose the rival’s.</h2>
          <p className="lede">You build the challenge list together. Each chat picks for the other streamer.</p>
        </div>
        <span className={`mode-label ${battle.mode === "simulated" ? "mode-label--simulated" : ""}`}>
          {battle.mode === "simulated" ? "Simulated mode" : "Real Twitch mode"}
        </span>
      </section>

      <section className="proof-list" aria-label="Battle setup status">
        <div className="proof-row"><strong>Rival seat</strong><span>{hasRival ? "Ready — both streamers are here" : "Waiting for the invitation to be accepted"}</span></div>
        <div className="proof-row"><strong>Challenge set</strong><span>{challengeSet ? `Version ${challengeSet.version}${bothApproved ? " approved by both streamers" : " awaiting approval"}` : "Build the shared list after your rival joins"}</span></div>
        <div className="proof-row"><strong>OBS confirmation</strong><span>{bothOverlaysConfirmed ? "Both streamers confirmed their own browser source" : "Each streamer confirms their own browser source"}</span></div>
        <div className="proof-row"><strong>Twitch chat feeds</strong><span>{bothChatsConnected ? (battle.mode === "simulated" ? "Both simulated chats are ready" : "Both live chat subscriptions are connected") : "Waiting for both live chat subscriptions"}</span></div>
        <div className="proof-row"><strong>Latest accepted pick</strong><span>{battle.lastAcceptedVote ? `@${battle.lastAcceptedVote.sourceDisplayName}'s chat → @${battle.lastAcceptedVote.targetDisplayName} · !pick ${battle.lastAcceptedVote.option} · ${formatWhen(battle.lastAcceptedVote.receivedAt)}` : "No accepted pick yet."}</span></div>
      </section>

      <section className="challenge-agreement" aria-labelledby="challenge-title">
        <div className="section-heading">
          <div><p className="eyebrow">Challenge agreement</p><h2 id="challenge-title">Build the shared list together.</h2></div>
          {canEdit && <button className="button button--secondary" type="button" onClick={() => setEditorOpen((open) => !open)}>{editorOpen ? "Close editor" : challengeSet ? "Edit challenges" : "Set challenges"}</button>}
        </div>

        {editorOpen && canEdit ? (
          <div className="challenge-editor">
            {options.map((option) => (
              <fieldset key={option.position}>
                <legend>!pick {option.position}</legend>
                <label>Challenge<input value={option.title} maxLength={80} onChange={(event) => updateOption(option.position, "title", event.target.value)} /></label>
                <label>Exact instruction<input value={option.instruction} maxLength={180} onChange={(event) => updateOption(option.position, "instruction", event.target.value)} /></label>
                <label>Seconds<select value={option.durationSeconds} onChange={(event) => updateOption(option.position, "durationSeconds", event.target.value)}>{DURATION_OPTIONS.map((duration) => <option key={duration} value={duration}>{duration} seconds</option>)}</select></label>
                {options.length > 2 && <button className="button button--text" type="button" onClick={() => removeOption(option.position)}>Remove</button>}
              </fieldset>
            ))}
            <div className="challenge-editor__actions">
              {options.length < 4 && <button className="button button--secondary" type="button" onClick={addOption}>Add challenge</button>}
              <label className="duration-field">Chat pick window (seconds)<input type="number" min="5" max="120" value={votingDurationSeconds} onChange={(event) => setVotingDurationSeconds(event.target.value)} /></label>
              <button className="button button--primary" type="button" disabled={busy} onClick={() => void submitChallenges()}>Save changes</button>
            </div>
          </div>
        ) : challengeSet ? (
          <div className="challenge-list">
            {challengeSet.options.map((option) => <div key={option.id}><strong>!pick {option.position} · {option.title}</strong><span>{option.durationSeconds}s · {option.instruction}</span><small>Added by @{option.addedByDisplayName}</small></div>)}
            <p className="quiet-copy">Chat pick window: {challengeSet.votingDurationSeconds} seconds.</p>
          </div>
        ) : <Notice tone="warning">Build the shared list once your rival joins.</Notice>}

        {challengeSet && !ownApproval && !liveRound && <button className="button button--primary" type="button" disabled={busy} onClick={() => void onApproveChallenges()}>Approve version {challengeSet.version}</button>}
        {challengeSet && ownApproval && <p className="quiet-copy">You approved this exact version. Editing creates a new version and resets both approvals.</p>}
      </section>

      <section className="overlay-setup" aria-labelledby="overlay-title">
        <div><p className="eyebrow">{battle.mode === "simulated" ? "Simulated browser source" : "Private browser source"}</p><h2 id="overlay-title">Set up your read-only overlay.</h2><p>{battle.mode === "simulated" ? "This isolated demo includes a simulated browser source so you can exercise the flow. It does not connect to Twitch or prove OBS display." : "Generate your own private link, paste it into OBS, then confirm only after you can see it."}</p></div>
        <button className="button button--primary" type="button" disabled={busy} onClick={() => void onCreateOverlay()}>{overlayUrl ? "Rotate overlay link" : "Create overlay link"}</button>
        {overlayUrl && <><CopyControl value={overlayUrl} label="private-overlay-link" /><p className="quiet-copy">The credential remains after <code>#</code>; it is not sent with the initial browser request.</p></>}
        {!ownOverlayConfirmed && <button className="button button--secondary" type="button" disabled={busy} onClick={() => void onConfirmOverlay()}>I can see it in OBS</button>}
        {ownOverlayConfirmed && <p className="quiet-copy">You confirmed your overlay. Your rival must confirm their own.</p>}
      </section>

      <section className="round-control" aria-labelledby="round-title">
        <div className="section-heading"><div><p className="eyebrow">Round control</p><h2 id="round-title">{round ? round.phase.replace("-", " ") : "Ready for the first pick"}</h2></div>{round && liveRound && <button className={`button ${stopArmed ? "button--primary" : "button--text"}`} type="button" disabled={busy} onClick={() => requestStop(round.id)}>{stopArmed ? "Tap again to stop" : "Stop round"}</button>}</div>
        {!round && <button className="button button--primary" type="button" disabled={busy || !hasRival || !bothApproved || !bothOverlaysConfirmed || !bothChatsConnected} onClick={() => void onOpenVoting()}>Let chat pick</button>}
        {!round && <p className="quiet-copy">Either streamer can open the next pick once setup is complete.</p>}
        {round?.phase === "voting" && <><p className="lede">Chats are choosing. Picks close at {formatWhen(round.votingDeadlineAt)}.</p><button className="button button--secondary" type="button" disabled={busy} onClick={() => void onLockInPicks(round.id)}>Lock in picks</button></>}
        {round?.phase === "voting" && battle.mode === "simulated" && (
          <div className="demo-controls" aria-label="Simulated chat controls">
            <strong>Simulated chat only</strong>
            <span>Each button replaces one simulated viewer’s pick through the same server pick path. It never reaches Twitch.</span>
            {(["host", "guest"] as const).map((sourceRole) => (
              <div key={sourceRole} className="demo-controls__row">
                <b>@{battle.participants.find((participant) => participant.role === sourceRole)?.displayName ?? sourceRole} chat</b>
                {(challengeSet?.options ?? []).map((option) => <button key={option.position} className="button button--secondary" type="button" disabled={busy} onClick={() => void onSimulateVote(sourceRole, option.position)}>!pick {option.position}</button>)}
              </div>
            ))}
          </div>
        )}
        {round && ["revealed", "countdown", "active", "complete", "no-votes", "stopped"].includes(round.phase) && (
          <div className="assignment-list">
            {round.assignments.map((assignment) => <div key={assignment.targetUserId}><strong>@{assignment.targetDisplayName}</strong><span>{assignment.title ? `${assignment.title} · ${assignment.durationSeconds}s` : "No pick — play normally"}{assignment.clearedAt ? " · Cleared" : ""}</span>{assignment.instruction && <small>{assignment.instruction}</small>}</div>)}
          </div>
        )}
        {round?.phase === "revealed" && !round.readyUserIds.includes(user.id) && <button className="button button--primary" type="button" disabled={busy} onClick={() => void onReady(round.id)}>I’m ready</button>}
        {round?.phase === "revealed" && round.readyUserIds.includes(user.id) && <><p className="quiet-copy">You are ready. The shared countdown commits when your rival is ready too.</p><button className="button button--secondary" type="button" disabled={busy} onClick={() => void onUnready(round.id)}>Unready</button></>}
        {round?.phase === "revealed" && battle.mode === "simulated" && !round.readyUserIds.includes(battle.participants.find((participant) => participant.role === "guest")?.userId ?? "") && <button className="button button--secondary" type="button" disabled={busy} onClick={() => void onSimulateRivalReady(round.id)}>Simulate rival ready</button>}
        {round?.phase === "countdown" && <><p className="lede">Challenges start together at {round.countdownStartsAt ? formatWhen(round.countdownStartsAt) : "the server’s scheduled time"}.</p><button className="button button--secondary" type="button" disabled={busy} onClick={() => void onCancelStart(round.id)}>Cancel start</button></>}
        {round?.phase === "invalidated" && <Notice tone="warning">Picks were cancelled because a chat feed dropped before challenges began. Reconnecting does not restart this round.</Notice>}
        {round?.phase === "stopped" && <Notice tone="warning">{round.stoppedByDisplayName ? `@${round.stoppedByDisplayName} stopped this round. Both challenges are cleared.` : "This round was stopped. Both challenges are cleared."}</Notice>}
        {round?.phase === "complete" && !round.outcome && <div className="outcome-panel"><strong>Who won?</strong><span>Backseat does not verify gameplay. This score is self-reported.</span><div><button className="button button--secondary" type="button" disabled={busy} onClick={() => void onRecordOutcome(round.id, "host")}>@{battle.participants.find((participant) => participant.role === "host")?.displayName ?? "Host"}</button><button className="button button--secondary" type="button" disabled={busy} onClick={() => void onRecordOutcome(round.id, "guest")}>@{battle.participants.find((participant) => participant.role === "guest")?.displayName ?? "Guest"}</button><button className="button button--secondary" type="button" disabled={busy} onClick={() => void onRecordOutcome(round.id, "draw")}>Draw</button></div></div>}
        {round && ["complete", "no-votes", "stopped", "invalidated"].includes(round.phase) && <button className="button button--primary" type="button" disabled={busy || !bothApproved || !bothOverlaysConfirmed || !bothChatsConnected} onClick={() => void onOpenVoting()}>Open next pick</button>}
        <button className={`button button--text button--danger ${endArmed ? "button--primary" : ""}`} type="button" disabled={busy} onClick={requestEndBattle}>{endArmed ? "Tap again to end session" : "End session"}</button>
      </section>
      <Scoreboard battle={battle} />
    </>
  );
}

function Scoreboard({ battle }: { battle: Battle }): ReactNode {
  const host = battle.participants.find((participant) => participant.role === "host");
  const guest = battle.participants.find((participant) => participant.role === "guest");
  const outcomeLabel = (round: Round): string => {
    if (round.outcome === "host") return `@${host?.displayName ?? "Host"} won`;
    if (round.outcome === "guest") return `@${guest?.displayName ?? "Guest"} won`;
    if (round.outcome === "draw") return "Draw";
    if (round.outcome === "stopped") return "Stopped";
    return "No result";
  };
  return (
    <section className="scoreboard" aria-labelledby="scoreboard-title">
      <div className="section-heading"><div><p className="eyebrow">Round history</p><h2 id="scoreboard-title">The score is what you call it.</h2></div><strong>{battle.score.host} – {battle.score.guest}</strong></div>
      <p className="quiet-copy">@{host?.displayName ?? "Host"} · @{guest?.displayName ?? "Guest"}. Backseat records the result you select; it does not judge gameplay.</p>
      {battle.history.length > 0 ? <ol className="round-history">{battle.history.slice(0, 6).map((entry) => <li key={entry.id}><span>Round {entry.sequence}</span><strong>{outcomeLabel(entry)}</strong><small>{entry.assignments.map((assignment) => assignment.title ?? "No pick").join(" · ")}</small></li>)}</ol> : <p className="quiet-copy">Finished rounds will appear here.</p>}
    </section>
  );
}

type FlowStage = "invite" | "agree" | "overlay" | "pick" | "play" | "result" | "scoreboard";

function participantFor(battle: Battle, role: "host" | "guest"): Participant | undefined {
  return battle.participants.find((participant) => participant.role === role);
}

function creatorCutout(name: string | undefined): string | null {
  const normalized = name?.toLowerCase() ?? "";
  if (normalized.includes("fredlock")) return "/assets/fredlocks-cutout.png";
  if (normalized.includes("rampage")) return "/assets/rampagegod-cutout.png";
  return null;
}

function FlowCreatorCard({ participant, role, currentUserId }: { participant?: Participant; role: "host" | "guest"; currentUserId: string }): ReactNode {
  const name = participant?.displayName ?? "Waiting for your rival";
  const cutout = creatorCutout(participant?.displayName);
  const isYou = participant?.userId === currentUserId;
  return (
    <div className={`flow-creator-card flow-creator-card--${role}`}>
      <div className="flow-creator-card__portrait">
        {cutout ? <img src={cutout} alt="" /> : <CreatorMark name={name} role={role} />}
      </div>
      <div className="flow-creator-card__caption">
        <strong>@{name}</strong>
        <span>{participant ? (isYou ? "You" : "Your rival") : "Invite link ready when you are"}</span>
      </div>
    </div>
  );
}

function FlowHeader({ stage, battle, user, onSignOut }: { stage: FlowStage; battle: Battle; user: SessionUser; onSignOut: () => Promise<void> }): ReactNode {
  const steps: Array<{ id: FlowStage; label: string }> = [
    { id: "invite", label: "Invite" },
    { id: "agree", label: "Agree" },
    { id: "overlay", label: "Overlay" },
    { id: "pick", label: "Pick" },
    { id: "play", label: "Play" }
  ];
  const visibleStage = stage === "result" || stage === "scoreboard" ? "play" : stage;
  const activeIndex = steps.findIndex((item) => item.id === visibleStage);
  return (
    <header className="flow-header">
      <Logo compact />
      <nav className="flow-header__steps" aria-label="Session progress">
        {steps.map((item, index) => <span key={item.id} className={index === activeIndex ? "is-active" : index < activeIndex ? "is-complete" : ""}>{item.label}</span>)}
      </nav>
      <div className="flow-header__account">
        <span className={battle.mode === "simulated" ? "mode-label mode-label--simulated" : "mode-label"}>{battle.mode === "simulated" ? "Simulated" : "Twitch"}</span>
        <button className="button button--text" type="button" onClick={() => void onSignOut()}>@{user.displayName}</button>
      </div>
    </header>
  );
}

function FlowHero({ battle, user }: { battle: Battle; user: SessionUser }): ReactNode {
  return (
    <section className="flow-hero" aria-label="The two streamers in this session">
      <FlowCreatorCard participant={participantFor(battle, "host")} role="host" currentUserId={user.id} />
      <img className="flow-hero__bolt" src="/assets/lightning.png" alt="" aria-hidden="true" />
      <FlowCreatorCard participant={participantFor(battle, "guest")} role="guest" currentUserId={user.id} />
    </section>
  );
}

function Countdown({ until, label = "left" }: { until: string | null; label?: string }): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = until ? Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1_000)) : 0;
  return <span className="flow-countdown"><b>{seconds}s</b> {label}</span>;
}

function FlowAssignments({ round, battle, compact = false }: { round: Round; battle: Battle; compact?: boolean }): ReactNode {
  const host = participantFor(battle, "host");
  const guest = participantFor(battle, "guest");
  const assignmentFor = (participant?: Participant) => round.assignments.find((assignment) => assignment.targetUserId === participant?.userId);
  const cards = [
    { participant: host, assignment: assignmentFor(host), role: "host" as const },
    { participant: guest, assignment: assignmentFor(guest), role: "guest" as const }
  ];
  return (
    <div className={`flow-assignments ${compact ? "flow-assignments--compact" : ""}`}>
      {cards.map(({ participant, assignment, role }) => (
        <section className={`flow-assignment flow-assignment--${role}`} key={role}>
          <span>@{participant?.displayName ?? (role === "host" ? "Host" : "Guest")}</span>
          <strong>{assignment?.title ?? "Play normally"}{assignment?.durationSeconds ? <em>{assignment.durationSeconds}s</em> : null}</strong>
          {!compact && <small>{assignment?.instruction ?? "No valid pick this round."}</small>}
        </section>
      ))}
    </div>
  );
}

function FlowInvite({ battle, user, inviteUrl, invitationBusy, onCreateInvitation }: Pick<BattleFlowProps, "battle" | "user" | "inviteUrl" | "invitationBusy" | "onCreateInvitation">): ReactNode {
  const host = participantFor(battle, "host");
  const isHost = battle.role === "host";
  return (
    <>
      <FlowHero battle={battle} user={user} />
      <section className="flow-sheet flow-sheet--invite">
        <p className="eyebrow">One rival. One shared session.</p>
        <h1>{isHost ? "Invite your rival" : "You joined the session"}</h1>
        <p className="lede">{isHost
          ? "Send this one-time link to the streamer you want to challenge. Nothing opens until you both agree on the challenges."
          : `You are in @${host?.displayName ?? "the host"}'s session. The host is setting up the shared challenges.`}</p>
        {isHost && (
          <div className="flow-invite-control">
            {inviteUrl ? <CopyControl value={inviteUrl} label="battle-invitation-link" /> : <p className="flow-help">Create a private link when you are ready to send it.</p>}
            <button className="button button--primary" type="button" disabled={invitationBusy} onClick={() => void onCreateInvitation()}>
              {invitationBusy ? "Creating invitation…" : inviteUrl ? "Create a new invite link" : "Create invite link"}
            </button>
            {inviteUrl && <p className="quiet-copy">Creating a new link revokes the previous one.</p>}
          </div>
        )}
        {!isHost && <p className="flow-help">You can leave this tab open. The next screen appears as soon as the host shares a challenge list.</p>}
      </section>
    </>
  );
}

function FlowAgreement({ battle, user, busy, onProposeChallenges, onApproveChallenges, onContinue }: Pick<BattleFlowProps, "battle" | "user" | "busy" | "onProposeChallenges" | "onApproveChallenges"> & { onContinue?: () => void }): ReactNode {
  const [options, setOptions] = useState<ChallengeDraft[]>(() => draftOptions(battle.challengeSet));
  const [votingDurationSeconds, setVotingDurationSeconds] = useState(String(battle.challengeSet?.votingDurationSeconds ?? 18));
  const challengeSet = battle.challengeSet;
  const ownApproval = Boolean(challengeSet?.approvedByUserIds.includes(user.id));
  const bothApproved = challengeSet?.approvedByUserIds.length === 2;

  useEffect(() => {
    setOptions(draftOptions(battle.challengeSet));
    setVotingDurationSeconds(String(battle.challengeSet?.votingDurationSeconds ?? 18));
  }, [battle.challengeSet?.id, battle.challengeSet?.version]);

  function updateOption(position: PickPosition, field: "title" | "instruction" | "durationSeconds", value: string): void {
    setOptions((current) => current.map((option) => option.position === position
      ? { ...option, [field]: field === "durationSeconds" ? Number(value) : value }
      : option
    ));
  }

  function addOption(): void {
    setOptions((current) => current.length >= 4 ? current : [...current, {
      position: (current.length + 1) as PickPosition,
      title: "",
      instruction: "Follow this challenge.",
      durationSeconds: 20
    }]);
  }

  function removeOption(position: PickPosition): void {
    setOptions((current) => current.length <= 2 ? current : current
      .filter((option) => option.position !== position)
      .map((option, index) => ({ ...option, position: (index + 1) as PickPosition }))
    );
  }

  return (
    <section className="flow-sheet flow-sheet--agreement">
      <div className="flow-title-row">
        <div className="flow-title-row__avatars"><CreatorMark name={participantFor(battle, "host")?.displayName ?? "Host"} role="host" /><CreatorMark name={participantFor(battle, "guest")?.displayName ?? "Guest"} role="guest" /></div>
        <div><p className="eyebrow">Shared rules</p><h1>Agree on challenges</h1><p className="lede">You and your rival build this list together. Editing it creates a new version that both streamers must approve.</p></div>
      </div>
      <div className="flow-challenge-editor">
        <div className="flow-challenge-editor__labels"><span>Challenge</span><span>Added by</span><span>Time</span></div>
        {options.map((option) => {
          const saved = challengeSet?.options.find((item) => item.position === option.position);
          return <div className="flow-challenge-row" key={option.position}>
            <span className="flow-pick-number">{option.position}</span>
            <div><label className="sr-only" htmlFor={`challenge-title-${option.position}`}>Challenge {option.position}</label><input id={`challenge-title-${option.position}`} value={option.title} maxLength={80} onChange={(event) => updateOption(option.position, "title", event.target.value)} placeholder="Challenge name" /><label className="sr-only" htmlFor={`challenge-instruction-${option.position}`}>Instruction</label><input id={`challenge-instruction-${option.position}`} value={option.instruction} maxLength={180} onChange={(event) => updateOption(option.position, "instruction", event.target.value)} placeholder="What does it mean?" /></div>
            <small>{saved ? `@${saved.addedByDisplayName}` : "New"}</small>
            <label><span className="sr-only">Duration</span><select value={option.durationSeconds} onChange={(event) => updateOption(option.position, "durationSeconds", event.target.value)}>{DURATION_OPTIONS.map((duration) => <option key={duration} value={duration}>{duration}s</option>)}</select></label>
            {options.length > 2 ? <button className="flow-icon-button" type="button" onClick={() => removeOption(option.position)} aria-label={`Remove challenge ${option.position}`}>×</button> : <span />}
          </div>;
        })}
        <div className="flow-challenge-actions">
          {options.length < 4 && <button className="button button--text" type="button" onClick={addOption}>+ Add a challenge</button>}
          <label>Chat pick window <input type="number" min="5" max="120" value={votingDurationSeconds} onChange={(event) => setVotingDurationSeconds(event.target.value)} /> seconds</label>
          <button className="button button--primary" type="button" disabled={busy} onClick={() => void onProposeChallenges(options, Number(votingDurationSeconds))}>Save list</button>
        </div>
      </div>
      <div className="flow-approval-row">
        <p><b>@{participantFor(battle, "host")?.displayName ?? "Host"}</b> {challengeSet?.approvedByUserIds.includes(participantFor(battle, "host")?.userId ?? "") ? "approved" : "is reviewing"} · <b>@{participantFor(battle, "guest")?.displayName ?? "Guest"}</b> {challengeSet?.approvedByUserIds.includes(participantFor(battle, "guest")?.userId ?? "") ? "approved" : "is reviewing"}</p>
        {bothApproved ? onContinue ? <button className="button button--secondary" type="button" onClick={onContinue}>Back to overlay</button> : <span className="flow-approved">Challenges approved ✓</span> : ownApproval ? <span className="flow-help">Waiting for your rival</span> : <button className="button button--primary" type="button" disabled={busy || !challengeSet} onClick={() => void onApproveChallenges()}>Approve challenges</button>}
      </div>
    </section>
  );
}

function FlowOverlaySetup({ battle, user, overlayUrl, busy, onCreateOverlay, onConfirmOverlay, onEditChallenges }: Pick<BattleFlowProps, "battle" | "user" | "overlayUrl" | "busy" | "onCreateOverlay" | "onConfirmOverlay"> & { onEditChallenges: () => void }): ReactNode {
  const ownOverlayConfirmed = battle.participants.some((participant) => participant.userId === user.id && participant.overlayConfirmedAt);
  const bothConfirmed = battle.participants.length === 2 && battle.participants.every((participant) => participant.overlayConfirmedAt);
  const rival = battle.participants.find((participant) => participant.userId !== user.id);
  return (
    <section className="flow-sheet flow-sheet--overlay">
      <div className="flow-title-row">
        <CreatorMark name={user.displayName} role={battle.role} />
        <div><p className="eyebrow">Your stream</p><h1>Set up your stream overlay</h1><p className="lede">Paste your private link into an OBS Browser Source, then confirm after you can see it on your stream.</p></div>
      </div>
      <div className="flow-overlay-layout">
        <div>
          <h2>Your private browser-source link</h2>
          {overlayUrl ? <><CopyControl value={overlayUrl} label="private-overlay-link" /><a className="flow-inline-link" href={overlayUrl} target="_blank" rel="noreferrer">Open overlay preview ↗</a><p className="quiet-copy">Keep this link private. Its credential is the part after <code>#</code>.</p></> : <button className="button button--primary" type="button" disabled={busy} onClick={() => void onCreateOverlay()}>Create my private link</button>}
          <ol className="flow-steps"><li>Add a Browser Source in OBS.</li><li>Paste your private link.</li><li>Check that it appears on stream.</li></ol>
          {overlayUrl && !ownOverlayConfirmed && <button className="button button--primary" type="button" disabled={busy} onClick={() => void onConfirmOverlay()}>I can see it in OBS</button>}
          {ownOverlayConfirmed && <p className="flow-approved">Your overlay is confirmed ✓</p>}
          <button className="button button--text" type="button" onClick={onEditChallenges}>Edit shared challenges</button>
        </div>
        <aside className="flow-overlay-preview" aria-label="Overlay preview">
          <span>Read-only browser source</span>
          <div><CreatorMark name={user.displayName} role={battle.role} /><strong>@{user.displayName}</strong><i>↔</i><CreatorMark name={rival?.displayName ?? "?"} role={battle.role === "host" ? "guest" : "host"} /><strong>@{rival?.displayName ?? "Rival"}</strong></div>
          <p>{bothConfirmed ? "Both overlays are ready." : `Waiting for @${rival?.displayName ?? "your rival"} to confirm.`}</p>
        </aside>
      </div>
    </section>
  );
}

function FlowPick({ battle, user, busy, onOpenVoting, onLockInPicks, onStopRound, onSimulateVote }: Pick<BattleFlowProps, "battle" | "user" | "busy" | "onOpenVoting" | "onLockInPicks" | "onStopRound" | "onSimulateVote">): ReactNode {
  const round = battle.round;
  const challengeSet = battle.challengeSet;
  const [stopArmed, setStopArmed] = useState(false);
  const canOpen = battle.participants.length === 2
    && Boolean(challengeSet && challengeSet.approvedByUserIds.length === 2)
    && battle.participants.every((participant) => participant.overlayConfirmedAt)
    && battle.participants.every((participant) => participant.chatConnectedAt);
  const host = participantFor(battle, "host");
  const guest = participantFor(battle, "guest");

  function requestStop(): void {
    if (!round) return;
    if (stopArmed) {
      setStopArmed(false);
      void onStopRound(round.id);
      return;
    }
    setStopArmed(true);
    window.setTimeout(() => setStopArmed(false), 2500);
  }

  if (!round) {
    const explanation = !challengeSet ? "Add a challenge list first." : challengeSet.approvedByUserIds.length !== 2 ? "Both streamers need to approve this exact list." : !battle.participants.every((participant) => participant.overlayConfirmedAt) ? "Both streamers need to confirm their own overlay." : !battle.participants.every((participant) => participant.chatConnectedAt) ? "Both Twitch chats must be connected." : "Either streamer can open the next pick.";
    return <><FlowHero battle={battle} user={user} /><section className="flow-sheet flow-sheet--pick-empty"><p className="eyebrow">Chat control</p><h1>Let chat choose</h1><p className="lede">Each chat picks a challenge for the other streamer to play.</p><button className="button button--primary" type="button" disabled={busy || !canOpen} onClick={() => void onOpenVoting()}>Let chat pick</button><p className="flow-help">{explanation}</p></section></>;
  }

  return <><FlowHero battle={battle} user={user} /><section className="flow-sheet flow-sheet--pick"><div className="flow-pick-heading"><p className="eyebrow">Live picks</p><h1>Chats are choosing</h1><Countdown until={round.votingDeadlineAt} label="left to pick" /></div><div className="flow-pick-columns">{[
    { target: host, source: guest, sourceRole: "guest" as const, label: "Your challenge" },
    { target: guest, source: host, sourceRole: "host" as const, label: `${guest?.displayName ?? "Rival"}'s challenge` }
  ].map(({ target, source, sourceRole, label }) => <section className="flow-pick-panel" key={sourceRole}><h2>{target?.userId === user.id ? "Your challenge" : label}</h2><p>Picked by @{source?.displayName ?? "the other"}'s chat · type <code>!pick 1–{challengeSet?.options.length ?? 3}</code></p><ol>{challengeSet?.options.map((option) => <li key={option.id}><span>{option.position}</span><strong>{option.title}</strong><em>{option.durationSeconds}s</em>{battle.mode === "simulated" && <button type="button" disabled={busy} onClick={() => void onSimulateVote(sourceRole, option.position)}>Simulate !pick {option.position}</button>}</li>)}</ol></section>)}</div>{battle.mode === "simulated" && <p className="flow-demo-note">Simulated votes are marked here and never reach Twitch.</p>}<div className="flow-sheet__actions"><button className={`button ${stopArmed ? "button--primary" : "button--text button--danger"}`} type="button" disabled={busy} onClick={requestStop}>{stopArmed ? "Tap again to stop" : "Stop round"}</button><button className="button button--primary" type="button" disabled={busy} onClick={() => void onLockInPicks(round.id)}>Lock in picks</button></div></section></>;
}

function FlowPlay({ battle, user, busy, onReady, onUnready, onCancelStart, onStopRound, onSimulateRivalReady }: Pick<BattleFlowProps, "battle" | "user" | "busy" | "onReady" | "onUnready" | "onCancelStart" | "onStopRound" | "onSimulateRivalReady">): ReactNode {
  const round = battle.round;
  const [stopArmed, setStopArmed] = useState(false);
  if (!round) return null;
  const ownReady = round.readyUserIds.includes(user.id);
  const rival = battle.participants.find((participant) => participant.userId !== user.id);
  const rivalReady = Boolean(rival && round.readyUserIds.includes(rival.userId));
  const requestStop = (): void => {
    if (stopArmed) { setStopArmed(false); void onStopRound(round.id); return; }
    setStopArmed(true); window.setTimeout(() => setStopArmed(false), 2500);
  };
  return <><FlowHero battle={battle} user={user} /><section className="flow-sheet flow-sheet--play"><FlowAssignments round={round} battle={battle} />{round.phase === "revealed" && <div className="flow-ready"><div><p className="eyebrow">Both streamers decide</p><h1>{ownReady ? "Waiting for your rival" : "Ready to play?"}</h1><p className="lede">The three-second countdown begins only when both streamers are ready.</p></div><div className="flow-ready__status"><span>{ownReady ? "✓ You are ready" : "You are not ready"}</span><span>{rivalReady ? `✓ @${rival?.displayName ?? "Rival"} is ready` : `Waiting for @${rival?.displayName ?? "Rival"}`}</span></div><div className="flow-sheet__actions">{ownReady ? <button className="button button--secondary" type="button" disabled={busy} onClick={() => void onUnready(round.id)}>Not ready</button> : <button className="button button--primary" type="button" disabled={busy} onClick={() => void onReady(round.id)}>I’m ready</button>}{battle.mode === "simulated" && !rivalReady && <button className="button button--secondary" type="button" disabled={busy} onClick={() => void onSimulateRivalReady(round.id)}>Simulate rival ready</button>}<button className="button button--text button--danger" type="button" disabled={busy} onClick={requestStop}>Stop round</button></div></div>}{round.phase === "countdown" && <div className="flow-countdown-splash"><p>Starting in</p><Countdown until={round.activeAt ?? round.countdownStartsAt} label="" /><button className="button button--text" type="button" disabled={busy} onClick={() => void onCancelStart(round.id)}>Cancel start</button></div>}{round.phase === "active" && <div className="flow-active"><p className="eyebrow">Challenges are on</p><h1>Play it out.</h1><p className="lede">Both challenges clear on their own timer.</p><div className="flow-active__timers">{round.assignments.map((assignment) => <span key={assignment.targetUserId}>@{assignment.targetDisplayName} {assignment.endsAt ? <Countdown until={assignment.endsAt} /> : "Cleared"}</span>)}</div><button className={`button ${stopArmed ? "button--primary" : "button--text button--danger"}`} type="button" disabled={busy} onClick={requestStop}>{stopArmed ? "Tap again to stop" : "Stop round"}</button></div>}</section></>;
}

function FlowResult({ battle, user, busy, onRecordOutcome, onOpenVoting }: Pick<BattleFlowProps, "battle" | "user" | "busy" | "onRecordOutcome" | "onOpenVoting">): ReactNode {
  const round = battle.round;
  if (!round) return null;
  const message = round.phase === "no-votes" ? "No valid picks this time. Play normally." : round.phase === "stopped" ? `${round.stoppedByDisplayName ? `@${round.stoppedByDisplayName} stopped this round.` : "This round was stopped."} Both challenges are cleared.` : round.phase === "invalidated" ? "A chat feed disconnected before the countdown, so this round was cancelled." : "Both challenges are complete. Choose the round result.";
  return <><FlowHero battle={battle} user={user} /><section className="flow-sheet flow-sheet--result"><p className="eyebrow">Round update</p><h1>{round.phase === "complete" ? "Round complete" : round.phase === "no-votes" ? "No picks this time" : round.phase === "stopped" ? "Round stopped" : "Round cancelled"}</h1><p className="lede">{message}</p><FlowAssignments round={round} battle={battle} compact />{round.phase === "complete" && !round.outcome && <div className="flow-outcome"><strong>Who won?</strong><span>Backseat records the result the streamers select. It does not judge gameplay.</span><div>{(["host", "guest", "draw"] as const).map((outcome) => <button key={outcome} className="button button--secondary" type="button" disabled={busy} onClick={() => void onRecordOutcome(round.id, outcome)}>{outcome === "draw" ? "Draw" : `@${participantFor(battle, outcome)?.displayName ?? outcome}`}</button>)}</div></div>}{round.phase !== "complete" && <button className="button button--primary" type="button" disabled={busy} onClick={() => void onOpenVoting()}>Open next pick</button>}</section></>;
}

function FlowScoreboard({ battle, busy, onOpenVoting, onEndBattle }: Pick<BattleFlowProps, "battle" | "busy" | "onOpenVoting" | "onEndBattle">): ReactNode {
  const [endArmed, setEndArmed] = useState(false);
  const host = participantFor(battle, "host");
  const guest = participantFor(battle, "guest");
  const current = battle.history[0] ?? battle.round;
  function end(): void {
    if (endArmed) { setEndArmed(false); void onEndBattle(); return; }
    setEndArmed(true); window.setTimeout(() => setEndArmed(false), 2500);
  }
  return <section className="flow-sheet flow-sheet--scoreboard"><div className="flow-title-row"><div className="flow-title-row__avatars"><CreatorMark name={host?.displayName ?? "Host"} role="host" /><CreatorMark name={guest?.displayName ?? "Guest"} role="guest" /></div><div><p className="eyebrow">Session score</p><h1>Scoreboard</h1><p className="flow-score">@{host?.displayName ?? "Host"} <b>{battle.score.host}</b> – <b>{battle.score.guest}</b> @{guest?.displayName ?? "Guest"}</p></div></div>{current && <div className="flow-history"><span>Round #{"sequence" in current ? current.sequence : "—"}</span><strong>{current.assignments.map((assignment) => `${assignment.targetDisplayName} faced ${assignment.title ?? "no challenge"}`).join(" · ")}</strong><span>{current.outcome === "draw" ? "Draw" : current.outcome === "host" ? `@${host?.displayName ?? "Host"} won` : current.outcome === "guest" ? `@${guest?.displayName ?? "Guest"} won` : "Recorded"}</span></div>}<div className="flow-sheet__actions"><button className={`button ${endArmed ? "button--primary" : "button--text button--danger"}`} type="button" disabled={busy} onClick={end}>{endArmed ? "Tap again to end" : "End session"}</button>{battle.status !== "ended" && <button className="button button--primary" type="button" disabled={busy} onClick={() => void onOpenVoting()}>Start next round</button>}</div></section>;
}

function BattleFlow(props: BattleFlowProps): ReactNode {
  const { battle, user } = props;
  const [editingChallenges, setEditingChallenges] = useState(false);
  const hasRival = battle.participants.some((participant) => participant.role === "guest");
  const bothApproved = battle.challengeSet?.approvedByUserIds.length === 2;
  const bothOverlays = battle.participants.length === 2 && battle.participants.every((participant) => participant.overlayConfirmedAt);
  const round = battle.round;
  useEffect(() => {
    if (!battle.challengeSet || !bothApproved || round) setEditingChallenges(false);
  }, [battle.challengeSet?.id, battle.challengeSet?.version, bothApproved, round?.id]);
  let stage: FlowStage = "scoreboard";
  if (battle.status === "ended") stage = "scoreboard";
  else if (!hasRival || battle.status === "setup") stage = "invite";
  else if (!battle.challengeSet || !bothApproved) stage = "agree";
  else if (!bothOverlays) stage = "overlay";
  else if (!round || round.phase === "voting") stage = "pick";
  else if (["revealed", "countdown", "active"].includes(round.phase)) stage = "play";
  else if (round.phase === "complete" && !round.outcome || ["no-votes", "stopped", "invalidated"].includes(round.phase)) stage = "result";
  if (editingChallenges && !round) stage = "agree";

  const content = stage === "invite" ? <FlowInvite {...props} />
    : stage === "agree" ? <FlowAgreement {...props} onContinue={editingChallenges ? () => setEditingChallenges(false) : undefined} />
      : stage === "overlay" ? <FlowOverlaySetup {...props} onEditChallenges={() => setEditingChallenges(true)} />
        : stage === "pick" ? <FlowPick {...props} />
          : stage === "play" ? <FlowPlay {...props} />
            : stage === "result" ? <FlowResult {...props} />
              : <FlowScoreboard {...props} />;
  return <section className="flow-frame"><FlowHeader stage={stage} battle={battle} user={user} onSignOut={props.onSignOut} />{content}</section>;
}

function CreatorView({ user, battle, invite, initialOverlayUrl, onRefresh, onSignOut }: {
  user: SessionUser;
  battle: Battle | null;
  invite: string | null;
  initialOverlayUrl: string | null;
  onRefresh: () => Promise<void>;
  onSignOut: () => Promise<void>;
}): ReactNode {
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [overlayUrl, setOverlayUrl] = useState<string | null>(initialOverlayUrl);
  const [isCreating, setIsCreating] = useState(false);
  const [isRotatingInvitation, setIsRotatingInvitation] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);
  const [isCreatingOverlay, setIsCreatingOverlay] = useState(false);
  const [isMutatingBattle, setIsMutatingBattle] = useState(false);

  useEffect(() => {
    if (initialOverlayUrl) setOverlayUrl(initialOverlayUrl);
  }, [initialOverlayUrl]);

  async function createBattle(): Promise<void> {
    setError(null);
    setIsCreating(true);
    try {
      const result = await api<CreateBattleResponse>("/api/battles", { method: "POST" });
      setInviteUrl(result.inviteUrl);
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the battle.");
    } finally {
      setIsCreating(false);
    }
  }

  async function rotateInvitation(): Promise<void> {
    setError(null);
    setIsRotatingInvitation(true);
    try {
      const result = await api<CreateBattleResponse>("/api/battles/current/invitation/rotate", { method: "POST" });
      setInviteUrl(result.inviteUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create a fresh invitation link.");
    } finally {
      setIsRotatingInvitation(false);
    }
  }

  async function acceptInvite(): Promise<void> {
    if (!invite) return;
    setError(null);
    setIsAccepting(true);
    try {
      await api<{ battleId: string }>("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ secret: invite })
      });
      clearInviteFromPage();
      await onRefresh();
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not join this battle.");
      setIsAccepting(false);
    }
  }

  async function createOverlay(): Promise<void> {
    setError(null);
    setIsCreatingOverlay(true);
    try {
      const result = await api<OverlayCredentialResponse>("/api/overlay-credentials", { method: "POST" });
      setOverlayUrl(result.overlayUrl);
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create an overlay link.");
    } finally {
      setIsCreatingOverlay(false);
    }
  }

  async function mutateBattle(path: string, body?: unknown): Promise<boolean> {
    setError(null);
    setIsMutatingBattle(true);
    try {
      await api(path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      await onRefresh();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Backseat could not update the battle.");
      return false;
    } finally {
      setIsMutatingBattle(false);
    }
  }

  async function proposeChallenges(options: ChallengeDraft[], votingDurationSeconds: number): Promise<boolean> {
    if (!battle) return false;
    return mutateBattle("/api/battles/current/challenge-sets", {
      stateVersion: battle.stateVersion,
      votingDurationSeconds,
      options
    });
  }

  async function approveChallenges(): Promise<boolean> {
    if (!battle) return false;
    return mutateBattle("/api/battles/current/challenge-set/approve", { stateVersion: battle.stateVersion });
  }

  async function confirmOverlay(): Promise<boolean> {
    if (!battle) return false;
    return mutateBattle("/api/battles/current/overlay-confirmation", { stateVersion: battle.stateVersion });
  }

  async function openVoting(): Promise<boolean> {
    if (!battle) return false;
    return mutateBattle("/api/battles/current/rounds/open", { stateVersion: battle.stateVersion });
  }

  return (
    <PageShell>
      <main className="creator-stage creator-stage--flow">
        {error && <Notice tone="error">{error}</Notice>}
        {invite && <section className="flow-frame flow-frame--invite-decision"><InviteDecision invite={invite} battle={battle} accepting={isAccepting} onAccept={acceptInvite} /></section>}

        {!battle && !invite && !user.isDemo && (
          <section className="flow-sheet flow-sheet--new-session" aria-labelledby="create-title">
            <p className="eyebrow">Connected as @{user.displayName}</p>
            <h1 id="create-title">Start a session with your rival.</h1>
            <p className="lede">Create the private, one-time invitation first. You will agree on the challenges before either chat can pick.</p>
            <button className="button button--primary" type="button" disabled={isCreating} onClick={() => void createBattle()}>
              {isCreating ? "Creating…" : "Create a session"}
            </button>
          </section>
        )}
        {!battle && !invite && user.isDemo && (
          <section className="flow-sheet flow-sheet--new-session" aria-labelledby="demo-ended-title">
            <p className="eyebrow">Simulated demo ended</p>
            <h1 id="demo-ended-title">Connect Twitch for a real session.</h1>
            <p className="lede">This isolated demo uses simulated identities and picks. It cannot receive Twitch chat or create a live session.</p>
            <button className="button button--secondary" type="button" onClick={() => void onSignOut()}>Sign out</button>
          </section>
        )}

        {battle && <BattleFlow
          battle={battle}
          user={user}
          overlayUrl={overlayUrl}
          inviteUrl={inviteUrl}
          busy={isMutatingBattle || isCreatingOverlay}
          invitationBusy={isRotatingInvitation}
          onCreateInvitation={rotateInvitation}
          onCreateOverlay={createOverlay}
          onConfirmOverlay={confirmOverlay}
          onProposeChallenges={proposeChallenges}
          onApproveChallenges={approveChallenges}
          onOpenVoting={openVoting}
          onReady={(roundId) => mutateBattle(`/api/battles/current/rounds/${roundId}/ready`)}
          onUnready={(roundId) => mutateBattle(`/api/battles/current/rounds/${roundId}/unready`)}
          onCancelStart={(roundId) => mutateBattle(`/api/battles/current/rounds/${roundId}/cancel-start`)}
          onLockInPicks={(roundId) => mutateBattle(`/api/battles/current/rounds/${roundId}/lock-picks`, { stateVersion: battle.stateVersion })}
          onStopRound={(roundId) => mutateBattle(`/api/battles/current/rounds/${roundId}/stop`)}
          onRecordOutcome={(roundId, outcome) => mutateBattle(`/api/battles/current/rounds/${roundId}/outcome`, { outcome })}
          onEndBattle={() => mutateBattle("/api/battles/current/end", { stateVersion: battle.stateVersion })}
          onSimulateVote={(sourceRole, option) => mutateBattle("/api/demo/votes", { sourceRole, option })}
          onSimulateRivalReady={(roundId) => mutateBattle(`/api/demo/rounds/${roundId}/rival-ready`)}
          onSignOut={onSignOut}
        />}
        {isCreatingOverlay && <p className="inline-progress" aria-live="polite">Creating your private overlay link…</p>}
      </main>
    </PageShell>
  );
}

function OverlayTimer({ until }: { until: string }): ReactNode {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const remaining = Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1_000));
  return <strong className="overlay-timer">{remaining}s left</strong>;
}

function overlayPhaseCopy(snapshot: OverlaySnapshot): { heading: string; detail: string } {
  const phase = snapshot.phase;
  switch (phase) {
    case "waiting-for-rival": return { heading: "Waiting for rival", detail: "Both streamers must connect." };
    case "setup": return snapshot.participants.every((participant) => participant.chatConnected)
      ? { heading: "Setup in progress", detail: "Agree on challenges and confirm your overlays." }
      : { heading: "Waiting for Twitch chat", detail: "Voting stays closed until both chat feeds reconnect." };
    case "ready-for-voting": return { heading: "Ready for chat", detail: "Either streamer can open the next pick." };
    case "voting": return { heading: "Chats are choosing", detail: "Use !pick in Twitch chat." };
    case "revealed": return { heading: "Chat has chosen", detail: "Waiting for both streamers." };
    case "countdown": return { heading: "Challenges locked", detail: "Challenges begin together." };
    case "active": return { heading: "Challenges active", detail: "The round is live." };
    case "complete": return { heading: "Challenges ended", detail: "Play normally." };
    case "no-votes": return { heading: "No picks this time", detail: "Play normally." };
    case "stopped": return { heading: "Round stopped", detail: "Challenges are cleared." };
    case "invalidated": return { heading: "Picks cancelled", detail: "Chat disconnected before the round began." };
  }
}

function OverlayApp(): ReactNode {
  const [snapshot, setSnapshot] = useState<OverlaySnapshot | null>(null);
  const [connection, setConnection] = useState<OverlayConnection>("connecting");
  const [message, setMessage] = useState("Exchanging the private overlay credential…");
  const lastAuthoritativeAt = useRef(0);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;

    function touch(): void {
      lastAuthoritativeAt.current = Date.now();
    }

    async function start(): Promise<void> {
      const secret = window.location.hash.slice(1).trim();
      if (secret) {
        // URL fragments never reach the server automatically. Clear the fragment before
        // connecting so it cannot be copied from a browser history entry later.
        window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
        try {
          await api<void>("/api/overlay/exchange", {
            method: "POST",
            body: JSON.stringify({ secret })
          });
        } catch (reason) {
          if (!disposed) {
            setConnection("error");
            setMessage(reason instanceof Error ? reason.message : "The overlay link could not be exchanged.");
          }
          return;
        }
      }

      try {
        const initial = await api<OverlaySnapshot>("/api/overlay/snapshot");
        if (disposed) return;
        setSnapshot(initial);
        touch();
        setConnection("connecting");
        setMessage("Connecting to the read-only live overlay…");

        source = new EventSource("/api/overlay/events", { withCredentials: true });
        source.addEventListener("snapshot", (event) => {
          try {
            const next = JSON.parse((event as MessageEvent<string>).data) as OverlaySnapshot;
            if (!disposed) {
              setSnapshot(next);
              touch();
            }
          } catch {
            // Ignore malformed events: the next server snapshot will reconcile the view.
          }
        });
        source.addEventListener("heartbeat", () => {
          if (!disposed) touch();
        });
        source.onopen = () => {
          if (!disposed) {
            touch();
            setConnection("live");
            setMessage("Read-only live overlay connected.");
          }
        };
        source.onerror = () => {
          if (!disposed) {
            setConnection("lost");
            setMessage("Connection lost. Live instructions are hidden until Backseat reconnects.");
          }
        };
      } catch (reason) {
        if (!disposed) {
          setConnection("error");
          setMessage(reason instanceof Error ? reason.message : "The overlay session is unavailable.");
        }
      }
    }

    void start();
    const staleTimer = window.setInterval(() => {
      if (lastAuthoritativeAt.current > 0 && Date.now() - lastAuthoritativeAt.current > 20_000) {
        setConnection((current) => current === "error" ? current : "lost");
        setMessage("Connection lost. Live instructions are hidden until Backseat reconnects.");
      }
    }, 1_000);

    return () => {
      disposed = true;
      window.clearInterval(staleTimer);
      source?.close();
    };
  }, []);

  const host = snapshot?.participants.find((participant) => participant.role === "host");
  const guest = snapshot?.participants.find((participant) => participant.role === "guest");
  const hasLiveState = connection === "live" || connection === "connecting";
  const phaseCopy = snapshot ? overlayPhaseCopy(snapshot) : null;

  return (
    <main className="overlay-root" aria-label="Backseat read-only stream overlay">
      <p className="sr-only" aria-live="polite">{message}</p>
      {!hasLiveState || !snapshot ? (
        <section className="overlay-connection" role={connection === "error" ? "alert" : "status"}>
          <Logo compact />
          <div><strong>{connection === "error" ? "Overlay unavailable" : "Connection lost"}</strong><span>{message}</span></div>
        </section>
      ) : (
        <section className="overlay-strip">
            <div className="overlay-strip__brand"><Logo compact /><span className="overlay-phase">{phaseCopy?.heading}</span></div>
          <div className="overlay-creator">
            <CreatorMark name={host?.displayName ?? "?"} role="host" />
              <div><span>@{host?.displayName ?? "Host"}</span><strong>{snapshot.phase === "voting" ? "Chat chooses rival" : "Streamer"}</strong></div>
          </div>
            <div className="overlay-state">
              <strong>{phaseCopy?.heading}</strong>
              <span>{phaseCopy?.detail}</span>
              {snapshot.phase === "voting" && snapshot.votingDeadlineAt && <OverlayTimer until={snapshot.votingDeadlineAt} />}
              {snapshot.phase === "countdown" && snapshot.countdownStartsAt && <OverlayTimer until={snapshot.countdownStartsAt} />}
          </div>
          <div className="overlay-creator overlay-creator--guest">
              <div><span>@{guest?.displayName ?? "Rival"}</span><strong>{snapshot.phase === "voting" ? "Chat chooses rival" : "Streamer"}</strong></div>
            <CreatorMark name={guest?.displayName ?? "?"} role="guest" />
          </div>
            {snapshot.phase === "voting" && (
              <div className="overlay-commands" aria-label="Twitch voting commands">
                {snapshot.challenges.map((challenge) => <span key={challenge.position}><b>!pick {challenge.position}</b> {challenge.title} · {challenge.durationSeconds}s</span>)}
              </div>
            )}
            {snapshot.restrictions.length > 0 && snapshot.phase !== "voting" && (
              <div className="overlay-restrictions" aria-label="Current challenge assignments">
                {snapshot.restrictions.map((restriction) => (
                  <span key={restriction.targetDisplayName}><b>@{restriction.targetDisplayName}</b> · {restriction.title}{restriction.clearedAt ? " · Cleared" : ""}</span>
                ))}
              </div>
            )}
          {snapshot.mode === "simulated" && <span className="overlay-demo">Simulated</span>}
        </section>
      )}
    </main>
  );
}

export function App(): ReactNode {
  const isOverlay = useMemo(() => new URLSearchParams(window.location.search).get("overlay") === "1", []);
  const queryClient = useQueryClient();
  const [invite, setInvite] = useState<string | null>(() => queryInvite());
  const [isStartingDemo, setIsStartingDemo] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoOverlayUrl, setDemoOverlayUrl] = useState<string | null>(null);
  const initialOAuthResult = useRef(new URLSearchParams(window.location.search).get("oauth"));
  const initialOAuthReason = useRef(new URLSearchParams(window.location.search).get("reason"));
  const sessionQuery = useQuery({
    queryKey: ["session"],
    queryFn: () => api<SessionResponse>("/api/session"),
    enabled: !isOverlay
  });
  const user = sessionQuery.data?.user ?? null;
  const battleQuery = useQuery({
    queryKey: ["battle", "current"],
    queryFn: () => api<CurrentBattleResponse>("/api/battles/current"),
    enabled: !isOverlay && Boolean(user)
  });
  const battle = battleQuery.data?.battle ?? null;
  const loading = sessionQuery.isPending || (Boolean(user) && battleQuery.isPending);
  const queryError = sessionQuery.error ?? battleQuery.error;
  const loadError = queryError instanceof Error ? queryError.message : queryError ? "Backseat could not load your session." : null;

  const refresh = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["session"] });
    await queryClient.invalidateQueries({ queryKey: ["battle", "current"] });
  }, [queryClient]);

  useEffect(() => {
    if (!isOverlay && !sessionQuery.isPending) cleanOAuthQuery();
  }, [isOverlay, sessionQuery.isPending]);

  async function signOut(): Promise<void> {
    await api<void>("/api/logout", { method: "POST" });
    queryClient.removeQueries({ queryKey: ["session"] });
    queryClient.removeQueries({ queryKey: ["battle", "current"] });
    window.location.assign("/");
  }

  async function startDemo(): Promise<void> {
    setDemoError(null);
    setIsStartingDemo(true);
    try {
      const result = await api<OverlayCredentialResponse>("/api/demo/start", { method: "POST" });
      setDemoOverlayUrl(result.overlayUrl);
      await refresh();
    } catch (reason) {
      setDemoError(reason instanceof Error ? reason.message : "Could not start the simulated demo.");
    } finally {
      setIsStartingDemo(false);
    }
  }

  if (isOverlay) return <OverlayApp />;

  if (loading) {
    return (
      <PageShell><main className="loading-stage" aria-live="polite"><p>Checking your secure streamer session…</p></main></PageShell>
    );
  }

  if (loadError) {
    return (
      <PageShell>
        <main className="loading-stage"><Notice tone="error">{loadError}</Notice><button className="button button--secondary" type="button" onClick={() => void refresh()}>Try again</button></main>
      </PageShell>
    );
  }

  if (!user) {
    const oauthMessage = demoError ?? (initialOAuthResult.current === "denied"
      ? "Twitch authorization was cancelled or could not be verified. No streamer session was created."
      : initialOAuthResult.current === "failed"
        ? initialOAuthReason.current === "token-exchange"
          ? "Twitch rejected Backseat’s server credentials or callback settings. In Render, confirm the current client secret belongs to the same Twitch app as the client ID, then confirm Twitch has this exact callback URL: https://backseat-2znp.onrender.com/auth/twitch/callback."
          : initialOAuthReason.current === "token-validation"
            ? "Twitch issued a token Backseat could not validate. Try connecting again; if it repeats, confirm the Render client ID belongs to this Twitch app."
            : initialOAuthReason.current === "scope"
              ? "Twitch did not grant the required chat permission. Approve the requested Twitch access and try again."
              : initialOAuthReason.current === "database-schema"
                ? "Backseat’s database setup is incomplete. Wait for the latest Render deployment to finish its migrations, then try again."
                : "Twitch authorization failed on the server. Check the current Render log entry named “Twitch OAuth callback failed” and try again."
        : null);
    return <CreatorLanding invite={invite} oauthMessage={oauthMessage} startingDemo={isStartingDemo} onStartDemo={startDemo} />;
  }

  return <CreatorView user={user} battle={battle} invite={invite} initialOverlayUrl={user.isDemo ? demoOverlayUrl : null} onRefresh={refresh} onSignOut={signOut} />;
}
