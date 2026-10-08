-- Signed dispatch and device routing, the server's half (D-112, D-113; docs/protocol.md §11).
-- - agent_principals.device_id: the one device that runs the agent. Nullable: local-token stacks (tests, demos)
--   keep today's behaviour, where the agent's human's harnessd runs it.
-- - dispatches: every dispatch nonce the server accepted, once; a repeat is a replay. `outcome` records the target
--   device's refusal (`dispatch.rejected`) or failed start (`task.start_failed`), once per nonce.
-- - agent_sessions_one_live_per_task: at most one live session per task, whichever device asks (D-113). Live
--   duplicates from before this migration are ended first, keeping each task's newest, and each ending is logged.
ALTER TABLE agent_principals ADD COLUMN device_id text REFERENCES devices (id);

CREATE TABLE dispatches (
  nonce            text PRIMARY KEY,
  project_id       text NOT NULL REFERENCES projects (id),
  task_id          text NOT NULL REFERENCES tasks (id),
  kind             text NOT NULL CHECK (kind IN ('start', 'resume', 'reopen', 'abandon', 'complete', 'integrate')),
  issuer_device_id text NOT NULL REFERENCES devices (id),
  issuer_human_id  text NOT NULL REFERENCES human_principals (id),
  target_device_id text NOT NULL REFERENCES devices (id),
  envelope         jsonb NOT NULL,
  outcome          text CHECK (outcome IN ('rejected', 'start_failed')),
  outcome_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispatches_task ON dispatches (task_id);

DO $$
DECLARE
  s record;
  n bigint;
BEGIN
  FOR s IN
    SELECT a.id, a.agent_id, a.device_id, a.task_id, t.project_id, p.accountable_human_id
    FROM agent_sessions a
    JOIN tasks t ON t.id = a.task_id
    JOIN agent_principals p ON p.id = a.agent_id
    WHERE a.status <> 'ended' AND EXISTS (
      SELECT 1 FROM agent_sessions b
      WHERE b.task_id = a.task_id AND b.status <> 'ended' AND (b.started_at, b.id) > (a.started_at, a.id))
    ORDER BY t.project_id, a.started_at, a.id
  LOOP
    UPDATE agent_sessions SET status = 'ended', ended_at = now() WHERE id = s.id;
    UPDATE projects SET next_seq = next_seq + 1 WHERE id = s.project_id RETURNING next_seq INTO n;
    INSERT INTO events (project_id, seq, actor_principal, on_behalf_of, device_id, kind, data)
    VALUES (s.project_id, n, s.agent_id, s.accountable_human_id, s.device_id, 'session.ended',
            jsonb_build_object('session_id', s.id, 'agent_id', s.agent_id, 'task_id', s.task_id, 'reason', 'superseded_by_0015'));
  END LOOP;
END $$;

CREATE UNIQUE INDEX agent_sessions_one_live_per_task ON agent_sessions (task_id) WHERE status <> 'ended';
