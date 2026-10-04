-- wait_for (0B item 4; D-27, D-95; protocol.md §3/§4): one row per wait an agent starts, on the answer to
-- its question, another task finishing, or a lease freeing up. Every wait gets exactly one outcome: the
-- server's sweep resolves it from current state, times it out (and tells the task's owner), or cancels it
-- when the waiting task ends. A task waits on one thing at a time.
CREATE TABLE waits (
  id          text PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects (id),
  task_id     text NOT NULL REFERENCES tasks (id),
  session_id  text NOT NULL REFERENCES agent_sessions (id),
  agent_id    text NOT NULL REFERENCES agent_principals (id),
  on_kind     text NOT NULL CHECK (on_kind IN ('answer', 'task', 'lease')),
  on_id       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  timeout_at  timestamptz NOT NULL, -- the server's clock decides (F-84)
  outcome     text CHECK (outcome IN ('resolved', 'timed_out', 'cancelled')),
  result      jsonb,
  finished_at timestamptz
);
CREATE UNIQUE INDEX waits_one_open_per_task ON waits (task_id) WHERE outcome IS NULL;
CREATE INDEX waits_open ON waits (project_id) WHERE outcome IS NULL;
