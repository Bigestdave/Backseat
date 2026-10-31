CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  twitch_id TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  scopes JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  validated_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS battles (
  id UUID PRIMARY KEY,
  host_user_id UUID NOT NULL REFERENCES users(id),
  guest_user_id UUID REFERENCES users(id),
  mode TEXT NOT NULL CHECK (mode IN ('real', 'simulated')),
  status TEXT NOT NULL CHECK (status IN ('setup', 'integration-proof', 'ended')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (guest_user_id IS NULL OR guest_user_id <> host_user_id)
);

CREATE TABLE IF NOT EXISTS battle_members (
  battle_id UUID NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('host', 'guest')),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (battle_id, user_id),
  UNIQUE (battle_id, role)
);

-- This table is the transactionally enforceable "one open battle per
-- creator" constraint. Delete a creator's row only when their battle ends.
CREATE TABLE IF NOT EXISTS active_battle_members (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  battle_id UUID NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (battle_id, user_id)
);

CREATE INDEX IF NOT EXISTS active_battle_members_battle_id ON active_battle_members (battle_id);

CREATE TABLE IF NOT EXISTS battle_invitations (
  id UUID PRIMARY KEY,
  battle_id UUID NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_user_id UUID REFERENCES users(id),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_twitch_events (
  delivery_id TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_commands (
  message_id TEXT PRIMARY KEY,
  battle_id UUID NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  source_channel_twitch_id TEXT NOT NULL,
  viewer_twitch_id TEXT NOT NULL,
  target_user_id UUID NOT NULL REFERENCES users(id),
  option TEXT NOT NULL CHECK (option IN ('1', '2', '3')),
  received_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_commands_battle_received_at ON chat_commands (battle_id, received_at DESC);

CREATE TABLE IF NOT EXISTS overlay_credentials (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  battle_id UUID NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

