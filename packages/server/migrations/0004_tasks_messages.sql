-- The task lifecycle and peer messages (0A items 6 to 8; D-54, D-24).
-- Task ids are short and readable (T-1, T-2, …), from one sequence, so they stay unique across projects.
CREATE SEQUENCE task_numbers;
ALTER TABLE tasks ADD COLUMN summary text;               -- from report_done or `harness task done`
ALTER TABLE tasks ADD COLUMN completed_at timestamptz;
-- Which task each side of a message belongs to: budgets are per task (Q-05).
ALTER TABLE messages ADD COLUMN from_task_id text REFERENCES tasks (id);
ALTER TABLE messages ADD COLUMN to_task_id text REFERENCES tasks (id);
