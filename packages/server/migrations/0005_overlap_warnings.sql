-- Overlap warnings (0A item 7; coordination.md §1). One row per pair of tasks and path, so a warning
-- is raised once while both claims stand, not on every edit. Harness notices are deduplicated, not
-- budgeted (Q-05).
CREATE TABLE overlap_warnings (
  id          text PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects (id),
  task_a      text NOT NULL REFERENCES tasks (id),  -- the lower id of the pair
  task_b      text NOT NULL REFERENCES tasks (id),
  path        text NOT NULL,
  level       text NOT NULL CHECK (level IN ('prospective', 'observed')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  CHECK (task_a < task_b),
  UNIQUE (project_id, task_a, task_b, path, level)
);
