-- The lease commands (0B item 5; contract D-97). 0010 created leases for the land step's fencing check;
-- these columns record who granted each lease, how it ended, and when its expiry was first noticed.
ALTER TABLE leases ADD COLUMN ttl_s integer NOT NULL DEFAULT 120 CHECK (ttl_s BETWEEN 10 AND 3600);
ALTER TABLE leases ADD COLUMN granted_by text;                 -- the principal: the task's agent, or a human
ALTER TABLE leases ADD COLUMN force boolean NOT NULL DEFAULT false;
ALTER TABLE leases ADD COLUMN release_reason text CHECK (release_reason IN ('released', 'landed', 'revoked', 'abandoned'));
ALTER TABLE leases ADD COLUMN expired_logged_at timestamptz;   -- lease.expired is logged once, lazily (D-97)
UPDATE leases SET release_reason = 'landed' WHERE released_at IS NOT NULL; -- before this, only land.complete released leases
CREATE INDEX leases_by_task ON leases (task_id);
