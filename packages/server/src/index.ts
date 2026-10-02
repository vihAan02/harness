// The coordination server (docs/architecture.md §2): Postgres + WebSocket, with the events table
// as the record (D-11, D-12). It never runs agents, holds code or secrets, or widens local policy (D-32).
export { createPool, inTransaction, migrate, DEFAULT_DATABASE_URL } from './db.ts';
export { appendEvents, readEvents, type NewEvent, type StoredEvent } from './events.ts';
export { executeCommand, CommandError, EVENTS_CHANNEL, type Caller } from './commands.ts';
export { startServer, type ServerOptions, type RunningServer } from './server.ts';
