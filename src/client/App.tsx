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

type ChallengeDraft = {
  position: 1 | 2 | 3;
  title: string;
  instruction: string;
  durationSeconds: number;
};

type ChallengeSet = {
  id: string;
  version: number;
  votingDurationSeconds: number;
  options: Array<ChallengeDraft & { id: string }>;
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
  readyUserIds: string[];
  assignments: RoundAssignment[];
};

type LastAcceptedVote = {
  option: "1" | "2" | "3";
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
    <span className={`brand ${compact ? "brand--compact" : ""}`} aria-label="Backseat">
      <span>BACK</span><span className="brand__accent">SEAT</span><span className="brand__bolt" aria-hidden="true">ϟ</span>
    </span>
  );
}

function CreatorMark({ name, role }: { name: string; role: "host" | "guest" }): ReactNode {
  const initial = name.trim().slice(0, 1).toUpperCase() || "?";
  return (
    <span className={`creator-mark creator-mark--${role}`} aria-hidden="true">
      <span>{initial}</span>
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
        <span className="site-header__label">Two creators. Two communities.</span>
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
        <section className="paired-portraits" aria-label="Backseat is for two Twitch creators">
          <div className="portrait-plate portrait-plate--host"><CreatorMark name="F" role="host" /></div>
          <span className="stage-bolt" aria-hidden="true">ϟ</span>
          <div className="portrait-plate portrait-plate--guest"><CreatorMark name="R" role="guest" /></div>
        </section>
        <section className="lower-sheet lower-sheet--landing">
          <p className="eyebrow">Creator coordination for Twitch</p>
          <h1>Let chat backseat your rival.</h1>
          <p className="lede">Connect your Twitch account, invite one creator, then prove their chat commands target the opposing player.</p>
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
        <h2 id="invite-title">You already have an open battle.</h2>
        <p>Backseat keeps one open battle per creator. Finish or leave the current battle before accepting another invitation.</p>
      </section>
    );
  }

  return (
    <section className="invite-decision" aria-labelledby="invite-title">
      <p className="eyebrow">Invitation pending</p>
      <h2 id="invite-title">Join this two-creator integration proof?</h2>
      <p>You will occupy the guest seat. Joining does not open voting or start a round.</p>
      <button className="button button--primary" type="button" disabled={accepting} onClick={() => void onAccept()}>
        {accepting ? "Joining…" : "Join battle"}
      </button>
    </section>
  );
}

function BattleIdentity({ battle, user }: { battle: Battle; user: SessionUser }): ReactNode {
  const host = battle.participants.find((participant) => participant.role === "host");
  const guest = battle.participants.find((participant) => participant.role === "guest");

  return (
    <section className="battle-identity" aria-label="Battle creators">
      <div className="battle-identity__creator">
        <CreatorMark name={host?.displayName ?? "?"} role="host" />
        <div><strong>@{host?.displayName ?? "Waiting for host"}</strong><span>{host?.userId === user.id ? "You · Host" : "Host creator"} · {host?.chatConnectedAt ? (battle.mode === "simulated" ? "Simulated chat" : "Chat connected") : "Chat reconnecting"}</span></div>
      </div>
      <span className="battle-identity__bolt" aria-hidden="true">ϟ</span>
      <div className="battle-identity__creator battle-identity__creator--right">
        <div><strong>@{guest?.displayName ?? "Waiting for rival"}</strong><span>{guest ? `${guest.userId === user.id ? "You · Guest" : "Guest creator"} · ${guest.chatConnectedAt ? (battle.mode === "simulated" ? "Simulated chat" : "Chat connected") : "Chat reconnecting"}` : "Invite a rival"}</span></div>
        <CreatorMark name={guest?.displayName ?? "?"} role="guest" />
      </div>
    </section>
  );
}

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
  onStopRound,
  onEndBattle,
  onSimulateVote,
  onSimulateRivalReady
}: {
  battle: Battle;
  user: SessionUser;
  overlayUrl: string | null;
  busy: boolean;
  onCreateOverlay: () => Promise<void>;
  onConfirmOverlay: () => Promise<boolean>;
  onProposeChallenges: (options: ChallengeDraft[], votingDurationSeconds: number) => Promise<boolean>;
  onApproveChallenges: () => Promise<boolean>;
  onOpenVoting: () => Promise<boolean>;
  onReady: (roundId: string) => Promise<boolean>;
  onUnready: (roundId: string) => Promise<boolean>;
  onCancelStart: (roundId: string) => Promise<boolean>;
  onStopRound: (roundId: string) => Promise<boolean>;
  onEndBattle: () => Promise<boolean>;
  onSimulateVote: (sourceRole: "host" | "guest", option: 1 | 2 | 3) => Promise<boolean>;
  onSimulateRivalReady: (roundId: string) => Promise<boolean>;
}): ReactNode {
  const [editorOpen, setEditorOpen] = useState(!battle.challengeSet);
  const [options, setOptions] = useState<ChallengeDraft[]>(() => battle.challengeSet?.options.map(({ id: _id, ...option }) => option) ?? DEFAULT_CHALLENGES.map((option) => ({ ...option })));
  const [votingDurationSeconds, setVotingDurationSeconds] = useState(String(battle.challengeSet?.votingDurationSeconds ?? 30));
  const hasRival = battle.participants.some((participant) => participant.role === "guest");
  const ownOverlayConfirmed = battle.participants.some((participant) => participant.userId === user.id && participant.overlayConfirmedAt);
  const bothOverlaysConfirmed = battle.participants.length === 2 && battle.participants.every((participant) => participant.overlayConfirmedAt);
  const bothChatsConnected = battle.participants.length === 2 && battle.participants.every((participant) => participant.chatConnectedAt);
  const challengeSet = battle.challengeSet;
  const ownApproval = Boolean(challengeSet?.approvedByUserIds.includes(user.id));
  const bothApproved = challengeSet?.approvedByUserIds.length === 2;
  const round = battle.round;
  const liveRound = Boolean(round && ["voting", "revealed", "countdown", "active"].includes(round.phase));
  const canEdit = battle.role === "host" && !liveRound;

  function updateOption(position: 1 | 2 | 3, field: keyof Omit<ChallengeDraft, "position">, value: string): void {
    setOptions((current) => current.map((option) => option.position === position
      ? { ...option, [field]: field === "durationSeconds" ? Number(value) : value }
      : option
    ));
  }

  async function submitChallenges(): Promise<void> {
    if (await onProposeChallenges(options, Number(votingDurationSeconds))) setEditorOpen(false);
  }

  return (
    <>
      <section className="integration-proof" aria-labelledby="battle-title">
        <div>
          <p className="eyebrow">Two-creator battle</p>
          <h2 id="battle-title">Agree on challenges. Let chat choose the rival’s.</h2>
          <p className="lede">Backseat records every phase on the server. Controls only request an allowed transition.</p>
        </div>
        <span className={`mode-label ${battle.mode === "simulated" ? "mode-label--simulated" : ""}`}>
          {battle.mode === "simulated" ? "Simulated mode" : "Real Twitch mode"}
        </span>
      </section>

      <section className="proof-list" aria-label="Battle setup status">
        <div className="proof-row"><strong>Rival seat</strong><span>{hasRival ? "Ready — both creators are present" : "Waiting for the invitation to be accepted"}</span></div>
        <div className="proof-row"><strong>Challenge set</strong><span>{challengeSet ? `Version ${challengeSet.version}${bothApproved ? " approved by both creators" : " awaiting approval"}` : "Host must propose the first version"}</span></div>
        <div className="proof-row"><strong>OBS confirmation</strong><span>{bothOverlaysConfirmed ? "Both creators confirmed their own browser source" : "Each creator must manually confirm their own browser source"}</span></div>
        <div className="proof-row"><strong>Twitch chat feeds</strong><span>{bothChatsConnected ? (battle.mode === "simulated" ? "Both simulated chats are ready" : "Both live chat subscriptions are connected") : "Waiting for both live chat subscriptions"}</span></div>
        <div className="proof-row"><strong>Latest accepted chat command</strong><span>{battle.lastAcceptedVote ? `@${battle.lastAcceptedVote.sourceDisplayName}'s chat → @${battle.lastAcceptedVote.targetDisplayName} · !vote ${battle.lastAcceptedVote.option} · ${formatWhen(battle.lastAcceptedVote.receivedAt)}` : "No accepted command yet."}</span></div>
      </section>

      <section className="challenge-agreement" aria-labelledby="challenge-title">
        <div className="section-heading">
          <div><p className="eyebrow">Challenge agreement</p><h2 id="challenge-title">The approved list is immutable once proposed.</h2></div>
          {canEdit && <button className="button button--secondary" type="button" onClick={() => setEditorOpen((open) => !open)}>{editorOpen ? "Close editor" : challengeSet ? "Edit challenges" : "Set challenges"}</button>}
        </div>

        {editorOpen && canEdit ? (
          <div className="challenge-editor">
            {options.map((option) => (
              <fieldset key={option.position}>
                <legend>!vote {option.position}</legend>
                <label>Challenge<input value={option.title} maxLength={80} onChange={(event) => updateOption(option.position, "title", event.target.value)} /></label>
                <label>Exact instruction<input value={option.instruction} maxLength={180} onChange={(event) => updateOption(option.position, "instruction", event.target.value)} /></label>
                <label>Seconds<input type="number" min="1" max="300" value={option.durationSeconds} onChange={(event) => updateOption(option.position, "durationSeconds", event.target.value)} /></label>
              </fieldset>
            ))}
            <label className="duration-field">Voting window (seconds)<input type="number" min="5" max="120" value={votingDurationSeconds} onChange={(event) => setVotingDurationSeconds(event.target.value)} /></label>
            <button className="button button--primary" type="button" disabled={busy} onClick={() => void submitChallenges()}>Propose this version</button>
          </div>
        ) : challengeSet ? (
          <div className="challenge-list">
            {challengeSet.options.map((option) => <div key={option.id}><strong>{option.position}. {option.title}</strong><span>{option.durationSeconds}s · {option.instruction}</span></div>)}
            <p className="quiet-copy">Voting window: {challengeSet.votingDurationSeconds} seconds.</p>
          </div>
        ) : <Notice tone="warning">Only the host can propose the first three challenges.</Notice>}

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
        <div className="section-heading"><div><p className="eyebrow">Round control</p><h2 id="round-title">{round ? round.phase.replace("-", " ") : "Ready for the first vote"}</h2></div>{round && liveRound && <button className="button button--text" type="button" disabled={busy} onClick={() => void onStopRound(round.id)}>Stop round</button>}</div>
        {!round && battle.role === "host" && <button className="button button--primary" type="button" disabled={busy || !hasRival || !bothApproved || !bothOverlaysConfirmed || !bothChatsConnected} onClick={() => void onOpenVoting()}>Open chat vote</button>}
        {!round && battle.role !== "host" && <p className="quiet-copy">The host opens voting when setup is complete.</p>}
        {round?.phase === "voting" && <p className="lede">Chats are choosing. Voting closes at {formatWhen(round.votingDeadlineAt)}.</p>}
        {round?.phase === "voting" && battle.mode === "simulated" && (
          <div className="demo-controls" aria-label="Simulated chat controls">
            <strong>Simulated chat only</strong>
            <span>Each button replaces one simulated viewer’s vote through the same server vote path. It never reaches Twitch.</span>
            {(["host", "guest"] as const).map((sourceRole) => (
              <div key={sourceRole} className="demo-controls__row">
                <b>@{battle.participants.find((participant) => participant.role === sourceRole)?.displayName ?? sourceRole} chat</b>
                {([1, 2, 3] as const).map((option) => <button key={option} className="button button--secondary" type="button" disabled={busy} onClick={() => void onSimulateVote(sourceRole, option)}>!vote {option}</button>)}
              </div>
            ))}
          </div>
        )}
        {round && ["revealed", "countdown", "active", "complete", "no-votes", "stopped"].includes(round.phase) && (
          <div className="assignment-list">
            {round.assignments.map((assignment) => <div key={assignment.targetUserId}><strong>@{assignment.targetDisplayName}</strong><span>{assignment.title ? `${assignment.title} · ${assignment.durationSeconds}s` : "No restriction selected"}{assignment.clearedAt ? " · Cleared" : ""}</span>{assignment.instruction && <small>{assignment.instruction}</small>}</div>)}
          </div>
        )}
        {round?.phase === "revealed" && !round.readyUserIds.includes(user.id) && <button className="button button--primary" type="button" disabled={busy} onClick={() => void onReady(round.id)}>I’m ready</button>}
        {round?.phase === "revealed" && round.readyUserIds.includes(user.id) && <><p className="quiet-copy">You are ready. The shared countdown commits when your rival is ready too.</p><button className="button button--secondary" type="button" disabled={busy} onClick={() => void onUnready(round.id)}>Unready</button></>}
        {round?.phase === "revealed" && battle.mode === "simulated" && !round.readyUserIds.includes(battle.participants.find((participant) => participant.role === "guest")?.userId ?? "") && <button className="button button--secondary" type="button" disabled={busy} onClick={() => void onSimulateRivalReady(round.id)}>Simulate rival ready</button>}
        {round?.phase === "countdown" && <><p className="lede">Restrictions start together at {round.countdownStartsAt ? formatWhen(round.countdownStartsAt) : "the server’s scheduled time"}.</p><button className="button button--secondary" type="button" disabled={busy} onClick={() => void onCancelStart(round.id)}>Cancel start</button></>}
        {round?.phase === "invalidated" && <Notice tone="warning">Twitch chat disconnected. This round ended and both restrictions were cleared. Reconnecting will not restart it.</Notice>}
        {round && ["complete", "no-votes", "stopped", "invalidated"].includes(round.phase) && battle.role === "host" && <button className="button button--primary" type="button" disabled={busy || !bothApproved || !bothOverlaysConfirmed || !bothChatsConnected} onClick={() => void onOpenVoting()}>Open next vote</button>}
        <button className="button button--text button--danger" type="button" disabled={busy} onClick={() => {
          if (window.confirm("End this battle? This stops any current round, revokes both overlay links, and cannot be undone.")) void onEndBattle();
        }}>End battle</button>
      </section>
    </>
  );
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
      <main className="creator-stage">
        <section className="creator-intro">
          <div>
            <p className="eyebrow">{user.isDemo ? "Simulated demo creator" : "Connected creator"}</p>
            <h1>@{user.displayName}</h1>
            <p>{user.isDemo ? "This isolated demo uses simulated identities and votes. It is not connected to Twitch." : "Backseat is set up for one rival and two distinct Twitch communities."}</p>
          </div>
          <button className="button button--text" type="button" onClick={() => void onSignOut()}>Sign out</button>
        </section>

        <section className="lower-sheet lower-sheet--creator">
          {error && <Notice tone="error">{error}</Notice>}
          {invite && <InviteDecision invite={invite} battle={battle} accepting={isAccepting} onAccept={acceptInvite} />}

          {!battle && !invite && !user.isDemo && (
            <section className="empty-battle" aria-labelledby="create-title">
              <p className="eyebrow">Start the proof</p>
              <h2 id="create-title">Create a battle, then invite one rival.</h2>
              <p>Creating a battle does not open voting or simulate chat. It creates the host seat and a short-lived, single-use invitation.</p>
              <button className="button button--primary" type="button" disabled={isCreating} onClick={() => void createBattle()}>
                {isCreating ? "Creating…" : "Create battle"}
              </button>
            </section>
          )}
          {!battle && !invite && user.isDemo && (
            <section className="empty-battle" aria-labelledby="demo-ended-title">
              <p className="eyebrow">Simulated demo ended</p>
              <h2 id="demo-ended-title">Connect Twitch for a real battle.</h2>
              <p>Demo identities cannot create a real battle or receive Twitch events. Sign out, then connect Twitch when you are ready to test the real integration.</p>
            </section>
          )}

          {battle && (
            <>
              <BattleIdentity battle={battle} user={user} />
              {battle.status === "setup" && battle.role === "host" && (
                <section className="invite-panel" aria-labelledby="invite-panel-title">
                  <p className="eyebrow">Host setup</p>
                  <h2 id="invite-panel-title">Invite your rival.</h2>
                  <p>Only the invited creator can claim this guest seat. If you need a new link, rotating it revokes the previous invitation.</p>
                  {inviteUrl && <CopyControl value={inviteUrl} label="battle-invitation-link" />}
                  <button className="button button--secondary" type="button" disabled={isRotatingInvitation} onClick={() => void rotateInvitation()}>
                    {isRotatingInvitation ? "Creating invitation…" : inviteUrl ? "Rotate invitation link" : "Create fresh invitation link"}
                  </button>
                </section>
              )}
              <BattleControls
                battle={battle}
                user={user}
                overlayUrl={overlayUrl}
                busy={isMutatingBattle || isCreatingOverlay}
                onCreateOverlay={createOverlay}
                onConfirmOverlay={confirmOverlay}
                onProposeChallenges={proposeChallenges}
                onApproveChallenges={approveChallenges}
                onOpenVoting={openVoting}
                onReady={(roundId) => mutateBattle(`/api/battles/current/rounds/${roundId}/ready`)}
                onUnready={(roundId) => mutateBattle(`/api/battles/current/rounds/${roundId}/unready`)}
                onCancelStart={(roundId) => mutateBattle(`/api/battles/current/rounds/${roundId}/cancel-start`)}
                onStopRound={(roundId) => mutateBattle(`/api/battles/current/rounds/${roundId}/stop`)}
                onEndBattle={() => mutateBattle("/api/battles/current/end", { stateVersion: battle.stateVersion })}
                onSimulateVote={(sourceRole, option) => mutateBattle("/api/demo/votes", { sourceRole, option })}
                onSimulateRivalReady={(roundId) => mutateBattle(`/api/demo/rounds/${roundId}/rival-ready`)}
              />
              {isCreatingOverlay && <p className="inline-progress" aria-live="polite">Creating your private overlay link…</p>}
            </>
          )}
        </section>
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
    case "waiting-for-rival": return { heading: "Waiting for rival", detail: "Both creators must connect." };
    case "setup": return snapshot.participants.every((participant) => participant.chatConnected)
      ? { heading: "Setup in progress", detail: "Agree on challenges and confirm your overlays." }
      : { heading: "Waiting for Twitch chat", detail: "Voting stays closed until both chat feeds reconnect." };
    case "ready-for-voting": return { heading: "Ready for chat", detail: "Creators can open the next vote." };
    case "voting": return { heading: "Chats are choosing", detail: "Vote in Twitch chat." };
    case "revealed": return { heading: "Chat has chosen", detail: "Waiting for both creators." };
    case "countdown": return { heading: "Challenges locked", detail: "Restrictions begin together." };
    case "active": return { heading: "Challenges active", detail: "Follow the restrictions below." };
    case "complete": return { heading: "Restrictions ended", detail: "Play normally." };
    case "no-votes": return { heading: "No votes this time", detail: "No restrictions will start." };
    case "stopped": return { heading: "Round stopped", detail: "Restrictions are cleared." };
    case "invalidated": return { heading: "Connection lost", detail: "This round ended. Restrictions are cleared." };
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
              <div><span>@{host?.displayName ?? "Host"}</span><strong>{snapshot.phase === "voting" ? "Chat chooses rival" : "Creator"}</strong></div>
          </div>
            <div className="overlay-state">
              <strong>{phaseCopy?.heading}</strong>
              <span>{phaseCopy?.detail}</span>
              {snapshot.phase === "voting" && snapshot.votingDeadlineAt && <OverlayTimer until={snapshot.votingDeadlineAt} />}
              {snapshot.phase === "countdown" && snapshot.countdownStartsAt && <OverlayTimer until={snapshot.countdownStartsAt} />}
          </div>
          <div className="overlay-creator overlay-creator--guest">
              <div><span>@{guest?.displayName ?? "Rival"}</span><strong>{snapshot.phase === "voting" ? "Chat chooses rival" : "Creator"}</strong></div>
            <CreatorMark name={guest?.displayName ?? "?"} role="guest" />
          </div>
            {snapshot.phase === "voting" && (
              <div className="overlay-commands" aria-label="Twitch voting commands">
                {snapshot.challenges.map((challenge) => <span key={challenge.position}><b>!vote {challenge.position}</b> {challenge.title} · {challenge.durationSeconds}s</span>)}
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
      <PageShell><main className="loading-stage" aria-live="polite"><p>Checking your secure creator session…</p></main></PageShell>
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
      ? "Twitch authorization was cancelled or could not be verified. No creator session was created."
      : initialOAuthResult.current === "failed"
        ? "Twitch authorization failed on the server. Check the server configuration and try again."
        : null);
    return <CreatorLanding invite={invite} oauthMessage={oauthMessage} startingDemo={isStartingDemo} onStartDemo={startDemo} />;
  }

  return <CreatorView user={user} battle={battle} invite={invite} initialOverlayUrl={user.isDemo ? demoOverlayUrl : null} onRefresh={refresh} onSignOut={signOut} />;
}
