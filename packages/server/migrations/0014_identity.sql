-- The two-Mac pilot's identity (D-111, D-113; docs/protocol.md §2).
-- - devices.public_key (0001) now holds each device's Ed25519 key, `ed25519:<base64 SPKI>`; a revoked device
--   can no longer complete a hello.
-- - human_principals.github_login: which GitHub account a human is, for the review gate (D-115).
-- - coordinator_epoch: one row naming this coordinator's database. A daemon that sees a different epoch knows
--   it is talking to a new coordinator and stops before mixing its local state with it (D-113).
ALTER TABLE devices ADD COLUMN revoked_at timestamptz;
ALTER TABLE human_principals ADD COLUMN github_login text;

CREATE TABLE coordinator_epoch (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO coordinator_epoch (epoch) VALUES (left(replace(gen_random_uuid()::text, '-', ''), 16));
