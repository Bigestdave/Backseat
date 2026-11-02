import { randomInt, randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { Database } from "../db/client";
import { timestamp } from "../db/timestamp";
import { FixedWindowRateLimiter } from "../security/rate-limit";
import {
  DEFAULT_CHALLENGES,
  assertRoundTransition,
  challengeSetIsApproved,
  resolveVoteTally,
  validateChallengeDrafts,
  voteIsTimely,
  votingDeadline,
  type ChallengeDraft,
  type CreatorRole,
  type RoundPhase,
  type VoteOption
} from "../domain/rounds";
import type { BattleEventBus } from "./event-bus";
import { parseVoteCommand, routeVote, type BattleRoutingContext, type ChatMessage } from "./chat-routing";

type SqlClient = TransactionSql;

type Membership = {
  battleId: string;
  hostUserId: string;
  guestUserId: string | null;
  role: CreatorRole;
  stateVersion: number;
  currentChallengeSetVersionId: string | null;
  currentRoundId: string | null;
};

type VersionRow = { id: string; votingDurationSeconds: number };

type ActiveRound = {
  id: string;
  battleId: string;
  challengeSetVersionId: string;
  phase: RoundPhase;
  stateVersion: number;
  votingDeadlineAt: Date;
  countdownStartsAt: Date | null;
};

type RoutedRound = {
  roundId: string;
  battleId: string;
  challengeSetVersionId: string;
  phase: RoundPhase;
  votingDeadlineAt: Date;
  hostUserId: string;
  hostTwitchId: string;
  hostDisplayName: string;
  guestUserId: string;
  guestTwitchId: string;
  guestDisplayName: string;
};

export type ChallengeSetInput = {
  options: readonly ChallengeDraft[];
  votingDurationSeconds: number;
};

export type ChatVoteResult =
  | { kind: "duplicate" | "ignored" | "late" }
  | { kind: "accepted"; battleId: string; roundId: string; targetUserId: string; option: VoteOption };

function serviceError(message: string, statusCode = 409): Error {
  const error = new Error(message);
  Object.assign(error, { statusCode });
  return error;
}

function expectedVersion(actual: number, requested: number): void {
  if (!Number.isInteger(requested) || requested !== actual) {
    throw serviceError("This battle changed in another tab. Refresh before trying again.", 409);
  }
}

function isNonterminal(phase: RoundPhase): boolean {
  return phase === "voting" || phase === "revealed" || phase === "countdown" || phase === "active";
}

function toChallengeInput(input?: ChallengeSetInput): ChallengeSetInput {
  const candidate = input ?? { options: DEFAULT_CHALLENGES, votingDurationSeconds: 30 };
  try {
    validateChallengeDrafts(candidate.options);
    votingDeadline(new Date(0), candidate.votingDurationSeconds);
  } catch (error) {
    throw serviceError(error instanceof Error ? error.message : "The challenge set is invalid.", 400);
  }
  return candidate;
}

export class BattleService {
  private readonly chatRateLimiter = new FixedWindowRateLimiter();

  constructor(private readonly database: Database, private readonly events: BattleEventBus) {}

  async proposeChallengeSet(battleId: string, userId: string, stateVersion: number, input?: ChallengeSetInput): Promise<{ id: string; stateVersion: number }> {
    const challengeSet = toChallengeInput(input);
    const result = await this.database.client.begin(async (transaction) => {
      const membership = await this.membershipForUpdate(transaction, battleId, userId);
      if (membership.role !== "host") throw serviceError("Only the host can edit the challenge set.", 403);
      expectedVersion(membership.stateVersion, stateVersion);
      await this.assertNoLiveRound(transaction, membership.currentRoundId);

      const [next] = await transaction<{ version: number }[]>`
        SELECT COALESCE(MAX(version), 0) + 1 AS "version"
        FROM challenge_set_versions WHERE battle_id = ${battleId}
      `;
      const now = new Date();
      const versionId = randomUUID();
      await transaction`
        INSERT INTO challenge_set_versions (
          id, battle_id, version, proposed_by_user_id, voting_duration_seconds, created_at
        ) VALUES (
          ${versionId}, ${battleId}, ${next.version}, ${userId}, ${challengeSet.votingDurationSeconds}, ${now}
        )
      `;
      for (const option of challengeSet.options) {
        await transaction`
          INSERT INTO challenge_options (
            id, challenge_set_version_id, position, title, instruction, duration_seconds, created_at
          ) VALUES (
            ${randomUUID()}, ${versionId}, ${option.position}, ${option.title.trim()},
            ${option.instruction.trim()}, ${option.durationSeconds}, ${now}
          )
        `;
      }
      const [updated] = await transaction<{ stateVersion: number }[]>`
        UPDATE battles
        SET current_challenge_set_version_id = ${versionId}, state_version = state_version + 1, updated_at = ${now}
        WHERE id = ${battleId}
        RETURNING state_version AS "stateVersion"
      `;
      return { id: versionId, stateVersion: updated.stateVersion };
    });
    this.events.publish(battleId);
    return result;
  }

  async approveChallengeSet(battleId: string, userId: string, stateVersion: number): Promise<{ stateVersion: number; bothApproved: boolean }> {
    const result = await this.database.client.begin(async (transaction) => {
      const membership = await this.membershipForUpdate(transaction, battleId, userId);
      expectedVersion(membership.stateVersion, stateVersion);
      await this.assertNoLiveRound(transaction, membership.currentRoundId);
      if (!membership.currentChallengeSetVersionId) throw serviceError("The host has not proposed a challenge set yet.");

      const now = new Date();
      const inserted = await transaction<{ userId: string }[]>`
        INSERT INTO challenge_set_approvals (challenge_set_version_id, user_id, approved_at)
        VALUES (${membership.currentChallengeSetVersionId}, ${userId}, ${now})
        ON CONFLICT (challenge_set_version_id, user_id) DO NOTHING
        RETURNING user_id AS "userId"
      `;
      const [approvals] = await transaction<{ hostApproved: boolean; guestApproved: boolean }[]>`
        SELECT
          BOOL_OR(approval.user_id = ${membership.hostUserId}) AS "hostApproved",
          BOOL_OR(approval.user_id = ${membership.guestUserId}) AS "guestApproved"
        FROM challenge_set_approvals approval
        WHERE approval.challenge_set_version_id = ${membership.currentChallengeSetVersionId}
      `;
      const bothApproved = Boolean(approvals?.hostApproved && approvals?.guestApproved);
      const [updated] = await transaction<{ stateVersion: number }[]>`
        UPDATE battles
        SET state_version = state_version + ${inserted.length ? 1 : 0}, updated_at = ${now}
        WHERE id = ${battleId}
        RETURNING state_version AS "stateVersion"
      `;
      return { stateVersion: updated.stateVersion, bothApproved };
    });
    this.events.publish(battleId);
    return result;
  }

  async confirmOverlay(battleId: string, userId: string, stateVersion: number): Promise<{ stateVersion: number }> {
    const result = await this.database.client.begin(async (transaction) => {
      const membership = await this.membershipForUpdate(transaction, battleId, userId);
      expectedVersion(membership.stateVersion, stateVersion);
      await this.assertNoLiveRound(transaction, membership.currentRoundId);
      const now = new Date();
      const [overlayCredential] = await transaction<{ id: string }[]>`
        SELECT id
        FROM overlay_credentials
        WHERE battle_id = ${battleId}
          AND owner_user_id = ${userId}
          AND revoked_at IS NULL
          AND expires_at > ${now}
        FOR UPDATE
      `;
      if (!overlayCredential) {
        throw serviceError("Create your private overlay link before confirming its OBS browser source.");
      }
      const changed = await transaction<{ userId: string }[]>`
        UPDATE battle_members
        SET overlay_confirmed_at = COALESCE(overlay_confirmed_at, ${now})
        WHERE battle_id = ${battleId} AND user_id = ${userId} AND overlay_confirmed_at IS NULL
        RETURNING user_id AS "userId"
      `;
      const [updated] = await transaction<{ stateVersion: number }[]>`
        UPDATE battles
        SET state_version = state_version + ${changed.length ? 1 : 0}, updated_at = ${now}
        WHERE id = ${battleId}
        RETURNING state_version AS "stateVersion"
      `;
      return { stateVersion: updated.stateVersion };
    });
    this.events.publish(battleId);
    return result;
  }

  async openVoting(battleId: string, userId: string, stateVersion: number): Promise<{ roundId: string; deadline: Date; stateVersion: number }> {
    const result = await this.database.client.begin(async (transaction) => {
      const membership = await this.membershipForUpdate(transaction, battleId, userId);
      if (membership.role !== "host") throw serviceError("Only the host can open voting.", 403);
      expectedVersion(membership.stateVersion, stateVersion);
      if (!membership.guestUserId) throw serviceError("A rival must join before voting can open.");
      if (!membership.currentChallengeSetVersionId) throw serviceError("Approve a challenge set before opening voting.");
      await this.assertNoLiveRound(transaction, membership.currentRoundId);

      const version = await this.currentVersionForUpdate(transaction, membership.currentChallengeSetVersionId);
      const approvals = await this.approvalRoles(transaction, membership.currentChallengeSetVersionId, membership);
      if (!challengeSetIsApproved(approvals)) throw serviceError("Both creators must approve this exact challenge set.");
      const [overlayStatus] = await transaction<{ confirmed: number }[]>`
        SELECT COUNT(*)::int AS "confirmed"
        FROM battle_members
        WHERE battle_id = ${battleId} AND overlay_confirmed_at IS NOT NULL
      `;
      if (overlayStatus.confirmed !== 2) throw serviceError("Both creators must confirm their own OBS overlay first.");

      const [chatStatus] = await transaction<{ connected: number }[]>`
        SELECT COUNT(*)::int AS "connected"
        FROM battle_members
        WHERE battle_id = ${battleId} AND chat_connected_at IS NOT NULL
      `;
      if (chatStatus.connected !== 2) throw serviceError("Both Twitch chat feeds must be connected before voting can open.");

      const [sequence] = await transaction<{ sequence: number }[]>`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS "sequence" FROM rounds WHERE battle_id = ${battleId}
      `;
      const now = new Date();
      const deadline = votingDeadline(now, version.votingDurationSeconds);
      const roundId = randomUUID();
      await transaction`
        INSERT INTO rounds (
          id, battle_id, challenge_set_version_id, sequence, phase, state_version,
          voting_opens_at, voting_deadline_at, created_at, updated_at
        ) VALUES (
          ${roundId}, ${battleId}, ${membership.currentChallengeSetVersionId}, ${sequence.sequence}, 'voting', 0,
          ${now}, ${deadline}, ${now}, ${now}
        )
      `;
      const [updated] = await transaction<{ stateVersion: number }[]>`
        UPDATE battles
        SET current_round_id = ${roundId}, state_version = state_version + 1, updated_at = ${now}
        WHERE id = ${battleId}
        RETURNING state_version AS "stateVersion"
      `;
      return { roundId, deadline, stateVersion: updated.stateVersion };
    });
    this.events.publish(battleId);
    return result;
  }

  async ingestChatVote(message: ChatMessage): Promise<ChatVoteResult> {
    if (!parseVoteCommand(message.text)) return { kind: "ignored" };
    // Do this before starting a database transaction so a single chatter cannot
    // make the durable vote path do unbounded work. A source limit protects
    // against a burst of otherwise unique viewer identities as well.
    if (!this.chatRateLimiter.allow(`viewer:${message.viewerTwitchId}`, 8, 10_000)
      || !this.chatRateLimiter.allow(`channel:${message.sourceChannelTwitchId}`, 120, 10_000)) {
      return { kind: "ignored" };
    }
    const result = await this.database.client.begin(async (transaction) => {
      const deliveries = await transaction<{ deliveryId: string }[]>`
        INSERT INTO processed_twitch_events (delivery_id, received_at)
        VALUES (${message.deliveryId}, ${message.receivedAt})
        ON CONFLICT (delivery_id) DO NOTHING
        RETURNING delivery_id AS "deliveryId"
      `;
      if (deliveries.length === 0) return { kind: "duplicate" } as const;

      const [round] = await transaction<RoutedRound[]>`
        SELECT
          round.id AS "roundId", round.battle_id AS "battleId",
          round.challenge_set_version_id AS "challengeSetVersionId", round.phase,
          round.voting_deadline_at AS "votingDeadlineAt",
          host.id AS "hostUserId", host.twitch_id AS "hostTwitchId", host.display_name AS "hostDisplayName",
          guest.id AS "guestUserId", guest.twitch_id AS "guestTwitchId", guest.display_name AS "guestDisplayName"
        FROM active_battle_members source_membership
        JOIN users source ON source.id = source_membership.user_id
        JOIN battles battle ON battle.id = source_membership.battle_id
        JOIN rounds round ON round.id = battle.current_round_id
        JOIN users host ON host.id = battle.host_user_id
        JOIN users guest ON guest.id = battle.guest_user_id
        WHERE source.twitch_id = ${message.sourceChannelTwitchId}
          AND round.phase = 'voting'
        FOR UPDATE OF round
      `;
      if (!round) return { kind: "ignored" } as const;
      if (!voteIsTimely(message.receivedAt, round.votingDeadlineAt)) return { kind: "late" } as const;

      const routing: BattleRoutingContext = {
        battleId: round.battleId,
        host: { userId: round.hostUserId, twitchId: round.hostTwitchId, displayName: round.hostDisplayName },
        guest: { userId: round.guestUserId, twitchId: round.guestTwitchId, displayName: round.guestDisplayName }
      };
      const vote = routeVote(message, routing);
      if (!vote) return { kind: "ignored" } as const;

      const insertedLock = await transaction<{ sourceChannelTwitchId: string }[]>`
        INSERT INTO battle_team_locks (
          battle_id, viewer_twitch_id, source_channel_twitch_id, target_user_id, locked_at
        ) VALUES (
          ${vote.battleId}, ${message.viewerTwitchId}, ${message.sourceChannelTwitchId}, ${vote.targetUserId}, ${message.receivedAt}
        ) ON CONFLICT (battle_id, viewer_twitch_id) DO NOTHING
        RETURNING source_channel_twitch_id AS "sourceChannelTwitchId"
      `;
      if (insertedLock.length === 0) {
        const [lock] = await transaction<{ sourceChannelTwitchId: string }[]>`
          SELECT source_channel_twitch_id AS "sourceChannelTwitchId"
          FROM battle_team_locks
          WHERE battle_id = ${vote.battleId} AND viewer_twitch_id = ${message.viewerTwitchId}
          FOR UPDATE
        `;
        if (!lock || lock.sourceChannelTwitchId !== message.sourceChannelTwitchId) return { kind: "ignored" } as const;
      }

      // Persist a command receipt only after it has passed team-lock validation.
      // This preserves a useful audit trail without recording rejected cross-team
      // attempts as accepted commands.
      const receipt = await transaction<{ messageId: string }[]>`
        INSERT INTO chat_commands (
          message_id, battle_id, source_channel_twitch_id, viewer_twitch_id, target_user_id, option, received_at
        ) VALUES (
          ${message.messageId}, ${vote.battleId}, ${message.sourceChannelTwitchId}, ${message.viewerTwitchId},
          ${vote.targetUserId}, ${String(vote.option)}, ${message.receivedAt}
        ) ON CONFLICT (message_id) DO NOTHING
        RETURNING message_id AS "messageId"
      `;
      if (receipt.length === 0) return { kind: "duplicate" } as const;

      await transaction`
        INSERT INTO round_votes (
          round_id, viewer_twitch_id, source_channel_twitch_id, target_user_id,
          option_position, message_id, received_at, updated_at
        ) VALUES (
          ${round.roundId}, ${message.viewerTwitchId}, ${message.sourceChannelTwitchId}, ${vote.targetUserId},
          ${vote.option}, ${message.messageId}, ${message.receivedAt}, ${message.receivedAt}
        ) ON CONFLICT (round_id, viewer_twitch_id) DO UPDATE SET
          source_channel_twitch_id = EXCLUDED.source_channel_twitch_id,
          target_user_id = EXCLUDED.target_user_id,
          option_position = EXCLUDED.option_position,
          message_id = EXCLUDED.message_id,
          received_at = EXCLUDED.received_at,
          updated_at = EXCLUDED.updated_at
      `;
      return {
        kind: "accepted",
        battleId: vote.battleId,
        roundId: round.roundId,
        targetUserId: vote.targetUserId,
        option: vote.option
      } as const;
    });
    if (result.kind === "accepted") this.events.publish(result.battleId);
    return result;
  }

  async setRoundReady(battleId: string, userId: string, roundId: string): Promise<{ phase: RoundPhase; startsAt: Date | null }> {
    const result = await this.database.client.begin(async (transaction) => {
      const membership = await this.membershipForUpdate(transaction, battleId, userId);
      if (membership.currentRoundId !== roundId) throw serviceError("That round is no longer current.", 409);
      const round = await this.roundForUpdate(transaction, roundId);
      if (round.phase !== "revealed") throw serviceError("Creators can only ready a revealed round.");

      const now = new Date();
      await transaction`
        INSERT INTO round_readiness (round_id, user_id, ready_at)
        VALUES (${roundId}, ${userId}, ${now})
        ON CONFLICT (round_id, user_id) DO NOTHING
      `;
      const [ready] = await transaction<{ count: number }[]>`
        SELECT COUNT(*)::int AS "count" FROM round_readiness WHERE round_id = ${roundId}
      `;
      if (ready.count < 2) return { phase: "revealed" as const, startsAt: null };

      assertRoundTransition(round.phase, "countdown");
      const startsAt = new Date(now.getTime() + 3_000);
      await transaction`
        UPDATE rounds
        SET phase = 'countdown', countdown_starts_at = ${startsAt}, state_version = state_version + 1, updated_at = ${now}
        WHERE id = ${roundId} AND phase = 'revealed'
      `;
      await this.bumpBattleState(transaction, battleId, now);
      return { phase: "countdown" as const, startsAt };
    });
    this.events.publish(battleId);
    return result;
  }

  async unsetRoundReady(battleId: string, userId: string, roundId: string): Promise<void> {
    const changed = await this.database.client.begin(async (transaction) => {
      const membership = await this.membershipForUpdate(transaction, battleId, userId);
      if (membership.currentRoundId !== roundId) throw serviceError("That round is no longer current.", 409);
      const round = await this.roundForUpdate(transaction, roundId);
      if (round.phase !== "revealed") throw serviceError("Readiness can only be withdrawn before the shared countdown commits.");
      const removed = await transaction<{ userId: string }[]>`
        DELETE FROM round_readiness WHERE round_id = ${roundId} AND user_id = ${userId}
        RETURNING user_id AS "userId"
      `;
      if (removed.length > 0) await this.bumpBattleState(transaction, battleId, new Date());
      return removed.length > 0;
    });
    if (changed) this.events.publish(battleId);
  }

  async cancelCountdown(battleId: string, userId: string, roundId: string): Promise<void> {
    await this.database.client.begin(async (transaction) => {
      const membership = await this.membershipForUpdate(transaction, battleId, userId);
      if (membership.currentRoundId !== roundId) throw serviceError("That round is no longer current.", 409);
      const round = await this.roundForUpdate(transaction, roundId);
      if (round.phase !== "countdown") throw serviceError("There is no committed countdown to cancel.");
      const now = new Date();
      await transaction`DELETE FROM round_readiness WHERE round_id = ${roundId}`;
      await transaction`
        UPDATE rounds
        SET phase = 'revealed', countdown_starts_at = NULL, state_version = state_version + 1, updated_at = ${now}
        WHERE id = ${roundId} AND phase = 'countdown'
      `;
      await this.bumpBattleState(transaction, battleId, now);
    });
    this.events.publish(battleId);
  }

  async stopRound(battleId: string, userId: string, roundId: string): Promise<void> {
    await this.database.client.begin(async (transaction) => {
      const membership = await this.membershipForUpdate(transaction, battleId, userId);
      if (membership.currentRoundId !== roundId) throw serviceError("That round is no longer current.", 409);
      const round = await this.roundForUpdate(transaction, roundId);
      if (!isNonterminal(round.phase)) return;
      assertRoundTransition(round.phase, "stopped");
      const now = new Date();
      await transaction`
        UPDATE rounds
        SET phase = 'stopped', completed_at = ${now}, terminal_reason = 'creator-stop',
          state_version = state_version + 1, updated_at = ${now}
        WHERE id = ${roundId}
      `;
      await transaction`
        UPDATE round_assignments SET cleared_at = COALESCE(cleared_at, ${now})
        WHERE round_id = ${roundId}
      `;
      await this.bumpBattleState(transaction, battleId, now);
    });
    this.events.publish(battleId);
  }

  async endBattle(battleId: string, userId: string, stateVersion: number): Promise<void> {
    await this.database.client.begin(async (transaction) => {
      const membership = await this.membershipForUpdate(transaction, battleId, userId);
      expectedVersion(membership.stateVersion, stateVersion);
      const now = new Date();
      if (membership.currentRoundId) {
        const round = await this.roundForUpdate(transaction, membership.currentRoundId);
        if (isNonterminal(round.phase)) {
          await transaction`
            UPDATE rounds
            SET phase = 'stopped', completed_at = ${now}, terminal_reason = 'battle-ended',
              state_version = state_version + 1, updated_at = ${now}
            WHERE id = ${round.id}
          `;
          await transaction`
            UPDATE round_assignments SET cleared_at = COALESCE(cleared_at, ${now})
            WHERE round_id = ${round.id}
          `;
        }
      }
      await transaction`
        UPDATE battle_invitations SET revoked_at = COALESCE(revoked_at, ${now})
        WHERE battle_id = ${battleId} AND consumed_at IS NULL
      `;
      await transaction`
        UPDATE overlay_credentials SET revoked_at = COALESCE(revoked_at, ${now})
        WHERE battle_id = ${battleId} AND revoked_at IS NULL
      `;
      await transaction`
        UPDATE battles
        SET status = 'ended', state_version = state_version + 1, updated_at = ${now}
        WHERE id = ${battleId}
      `;
      await transaction`DELETE FROM active_battle_members WHERE battle_id = ${battleId}`;
    });
    this.events.publish(battleId);
  }

  async setChatConnection(userId: string, connected: boolean): Promise<void> {
    const battleId = await this.database.client.begin(async (transaction) => {
      const [membership] = await transaction<{
        battleId: string;
        currentRoundId: string | null;
        connectedAt: Date | null;
      }[]>`
        SELECT battle.id AS "battleId", battle.current_round_id AS "currentRoundId",
          member.chat_connected_at AS "connectedAt"
        FROM active_battle_members active_member
        JOIN battles battle ON battle.id = active_member.battle_id
        JOIN battle_members member ON member.battle_id = battle.id AND member.user_id = active_member.user_id
        WHERE active_member.user_id = ${userId} AND battle.mode = 'real' AND battle.status <> 'ended'
        FOR UPDATE OF battle, member
      `;
      if (!membership || Boolean(membership.connectedAt) === connected) return null;

      const now = new Date();
      await transaction`
        UPDATE battle_members SET chat_connected_at = ${connected ? now : null}
        WHERE battle_id = ${membership.battleId} AND user_id = ${userId}
      `;
      if (!connected && membership.currentRoundId) {
        const round = await this.roundForUpdate(transaction, membership.currentRoundId);
        if (isNonterminal(round.phase)) {
          assertRoundTransition(round.phase, "invalidated");
          await transaction`
            UPDATE rounds
            SET phase = 'invalidated', completed_at = ${now}, terminal_reason = 'chat-disconnected',
              state_version = state_version + 1, updated_at = ${now}
            WHERE id = ${round.id}
          `;
          await transaction`
            UPDATE round_assignments SET cleared_at = COALESCE(cleared_at, ${now})
            WHERE round_id = ${round.id}
          `;
          await transaction`DELETE FROM round_readiness WHERE round_id = ${round.id}`;
        }
      }
      await this.bumpBattleState(transaction, membership.battleId, now);
      return membership.battleId;
    });
    if (battleId) this.events.publish(battleId);
  }

  async resetChatConnections(): Promise<void> {
    const connected = await this.database.client<{ userId: string }[]>`
      SELECT DISTINCT member.user_id AS "userId"
      FROM battle_members member
      JOIN battles battle ON battle.id = member.battle_id
      JOIN active_battle_members active_member ON active_member.user_id = member.user_id
        AND active_member.battle_id = member.battle_id
      WHERE battle.mode = 'real' AND member.chat_connected_at IS NOT NULL
    `;
    for (const member of connected) await this.setChatConnection(member.userId, false);
  }

  async advanceDueRounds(now = new Date()): Promise<number> {
    const due = await this.database.client<{ id: string; battleId: string }[]>`
      SELECT id, battle_id AS "battleId"
      FROM rounds
      WHERE (phase = 'voting' AND voting_deadline_at <= ${timestamp(this.database.client, now)})
        OR (phase = 'countdown' AND countdown_starts_at <= ${timestamp(this.database.client, now)})
        OR phase = 'active'
      ORDER BY updated_at ASC
      LIMIT 100
    `;

    let advanced = 0;
    for (const round of due) {
      if (await this.advanceRound(round.id, round.battleId, now)) advanced += 1;
    }
    return advanced;
  }

  private async advanceRound(roundId: string, battleId: string, now: Date): Promise<boolean> {
    const changed = await this.database.client.begin(async (transaction) => {
      const [battle] = await transaction<{ id: string }[]>`
        SELECT id FROM battles WHERE id = ${battleId} FOR UPDATE
      `;
      if (!battle) return false;
      const round = await this.roundForUpdate(transaction, roundId);
      if (round.battleId !== battleId) return false;
      if (round.phase === "voting") {
        if (now.getTime() < round.votingDeadlineAt.getTime()) return false;
        await this.finalizeVoting(transaction, round, now);
        return true;
      }
      if (round.phase === "countdown") {
        if (!round.countdownStartsAt || now.getTime() < round.countdownStartsAt.getTime()) return false;
        await this.activateRound(transaction, round, now);
        return true;
      }
      if (round.phase === "active") {
        return this.expireAssignments(transaction, round, now);
      }
      return false;
    });
    if (changed) this.events.publish(battleId);
    return changed;
  }

  private async finalizeVoting(sql: SqlClient, round: ActiveRound, now: Date): Promise<void> {
    assertRoundTransition(round.phase, "revealed");
    const [battle] = await sql<{ hostUserId: string; guestUserId: string }[]>`
      SELECT host_user_id AS "hostUserId", guest_user_id AS "guestUserId"
      FROM battles WHERE id = ${round.battleId} FOR UPDATE
    `;
    if (!battle?.guestUserId) throw serviceError("A round cannot finalize without two creators.");
    const votes = await sql<{ targetUserId: string; option: VoteOption; count: number }[]>`
      SELECT target_user_id AS "targetUserId", option_position AS option, COUNT(*)::int AS "count"
      FROM round_votes WHERE round_id = ${round.id}
      GROUP BY target_user_id, option_position
    `;
    const options = await sql<{ id: string; position: VoteOption; durationSeconds: number }[]>`
      SELECT id, position, duration_seconds AS "durationSeconds"
      FROM challenge_options WHERE challenge_set_version_id = ${round.challengeSetVersionId}
    `;
    const optionByPosition = new Map(options.map((option) => [option.position, option]));
    const targets = [battle.hostUserId, battle.guestUserId];
    let hasSelection = false;

    for (const targetUserId of targets) {
      const tally = { 1: 0, 2: 0, 3: 0 } as Record<VoteOption, number>;
      for (const vote of votes) if (vote.targetUserId === targetUserId) tally[vote.option] += vote.count;
      const resolution = resolveVoteTally(tally, (maximum) => randomInt(maximum));
      if (resolution.kind === "no-votes") {
        await sql`
          INSERT INTO round_assignments (round_id, target_user_id, challenge_option_id, resolution, resolved_at)
          VALUES (${round.id}, ${targetUserId}, NULL, 'no-votes', ${now})
        `;
        continue;
      }
      const option = optionByPosition.get(resolution.option);
      if (!option) throw serviceError("The round's challenge set is incomplete.");
      hasSelection = true;
      await sql`
        INSERT INTO round_assignments (round_id, target_user_id, challenge_option_id, resolution, resolved_at)
        VALUES (
          ${round.id}, ${targetUserId}, ${option.id},
          ${resolution.tiedOptions.length > 1 ? "tie-break" : "winner"}, ${now}
        )
      `;
    }

    const nextPhase: RoundPhase = hasSelection ? "revealed" : "no-votes";
    await sql`
      UPDATE rounds
      SET phase = ${nextPhase}, revealed_at = ${now}, completed_at = ${hasSelection ? null : now},
        terminal_reason = ${hasSelection ? null : "no-votes"}, state_version = state_version + 1, updated_at = ${now}
      WHERE id = ${round.id} AND phase = 'voting'
    `;
    await this.bumpBattleState(sql, round.battleId, now);
  }

  private async activateRound(sql: SqlClient, round: ActiveRound, now: Date): Promise<void> {
    assertRoundTransition(round.phase, "active");
    if (!round.countdownStartsAt) throw serviceError("A countdown requires a committed start time.");
    const assignments = await sql<{ assignmentId: string; durationSeconds: number }[]>`
      SELECT assignment.target_user_id AS "assignmentId", option.duration_seconds AS "durationSeconds"
      FROM round_assignments assignment
      JOIN challenge_options option ON option.id = assignment.challenge_option_id
      WHERE assignment.round_id = ${round.id} AND assignment.challenge_option_id IS NOT NULL
    `;
    for (const assignment of assignments) {
      const endsAt = new Date(round.countdownStartsAt.getTime() + assignment.durationSeconds * 1_000);
      await sql`
        UPDATE round_assignments SET starts_at = ${round.countdownStartsAt}, ends_at = ${endsAt}
        WHERE round_id = ${round.id} AND target_user_id = ${assignment.assignmentId}
      `;
    }
    await sql`
      UPDATE rounds
      SET phase = 'active', active_at = ${round.countdownStartsAt}, state_version = state_version + 1, updated_at = ${now}
      WHERE id = ${round.id} AND phase = 'countdown'
    `;
    await this.bumpBattleState(sql, round.battleId, now);
  }

  private async expireAssignments(sql: SqlClient, round: ActiveRound, now: Date): Promise<boolean> {
    const cleared = await sql<{ targetUserId: string }[]>`
      UPDATE round_assignments
      SET cleared_at = ${now}
      WHERE round_id = ${round.id}
        AND ends_at IS NOT NULL
        AND ends_at <= ${now}
        AND cleared_at IS NULL
      RETURNING target_user_id AS "targetUserId"
    `;
    const [remaining] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS "count"
      FROM round_assignments
      WHERE round_id = ${round.id} AND ends_at IS NOT NULL AND cleared_at IS NULL
    `;
    if (remaining.count > 0) return cleared.length > 0;
    assertRoundTransition(round.phase, "complete");
    await sql`
      UPDATE rounds
      SET phase = 'complete', completed_at = ${now}, state_version = state_version + 1, updated_at = ${now}
      WHERE id = ${round.id} AND phase = 'active'
    `;
    await this.bumpBattleState(sql, round.battleId, now);
    return true;
  }

  private async membershipForUpdate(sql: SqlClient, battleId: string, userId: string): Promise<Membership> {
    const [membership] = await sql<Membership[]>`
      SELECT battle.id AS "battleId", battle.host_user_id AS "hostUserId", battle.guest_user_id AS "guestUserId",
        CASE WHEN battle.host_user_id = ${userId} THEN 'host' ELSE 'guest' END AS role,
        battle.state_version AS "stateVersion",
        battle.current_challenge_set_version_id AS "currentChallengeSetVersionId",
        battle.current_round_id AS "currentRoundId"
      FROM battles battle
      JOIN battle_members member ON member.battle_id = battle.id AND member.user_id = ${userId}
      WHERE battle.id = ${battleId} AND battle.status <> 'ended'
      FOR UPDATE OF battle
    `;
    if (!membership || (membership.role === "guest" && !membership.guestUserId)) {
      throw serviceError("You do not have access to this battle.", 403);
    }
    return membership;
  }

  private async roundForUpdate(sql: SqlClient, roundId: string): Promise<ActiveRound> {
    const [round] = await sql<ActiveRound[]>`
      SELECT id, battle_id AS "battleId", challenge_set_version_id AS "challengeSetVersionId",
        phase, state_version AS "stateVersion", voting_deadline_at AS "votingDeadlineAt",
        countdown_starts_at AS "countdownStartsAt"
      FROM rounds WHERE id = ${roundId}
      FOR UPDATE
    `;
    if (!round) throw serviceError("That round is unavailable.", 404);
    return round;
  }

  private async bumpBattleState(sql: SqlClient, battleId: string, now: Date): Promise<void> {
    await sql`
      UPDATE battles
      SET state_version = state_version + 1, updated_at = ${now}
      WHERE id = ${battleId}
    `;
  }

  private async assertNoLiveRound(sql: SqlClient, roundId: string | null): Promise<void> {
    if (!roundId) return;
    const [round] = await sql<{ phase: RoundPhase }[]>`
      SELECT phase FROM rounds WHERE id = ${roundId} FOR UPDATE
    `;
    if (round && isNonterminal(round.phase)) {
      throw serviceError("The challenge set cannot change during a live round.");
    }
  }

  private async currentVersionForUpdate(sql: SqlClient, versionId: string): Promise<VersionRow> {
    const [version] = await sql<VersionRow[]>`
      SELECT id, voting_duration_seconds AS "votingDurationSeconds"
      FROM challenge_set_versions WHERE id = ${versionId} FOR UPDATE
    `;
    if (!version) throw serviceError("The current challenge set is unavailable.");
    return version;
  }

  private async approvalRoles(sql: SqlClient, versionId: string, membership: Membership): Promise<Set<CreatorRole>> {
    const rows = await sql<{ userId: string }[]>`
      SELECT user_id AS "userId" FROM challenge_set_approvals WHERE challenge_set_version_id = ${versionId}
    `;
    const roles = new Set<CreatorRole>();
    for (const approval of rows) {
      if (approval.userId === membership.hostUserId) roles.add("host");
      if (approval.userId === membership.guestUserId) roles.add("guest");
    }
    return roles;
  }
}
