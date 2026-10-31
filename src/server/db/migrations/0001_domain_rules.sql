-- Milestone 1: immutable challenge sets and authoritative round state.
-- All timer values are server timestamps; no browser clock is authoritative.
ALTER TABLE battles
  ADD COLUMN IF NOT EXISTS current_challenge_set_version_id UUID,
  ADD COLUMN IF NOT EXISTS current_round_id UUID,
  ADD COLUMN IF NOT EXISTS state_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE battle_members
  ADD COLUMN IF NOT EXISTS overlay_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS chat_connected_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS challenge_set_versions (
  id UUID PRIMARY KEY,
  battle_id UUID NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  proposed_by_user_id UUID NOT NULL REFERENCES users(id),
  voting_duration_seconds INTEGER NOT NULL CHECK (voting_duration_seconds BETWEEN 5 AND 120),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (battle_id, version)
);

CREATE TABLE IF NOT EXISTS challenge_options (
  id UUID PRIMARY KEY,
  challenge_set_version_id UUID NOT NULL REFERENCES challenge_set_versions(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 3),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  instruction TEXT NOT NULL CHECK (length(trim(instruction)) > 0),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 1 AND 300),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (challenge_set_version_id, position)
);

CREATE TABLE IF NOT EXISTS challenge_set_approvals (
  challenge_set_version_id UUID NOT NULL REFERENCES challenge_set_versions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (challenge_set_version_id, user_id)
);

CREATE TABLE IF NOT EXISTS rounds (
  id UUID PRIMARY KEY,
  battle_id UUID NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  challenge_set_version_id UUID NOT NULL REFERENCES challenge_set_versions(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  phase TEXT NOT NULL CHECK (phase IN ('voting', 'revealed', 'countdown', 'active', 'complete', 'no-votes', 'stopped', 'invalidated')),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  voting_opens_at TIMESTAMPTZ NOT NULL,
  voting_deadline_at TIMESTAMPTZ NOT NULL,
  revealed_at TIMESTAMPTZ,
  countdown_starts_at TIMESTAMPTZ,
  active_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  terminal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (battle_id, sequence),
  CHECK (voting_deadline_at > voting_opens_at)
);

-- PostgreSQL enforces the important race boundary: a battle can have only one
-- round that is still capable of receiving commands or changing play state.
CREATE UNIQUE INDEX IF NOT EXISTS rounds_one_nonterminal_per_battle
  ON rounds (battle_id)
  WHERE phase IN ('voting', 'revealed', 'countdown', 'active');

CREATE TABLE IF NOT EXISTS round_readiness (
  round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ready_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (round_id, user_id)
);

-- A viewer's first valid team is retained for the full battle. They may change
-- their option in a later round only from that same Twitch community.
CREATE TABLE IF NOT EXISTS battle_team_locks (
  battle_id UUID NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  viewer_twitch_id TEXT NOT NULL,
  source_channel_twitch_id TEXT NOT NULL,
  target_user_id UUID NOT NULL REFERENCES users(id),
  locked_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (battle_id, viewer_twitch_id)
);

CREATE TABLE IF NOT EXISTS round_votes (
  round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  viewer_twitch_id TEXT NOT NULL,
  source_channel_twitch_id TEXT NOT NULL,
  target_user_id UUID NOT NULL REFERENCES users(id),
  option_position SMALLINT NOT NULL CHECK (option_position BETWEEN 1 AND 3),
  message_id TEXT NOT NULL UNIQUE,
  received_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (round_id, viewer_twitch_id)
);

CREATE TABLE IF NOT EXISTS round_assignments (
  round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  target_user_id UUID NOT NULL REFERENCES users(id),
  challenge_option_id UUID REFERENCES challenge_options(id),
  resolution TEXT NOT NULL CHECK (resolution IN ('winner', 'tie-break', 'no-votes')),
  resolved_at TIMESTAMPTZ NOT NULL,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  cleared_at TIMESTAMPTZ,
  PRIMARY KEY (round_id, target_user_id),
  CHECK ((challenge_option_id IS NULL) = (resolution = 'no-votes'))
);

CREATE INDEX IF NOT EXISTS round_votes_round_target ON round_votes (round_id, target_user_id);
CREATE INDEX IF NOT EXISTS rounds_battle_phase ON rounds (battle_id, phase);

-- Versions and their options are append-only. Editing means proposing a new
-- version, which naturally resets both creators' approvals.
CREATE OR REPLACE FUNCTION backseat_reject_challenge_set_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Challenge-set versions are immutable; create a new version instead.';
END;
$$;

DROP TRIGGER IF EXISTS challenge_set_versions_are_immutable ON challenge_set_versions;
CREATE TRIGGER challenge_set_versions_are_immutable
  BEFORE UPDATE ON challenge_set_versions
  FOR EACH ROW EXECUTE FUNCTION backseat_reject_challenge_set_mutation();

DROP TRIGGER IF EXISTS challenge_options_are_immutable ON challenge_options;
CREATE TRIGGER challenge_options_are_immutable
  BEFORE UPDATE ON challenge_options
  FOR EACH ROW EXECUTE FUNCTION backseat_reject_challenge_set_mutation();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'battles_current_challenge_set_version_fk') THEN
    ALTER TABLE battles
      ADD CONSTRAINT battles_current_challenge_set_version_fk
      FOREIGN KEY (current_challenge_set_version_id) REFERENCES challenge_set_versions(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'battles_current_round_fk') THEN
    ALTER TABLE battles
      ADD CONSTRAINT battles_current_round_fk
      FOREIGN KEY (current_round_id) REFERENCES rounds(id);
  END IF;
END;
$$;
