-- Stale reads after a land (0B item 2; coordination.md §2). A reader whose branch hasn't been synced yet can
-- read a file a peer's land has already changed: its read is stale from the start. To catch that, each task
-- records the base it was last brought up to (created from, or synced to), and each land the blob id of every
-- file it changed. A read is checked against lands completed after the reader's base.
ALTER TABLE tasks ADD COLUMN base_set_at timestamptz;   -- when tasks.base_sha was last set (worktree created, or synced)
ALTER TABLE lands ADD COLUMN changed_blobs jsonb;       -- { path: blob id or null (deleted) }, from land.complete
