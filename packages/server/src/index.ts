// The coordination server (docs/architecture.md §2): Postgres + WebSocket, with the events table
// as the record (D-11, D-12). It never runs agents, holds code or secrets, or widens local policy (D-32).
export {};
