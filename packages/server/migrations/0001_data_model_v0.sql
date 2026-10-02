-- Data model v0 (0A item 2): the 0A subset of docs/protocol.md §5.
-- Many-person from the start (D-18): people attach to projects through memberships, never project.user_id.
-- 0B adds leases, read entries, waits and the fencing counter.

-- identity
CREATE TABLE human_principals (
  id           text PRIMARY KEY,
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id                text PRIMARY KEY,
  human_id          text NOT NULL REFERENCES human_principals (id),
  name              text NOT NULL,
  public_key        text,                       -- Phase 1: signed commands (D-33)
  last_heartbeat_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  repo_url       text,
  default_branch text NOT NULL DEFAULT 'main',
  next_seq       bigint NOT NULL DEFAULT 0,     -- the event log's counter row (D-12, F-56)
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_memberships (
  project_id text NOT NULL REFERENCES projects (id),
  human_id   text NOT NULL REFERENCES human_principals (id),
  role       text NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  PRIMARY KEY (project_id, human_id)
);

CREATE TABLE agent_principals (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects (id),
  accountable_human_id text NOT NULL REFERENCES human_principals (id),
  vendor               text NOT NULL,           -- claude | codex | …
  name                 text NOT NULL,           -- e.g. agent/backend-1
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

-- work
CREATE TABLE tasks (
  id                text PRIMARY KEY,
  project_id        text NOT NULL REFERENCES projects (id),
  title             text NOT NULL,
  text              text NOT NULL,
  scope             text[] NOT NULL,            -- folder prefixes ("src/api/") and exact files (D-21)
  priority          integer NOT NULL DEFAULT 0,
  owner_human_id    text NOT NULL REFERENCES human_principals (id),
  assignee_agent_id text REFERENCES agent_principals (id),
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'in_progress', 'blocked', 'done', 'landed', 'abandoned')), -- D-54, D-53
  base_sha          text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_sessions (
  id                text PRIMARY KEY,
  agent_id          text NOT NULL REFERENCES agent_principals (id),
  device_id         text NOT NULL REFERENCES devices (id),
  task_id           text NOT NULL REFERENCES tasks (id),
  worktree_path     text NOT NULL,
  branch            text NOT NULL,
  vendor_session_id text,
  vendor_version    text,
  status            text NOT NULL DEFAULT 'starting'
                    CHECK (status IN ('starting', 'working', 'idle', 'waiting', 'suspended', 'errored', 'ended')),
  last_heartbeat_at timestamptz,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz
);

-- coordination
CREATE TABLE claims (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects (id),
  task_id    text NOT NULL REFERENCES tasks (id),
  session_id text REFERENCES agent_sessions (id),
  kind       text NOT NULL CHECK (kind IN ('prospective', 'observed')), -- hard claims are leases (0B)
  path       text NOT NULL,                     -- a prefix ending in "/" or an exact file (D-21)
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz
);
CREATE INDEX claims_active ON claims (project_id, path) WHERE cleared_at IS NULL;

CREATE TABLE messages (
  id             text PRIMARY KEY,
  project_id     text NOT NULL REFERENCES projects (id),
  kind           text NOT NULL CHECK (kind IN (  -- the typed set (D-24); a new kind needs a D-ID
                   'question', 'answer', 'dependency_changed', 'contract_request', 'task_blocked', 'claim_conflict')),
  from_principal text NOT NULL,                 -- human_…, agent_…, or 'harness'
  to_principal   text,
  in_reply_to    text REFERENCES messages (id),
  text           text,                          -- capped by config (Q-05), not by the column
  data           jsonb NOT NULL DEFAULT '{}',
  priority       text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  delivered_at   timestamptz,
  delivery       text CHECK (delivery IN ('between_tools', 'new_turn', 'stop_hook'))
);

CREATE TABLE budgets (
  task_id           text PRIMARY KEY REFERENCES tasks (id),
  messages_sent     integer NOT NULL DEFAULT 0,
  messages_received integer NOT NULL DEFAULT 0,
  coord_tokens_est  integer NOT NULL DEFAULT 0
);

-- log: append-only, dense per-project seqs handed out by projects.next_seq (D-12)
CREATE TABLE events (
  project_id      text NOT NULL REFERENCES projects (id),
  seq             bigint NOT NULL,
  at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_principal text NOT NULL,
  on_behalf_of    text,
  device_id       text,
  kind            text NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (project_id, seq)
);
