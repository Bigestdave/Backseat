import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  twitchId: text("twitch_id").notNull().unique(),
  login: text("login").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const oauthGrants = pgTable("oauth_grants", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  accessTokenCiphertext: text("access_token_ciphertext").notNull(),
  refreshTokenCiphertext: text("refresh_token_ciphertext").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  validatedAt: timestamp("validated_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const battles = pgTable("battles", {
  id: uuid("id").primaryKey(),
  hostUserId: uuid("host_user_id").notNull().references(() => users.id),
  guestUserId: uuid("guest_user_id").references(() => users.id),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  currentChallengeSetVersionId: uuid("current_challenge_set_version_id"),
  currentRoundId: uuid("current_round_id"),
  stateVersion: integer("state_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const battleMembers = pgTable("battle_members", {
  battleId: uuid("battle_id").notNull().references(() => battles.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  overlayConfirmedAt: timestamp("overlay_confirmed_at", { withTimezone: true }),
  chatConnectedAt: timestamp("chat_connected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
}, (table) => [primaryKey({ columns: [table.battleId, table.userId] })]);

export const challengeSetVersions = pgTable("challenge_set_versions", {
  id: uuid("id").primaryKey(),
  battleId: uuid("battle_id").notNull().references(() => battles.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  proposedByUserId: uuid("proposed_by_user_id").notNull().references(() => users.id),
  votingDurationSeconds: integer("voting_duration_seconds").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
}, (table) => [uniqueIndex("challenge_set_versions_battle_version").on(table.battleId, table.version)]);

export const challengeOptions = pgTable("challenge_options", {
  id: uuid("id").primaryKey(),
  challengeSetVersionId: uuid("challenge_set_version_id").notNull().references(() => challengeSetVersions.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  title: text("title").notNull(),
  instruction: text("instruction").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  addedByUserId: uuid("added_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
}, (table) => [uniqueIndex("challenge_options_version_position").on(table.challengeSetVersionId, table.position)]);

export const challengeSetApprovals = pgTable("challenge_set_approvals", {
  challengeSetVersionId: uuid("challenge_set_version_id").notNull().references(() => challengeSetVersions.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull()
}, (table) => [primaryKey({ columns: [table.challengeSetVersionId, table.userId] })]);

export const rounds = pgTable("rounds", {
  id: uuid("id").primaryKey(),
  battleId: uuid("battle_id").notNull().references(() => battles.id, { onDelete: "cascade" }),
  challengeSetVersionId: uuid("challenge_set_version_id").notNull().references(() => challengeSetVersions.id),
  sequence: integer("sequence").notNull(),
  phase: text("phase").notNull(),
  stateVersion: integer("state_version").notNull(),
  votingOpensAt: timestamp("voting_opens_at", { withTimezone: true }).notNull(),
  votingDeadlineAt: timestamp("voting_deadline_at", { withTimezone: true }).notNull(),
  revealedAt: timestamp("revealed_at", { withTimezone: true }),
  countdownStartsAt: timestamp("countdown_starts_at", { withTimezone: true }),
  activeAt: timestamp("active_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  terminalReason: text("terminal_reason"),
  stoppedByUserId: uuid("stopped_by_user_id").references(() => users.id),
  outcome: text("outcome"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
}, (table) => [uniqueIndex("rounds_battle_sequence").on(table.battleId, table.sequence)]);

export const roundReadiness = pgTable("round_readiness", {
  roundId: uuid("round_id").notNull().references(() => rounds.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  readyAt: timestamp("ready_at", { withTimezone: true }).notNull()
}, (table) => [primaryKey({ columns: [table.roundId, table.userId] })]);

export const battleTeamLocks = pgTable("battle_team_locks", {
  battleId: uuid("battle_id").notNull().references(() => battles.id, { onDelete: "cascade" }),
  viewerTwitchId: text("viewer_twitch_id").notNull(),
  sourceChannelTwitchId: text("source_channel_twitch_id").notNull(),
  targetUserId: uuid("target_user_id").notNull().references(() => users.id),
  lockedAt: timestamp("locked_at", { withTimezone: true }).notNull()
}, (table) => [primaryKey({ columns: [table.battleId, table.viewerTwitchId] })]);

export const roundVotes = pgTable("round_votes", {
  roundId: uuid("round_id").notNull().references(() => rounds.id, { onDelete: "cascade" }),
  viewerTwitchId: text("viewer_twitch_id").notNull(),
  sourceChannelTwitchId: text("source_channel_twitch_id").notNull(),
  targetUserId: uuid("target_user_id").notNull().references(() => users.id),
  optionPosition: integer("option_position").notNull(),
  messageId: text("message_id").notNull().unique(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
}, (table) => [primaryKey({ columns: [table.roundId, table.viewerTwitchId] })]);

export const roundAssignments = pgTable("round_assignments", {
  roundId: uuid("round_id").notNull().references(() => rounds.id, { onDelete: "cascade" }),
  targetUserId: uuid("target_user_id").notNull().references(() => users.id),
  challengeOptionId: uuid("challenge_option_id").references(() => challengeOptions.id),
  resolution: text("resolution").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  clearedAt: timestamp("cleared_at", { withTimezone: true })
}, (table) => [primaryKey({ columns: [table.roundId, table.targetUserId] })]);

// PostgreSQL cannot enforce "one open battle" through a partial index that
// joins `battles`, so the active membership itself is the unique lock.
// A terminal transition must delete these rows in the same transaction.
export const activeBattleMembers = pgTable("active_battle_members", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  battleId: uuid("battle_id").notNull().references(() => battles.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
}, (table) => [uniqueIndex("active_battle_members_battle_user").on(table.battleId, table.userId)]);

export const battleInvitations = pgTable("battle_invitations", {
  id: uuid("id").primaryKey(),
  battleId: uuid("battle_id").notNull().references(() => battles.id, { onDelete: "cascade" }),
  secretHash: text("secret_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consumedByUserId: uuid("consumed_by_user_id").references(() => users.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const processedTwitchEvents = pgTable("processed_twitch_events", {
  deliveryId: text("delivery_id").primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull()
});

export const chatCommands = pgTable("chat_commands", {
  messageId: text("message_id").primaryKey(),
  battleId: uuid("battle_id").notNull().references(() => battles.id, { onDelete: "cascade" }),
  sourceChannelTwitchId: text("source_channel_twitch_id").notNull(),
  viewerTwitchId: text("viewer_twitch_id").notNull(),
  targetUserId: uuid("target_user_id").notNull().references(() => users.id),
  option: text("option").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull()
}, (table) => [uniqueIndex("chat_commands_battle_message_unique").on(table.battleId, table.messageId)]);

export const overlayCredentials = pgTable("overlay_credentials", {
  id: uuid("id").primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  battleId: uuid("battle_id").notNull().references(() => battles.id, { onDelete: "cascade" }),
  secretHash: text("secret_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

