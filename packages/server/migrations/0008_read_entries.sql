-- Read sets (0B item 1; D-22, D-23, D-88; coordination.md §2). What each task's agent has read, as paths
-- and content hashes only, never contents (TH-12). One entry per task and path: a later read replaces
-- the hash, so the entry always says what the agent last saw.
CREATE TABLE read_entries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id   text NOT NULL REFERENCES projects (id),
  task_id      text NOT NULL REFERENCES tasks (id),
  session_id   text NOT NULL REFERENCES agent_sessions (id), -- the session that read it last
  agent_id     text NOT NULL REFERENCES agent_principals (id),
  path         text NOT NULL,                                -- a repo-relative file, never a prefix
  content_hash text,                                         -- the Git blob id read; NULL = unknown, which always counts as changed
  source       text NOT NULL CHECK (source IN ('read_tool', 'search_hit', 'shell_heuristic', 'edit_base', 'instructions')),
  confidence   text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  range_start  integer,                                      -- first line read, when the tool read part of a file
  range_lines  integer,
  stale        boolean NOT NULL DEFAULT false,               -- synced past since it was read, and not re-read (D-53)
  observed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, path)
);
CREATE INDEX read_entries_by_path ON read_entries (project_id, path);
