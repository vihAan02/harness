-- GitHub integration for the two-Mac pilot (D-114, D-115; docs/protocol.md §11).
-- - projects.integration_mode: set on the server. `local` keeps 0B's local land (the demos, the tests, the
--   benchmark); in a `github` project the local land is refused and work lands through PRs.
-- - task_prs: the PR a finished task was published as, and what harnessd last polled of it.
-- - project_bases: the base branch's tip as GitHub has it, moved only by compare-and-swap, so every daemon
--   agrees on one chain of base commits.
-- - base_advances: every move of that tip, once, by its new commit: a harness land, a PR merged outside the
--   harness, or any other merge. A move seen while a merge is armed is parked until the merge's outcome is known.
-- - lands gain what a GitHub-mode land (the integration reservation) is bound to and how far it got.
-- - dependency_notices.writer_task may be NULL: a merge made outside the harness has no writing task.
ALTER TABLE projects ADD COLUMN integration_mode text NOT NULL DEFAULT 'local' CHECK (integration_mode IN ('local', 'github'));
ALTER TABLE projects ADD COLUMN github_repo text;   -- owner/name, for github mode

CREATE TABLE task_prs (
  task_id         text PRIMARY KEY REFERENCES tasks (id),
  project_id      text NOT NULL REFERENCES projects (id),
  device_id       text NOT NULL REFERENCES devices (id),   -- the device that published it, and polls it
  pr_number       integer NOT NULL,
  url             text NOT NULL,
  remote_ref      text NOT NULL,
  head_sha        text NOT NULL,
  base_sha        text NOT NULL,
  state           text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  merged          boolean NOT NULL DEFAULT false,
  merge_sha       text,
  mergeable_state text,
  checks          jsonb NOT NULL DEFAULT '{}',
  reviews         jsonb NOT NULL DEFAULT '[]',
  published_at    timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, pr_number)
);

CREATE TABLE project_bases (
  project_id text PRIMARY KEY REFERENCES projects (id),
  tip_sha    text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE base_advances (
  project_id    text NOT NULL REFERENCES projects (id),
  new_sha       text NOT NULL,
  old_sha       text NOT NULL,
  source        text NOT NULL,   -- 'land:<land id>', or 'external'
  status        text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'parked')),
  changed_blobs jsonb,            -- path → the new blob id, or null if deleted
  observed_by   text,             -- the device that reported it
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, new_sha)
);

ALTER TABLE lands ADD COLUMN mode text NOT NULL DEFAULT 'local' CHECK (mode IN ('local', 'github', 'external'));
ALTER TABLE lands ADD COLUMN pr_number integer;
ALTER TABLE lands ADD COLUMN approved_head_sha text;
ALTER TABLE lands ADD COLUMN approved_base_sha text;
ALTER TABLE lands ADD COLUMN step text CHECK (step IN ('checking', 'merge_requested', 'outcome_unknown'));
ALTER TABLE lands ADD COLUMN merge_requested_at timestamptz;   -- set once by land.arm; from then on the land can't be cancelled
ALTER TABLE lands ADD COLUMN dispatch_nonce text;

ALTER TABLE dependency_notices ALTER COLUMN writer_task DROP NOT NULL;
DROP INDEX dependency_notices_once;
CREATE UNIQUE INDEX dependency_notices_once ON dependency_notices (reader_task, path, coalesce(writer_task, ''), stage, coalesce(land_id, ''));
