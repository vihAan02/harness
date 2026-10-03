-- Message budgets and delivery (0A item 8; D-24, D-26, Q-05). A peer message over its task's budget is
-- held: stored and shown to the human, never delivered to the agent.
ALTER TABLE messages ADD COLUMN held boolean NOT NULL DEFAULT false;
