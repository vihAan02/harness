-- The local land step and hard-claim leases (0B item 5; D-20, D-51, D-54, D-89; coordination.md §1;
-- local-runtime.md §4). A land merges a finished task into the base branch on the device that ran it,
-- after a fencing check against leases: a lease is only honoured if its token is the highest ever issued
-- for its paths (F-80). The lease commands themselves come later in 0B; the check is real from now on.
ALTER TABLE projects ADD COLUMN next_fencing_token bigint NOT NULL DEFAULT 0;

CREATE TABLE leases (
  id          text PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects (id),
  task_id     text NOT NULL REFERENCES tasks (id),
  path        text NOT NULL,                     -- a prefix ending in "/" or an exact file (D-21)
  token       bigint NOT NULL,                   -- from projects.next_fencing_token, never reused
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,              -- the server's clock decides (F-84)
  released_at timestamptz
);
CREATE INDEX leases_by_project ON leases (project_id, path);

CREATE TABLE lands (
  id             text PRIMARY KEY,
  project_id     text NOT NULL REFERENCES projects (id),
  task_id        text NOT NULL REFERENCES tasks (id),
  device_id      text NOT NULL REFERENCES devices (id), -- the device that ran the task, which merges and tests
  requested_by   text NOT NULL,
  status         text NOT NULL DEFAULT 'requested'
                 CHECK (status IN ('requested', 'accepted', 'rejected', 'completed', 'failed', 'cancelled')),
  run_tests      boolean NOT NULL DEFAULT true,
  base_branch    text,
  base_sha       text,
  merge_base_sha text,
  head_sha       text,
  new_base_sha   text,
  changed_paths  text[],
  reason         text,
  detail         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
-- One land in flight per project: lands serialize on the base branch.
CREATE UNIQUE INDEX lands_one_in_flight ON lands (project_id) WHERE status IN ('requested', 'accepted');

ALTER TABLE tasks ADD COLUMN landed_at timestamptz;
