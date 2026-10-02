-- Idempotent commands (docs/protocol.md §1). Each accepted command's outcome, keyed by the client's
-- command_id and written in the same transaction as its state change and events, so a retry after
-- a disconnect returns the original outcome instead of applying the command twice.
CREATE TABLE commands (
  command_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects (id),
  principal  text NOT NULL,      -- the connection's human
  as_agent   text,               -- set when the command ran for one of that human's agents
  name       text NOT NULL,
  args       jsonb NOT NULL,
  seqs       bigint[] NOT NULL DEFAULT '{}',
  result     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
