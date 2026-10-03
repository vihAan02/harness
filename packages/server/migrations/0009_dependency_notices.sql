-- Stale-context notices (0B item 2; D-22, D-53; coordination.md §2). A `dependency_changed` message tells
-- a reader that a file in its read set is being changed (stage in_progress) or has landed with different
-- content (stage landed). These rows say which paths each notice covers, so the same news is never sent
-- twice, and a newer notice can replace an older one the agent hasn't seen yet.
CREATE TABLE dependency_notices (
  message_id  text NOT NULL REFERENCES messages (id),
  project_id  text NOT NULL REFERENCES projects (id),
  reader_task text NOT NULL REFERENCES tasks (id),
  path        text NOT NULL,
  stage       text NOT NULL CHECK (stage IN ('in_progress', 'landed')),
  writer_task text NOT NULL REFERENCES tasks (id),
  land_id     text,                              -- for stage landed: which land
  read_hash   text,                              -- what the reader had read (a Git blob id, or NULL if unknown)
  new_hash    text,                              -- for stage landed: the content now on the base branch (NULL = deleted or unknown)
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, path)
);
-- The same news once: in progress once per reader, path and writer; landed once per reader, path and land.
CREATE UNIQUE INDEX dependency_notices_once ON dependency_notices (reader_task, path, writer_task, stage, coalesce(land_id, ''));
CREATE INDEX dependency_notices_by_reader ON dependency_notices (reader_task, path);

-- A notice replaced by a newer one before it was delivered is never delivered (coordination.md §2).
ALTER TABLE messages ADD COLUMN superseded_by text REFERENCES messages (id);
