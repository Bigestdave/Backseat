-- Backseat frontend v2: a shared list has two to four picks, every pick keeps
-- its original author, and a completed session can show an honest manual score.

ALTER TABLE challenge_options
  ADD COLUMN IF NOT EXISTS added_by_user_id UUID REFERENCES users(id);

UPDATE challenge_options option
SET added_by_user_id = version.proposed_by_user_id
FROM challenge_set_versions version
WHERE option.challenge_set_version_id = version.id
  AND option.added_by_user_id IS NULL;

ALTER TABLE challenge_options
  ALTER COLUMN added_by_user_id SET NOT NULL;

ALTER TABLE challenge_options
  DROP CONSTRAINT IF EXISTS challenge_options_position_check;

ALTER TABLE challenge_options
  ADD CONSTRAINT challenge_options_position_check CHECK (position BETWEEN 1 AND 4);

ALTER TABLE round_votes
  DROP CONSTRAINT IF EXISTS round_votes_option_position_check;

ALTER TABLE round_votes
  ADD CONSTRAINT round_votes_option_position_check CHECK (option_position BETWEEN 1 AND 4);

ALTER TABLE chat_commands
  DROP CONSTRAINT IF EXISTS chat_commands_option_check;

ALTER TABLE chat_commands
  ADD CONSTRAINT chat_commands_option_check CHECK (option IN ('1', '2', '3', '4'));

ALTER TABLE rounds
  ADD COLUMN IF NOT EXISTS stopped_by_user_id UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS outcome TEXT;

ALTER TABLE rounds
  ADD CONSTRAINT rounds_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('host', 'guest', 'draw', 'stopped', 'none'));
