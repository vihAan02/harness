-- The model each agent session runs on (D-87). The A/B test holds the model and its configuration
-- constant across arms (validation.md §3), so every session records what it was configured with.
-- NULL means the vendor's default model, or that no provider profile was named.
ALTER TABLE agent_sessions ADD COLUMN model text;
ALTER TABLE agent_sessions ADD COLUMN provider text;
