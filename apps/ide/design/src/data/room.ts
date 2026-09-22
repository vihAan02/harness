// Mock room for the UI prototypes. Shapes follow packages/protocol (members, agents, plans,
// claims, locks, diffs, messages, streams) and the "What is everyone doing?" status row.

export type Vendor = 'claude' | 'codex'
export type AgentStatus =
  | 'thinking' | 'editing' | 'running' | 'blocked' | 'waiting_review' | 'idle'

export interface Member { id: string; name: string; initials: string; you?: boolean }

export interface PlanStep {
  title: string
  state: 'done' | 'active' | 'todo' | 'blocked'
  /** this step cannot start until another agent's step lands */
  waitsOn?: { agent: string; step: number; why: string }
}

export interface FileChange { path: string; additions: number; deletions: number; locked?: boolean }

export type Conflict =
  | { kind: 'collision'; path: string; with: string; lines: string }
  | { kind: 'in_foreign_claim'; path: string; owner: string; pattern: string }
  | { kind: 'review'; role: 'requester' | 'reviewer'; command: string }

export interface Agent {
  id: string
  name: string
  owner: string
  vendor: Vendor
  status: AgentStatus
  /** what the status line says right now */
  doing: string
  task: string
  branch: string
  plan: { title: string; steps: PlanStep[] }
  claims: string[]
  files: FileChange[]
  conflicts: Conflict[]
  /** hue for Graphite (pastel) and Prism (spectral) */
  color: { graphite: string; prism: string }
  stats: { started: string; elapsed: string; lastActive: string; tests?: { passed: number; failed: number } }
}

export const members: Member[] = [
  { id: 'you', name: 'You', initials: 'VK', you: true },
  { id: 'maya', name: 'Maya', initials: 'MC' },
  { id: 'theo', name: 'Theo', initials: 'TP' },
]

export const agents: Agent[] = [
  {
    id: 'auth-refactor', name: 'auth-refactor', owner: 'you', vendor: 'claude', status: 'editing',
    doing: 'Editing middleware.ts', task: 'Move session handling to signed JWTs',
    branch: 'mp/you/auth-refactor',
    plan: {
      title: 'Replace cookie sessions with JWT', steps: [
        { title: 'Add jose + key loader', state: 'done' },
        { title: 'Sign tokens on login', state: 'done' },
        { title: 'Issue refresh tokens', state: 'done' },
        { title: 'Rewrite withSession() middleware', state: 'active' },
        { title: 'Update route guards', state: 'todo' },
        { title: 'Drop cookie store', state: 'blocked', waitsOn: { agent: 'migrate-db', step: 3, why: 'needs sessions backfilled first' } },
      ],
    },
    claims: ['src/auth/**'],
    files: [
      { path: 'src/auth/session.ts', additions: 42, deletions: 18, locked: true },
      { path: 'src/auth/middleware.ts', additions: 9, deletions: 3 },
    ],
    conflicts: [{ kind: 'review', role: 'reviewer', command: 'prisma migrate deploy' }],
    color: { graphite: '#f0aa88', prism: '#ff6b4a' },
    stats: { started: '10:31', elapsed: '17m', lastActive: 'now', tests: { passed: 23, failed: 0 } },
  },
  {
    id: 'api-tests', name: 'api-tests', owner: 'you', vendor: 'codex', status: 'running',
    doing: 'Running npm test -- rooms', task: 'Cover /v1/rooms with integration tests',
    branch: 'mp/you/api-tests',
    plan: {
      title: 'Integration tests for rooms API', steps: [
        { title: 'Fixture relay + daemon', state: 'done' },
        { title: 'create / join', state: 'done' },
        { title: 'status + agents', state: 'done' },
        { title: 'invite expiry', state: 'done' },
        { title: 'Fix 401 vs 403 on join', state: 'active' },
        { title: 'Guard-route cases', state: 'blocked', waitsOn: { agent: 'auth-refactor', step: 4, why: 'route guards change first' } },
      ],
    },
    claims: ['test/api/**'],
    files: [{ path: 'test/api/rooms.test.ts', additions: 120, deletions: 0 }],
    conflicts: [],
    color: { graphite: '#8fd6a6', prism: '#5ee89b' },
    stats: { started: '10:12', elapsed: '36m', lastActive: '20s ago', tests: { passed: 18, failed: 2 } },
  },
  {
    id: 'migrate-db', name: 'migrate-db', owner: 'maya', vendor: 'claude', status: 'waiting_review',
    doing: 'Waiting for review of prisma migrate deploy', task: 'Add sessions table + backfill',
    branch: 'mp/maya/migrate-db',
    plan: {
      title: 'Sessions table', steps: [
        { title: 'Model Session in schema', state: 'done' },
        { title: 'Generate migration', state: 'done' },
        { title: 'Deploy migration (gated)', state: 'active' },
        { title: 'Backfill from cookie store', state: 'blocked', waitsOn: { agent: 'rate-limit', step: 2, why: 'Maya: hold until the limiter ships' } },
      ],
    },
    claims: ['prisma/**', 'src/db/**'],
    files: [
      { path: 'prisma/schema.prisma', additions: 14, deletions: 2, locked: true },
      { path: 'prisma/migrations/0007_sessions/migration.sql', additions: 31, deletions: 0 },
    ],
    conflicts: [{ kind: 'review', role: 'requester', command: 'prisma migrate deploy' }],
    color: { graphite: '#bba6f2', prism: '#a98bff' },
    stats: { started: '10:20', elapsed: '28m', lastActive: '6m ago' },
  },
  {
    id: 'billing-ui', name: 'billing-ui', owner: 'maya', vendor: 'codex', status: 'thinking',
    doing: 'Planning the invoice table', task: 'Redesign the invoices page',
    branch: 'mp/maya/billing-ui',
    plan: {
      title: 'Invoices page', steps: [
        { title: 'Audit current page', state: 'done' },
        { title: 'Table + filters', state: 'active' },
        { title: 'Empty + error states', state: 'todo' },
        { title: 'Visual QA', state: 'todo' },
      ],
    },
    claims: ['web/billing/**'],
    files: [{ path: 'web/billing/Invoices.tsx', additions: 88, deletions: 41 }],
    conflicts: [],
    color: { graphite: '#90b9f2', prism: '#4fd6ff' },
    stats: { started: '10:25', elapsed: '23m', lastActive: '1m ago' },
  },
  {
    id: 'rate-limit', name: 'rate-limit', owner: 'theo', vendor: 'claude', status: 'blocked',
    doing: 'Blocked: middleware.ts is in auth-refactor’s claim', task: 'Per-token rate limiting on the API',
    branch: 'mp/theo/rate-limit',
    plan: {
      title: 'Token bucket limiter', steps: [
        { title: 'Bucket store (in-memory)', state: 'done' },
        { title: 'Hook into middleware', state: 'blocked', waitsOn: { agent: 'auth-refactor', step: 3, why: 'withSession() is being rewritten' } },
        { title: '429 responses + headers', state: 'todo' },
      ],
    },
    claims: ['src/limits/**'],
    files: [
      { path: 'src/limits/bucket.ts', additions: 54, deletions: 0 },
      { path: 'src/auth/middleware.ts', additions: 6, deletions: 1 },
    ],
    conflicts: [
      { kind: 'in_foreign_claim', path: 'src/auth/middleware.ts', owner: 'auth-refactor', pattern: 'src/auth/**' },
      { kind: 'collision', path: 'src/auth/middleware.ts', with: 'auth-refactor', lines: '14–22' },
    ],
    color: { graphite: '#e7c173', prism: '#ffb547' },
    stats: { started: '10:35', elapsed: '13m', lastActive: '5m ago' },
  },
]

export const agentById = (id: string) => agents.find(a => a.id === id)!
export const memberById = (id: string) => members.find(m => m.id === id)!
export const vendorName = (v: Vendor) => (v === 'claude' ? 'Claude Code' : 'Codex')
export const statusLabel: Record<AgentStatus, string> = {
  thinking: 'Thinking', editing: 'Editing', running: 'Running', blocked: 'Blocked',
  waiting_review: 'Waiting for review', idle: 'Idle',
}

export function describeConflict(c: Conflict): string {
  switch (c.kind) {
    case 'collision': return `${c.path} also changed by ${c.with} (lines ${c.lines})`
    case 'in_foreign_claim': return `${c.path} is in ${c.owner}’s area ${c.pattern}`
    case 'review': return c.role === 'requester' ? `Waiting on review of \`${c.command}\`` : `Asked to review \`${c.command}\``
  }
}

export type Party = { type: 'agent' | 'member' | 'harness'; id: string }
export type CommKind = 'claim' | 'question' | 'answer' | 'review' | 'approve' | 'note' | 'fyi' | 'denied' | 'handoff'

/** One thing an agent said to another agent, a person, or the whole room. */
export interface CommEvent {
  id: string
  at: string
  from: Party
  /** empty = broadcast to the room */
  to: Party[]
  kind: CommKind
  body: string
  thread?: string
  urgent?: boolean
  /** still in flight: the sender is composing or the answer hasn't landed */
  pending?: boolean
}

export interface Thread {
  id: string
  topic: string
  about: string
  status: 'waiting_human' | 'waiting_agent' | 'agreed' | 'unanswered'
  /** what has to happen for this thread to close */
  next: string
}

const A = (id: string): Party => ({ type: 'agent', id })
const M = (id: string): Party => ({ type: 'member', id })
const H: Party = { type: 'harness', id: 'harness' }

export const threads: Thread[] = [
  { id: 't1', topic: 'Deploy migration 0007_sessions', about: 'prisma/**', status: 'waiting_human', next: 'Maya approves the gated command' },
  { id: 't2', topic: 'Who edits withSession() lines 14–22', about: 'src/auth/middleware.ts', status: 'waiting_agent', next: 'auth-refactor hands off the beforeSession hook' },
  { id: 't3', topic: 'Backfill waits on the limiter', about: 'plans', status: 'waiting_agent', next: 'rate-limit ships 429 responses' },
  { id: 't4', topic: '401 vs 403 on /v1/rooms/join', about: 'test/api/rooms.test.ts', status: 'unanswered', next: 'somebody owns the status-code decision' },
]

export const comms: CommEvent[] = [
  { id: 'c1', at: '10:32', from: A('auth-refactor'), to: [], kind: 'claim', body: 'Claimed src/auth/** for the JWT session rewrite.' },
  { id: 'c2', at: '10:37', from: A('migrate-db'), to: [], kind: 'claim', body: 'Claimed prisma/** and src/db/** for the sessions table.' },
  { id: 'c3', at: '10:41', from: A('migrate-db'), to: [], kind: 'review', thread: 't1', urgent: true,
    body: 'Requesting review: `prisma migrate deploy` adds the `sessions` table. It touches shared state, so prisma/** is frozen until someone approves.' },
  { id: 'c4', at: '10:42', from: H, to: [A('rate-limit')], kind: 'denied',
    body: 'Edit denied: src/auth/middleware.ts is inside auth-refactor’s claim src/auth/**. Ask for a handoff or wait for the claim to release.' },
  { id: 'c5', at: '10:43', from: A('rate-limit'), to: [A('auth-refactor')], kind: 'question', thread: 't2',
    body: 'I need to call the limiter inside withSession() (middleware.ts 14–22). You’re rewriting that block — do you go first, or should I?' },
  { id: 'c6', at: '10:44', from: A('auth-refactor'), to: [A('rate-limit')], kind: 'answer', thread: 't2',
    body: 'Let me land it first (~5 min). I’ll expose a `beforeSession` hook so you never touch that block. I’ll ping you when it’s in.' },
  { id: 'c7', at: '10:44', from: A('auth-refactor'), to: [A('migrate-db')], kind: 'review', thread: 't1',
    body: 'Read 0007_sessions: additive, no data loss, reversible. I’d approve — but a human has to clear the gate.' },
  { id: 'c8', at: '10:45', from: A('billing-ui'), to: [], kind: 'fyi',
    body: 'Claiming web/billing/** — nobody else is in there. Shout if you need the invoices page.' },
  { id: 'c9', at: '10:46', from: M('maya'), to: [A('migrate-db')], kind: 'note', thread: 't1',
    body: 'Hold the backfill until Theo’s limiter is in — I don’t want a migration and a hot path landing together.' },
  { id: 'c10', at: '10:46', from: A('migrate-db'), to: [A('rate-limit')], kind: 'question', thread: 't3',
    body: 'Ping me when the 429s ship? My backfill is parked behind your step 3.' },
  { id: 'c11', at: '10:47', from: A('api-tests'), to: [], kind: 'fyi', thread: 't4',
    body: 'rooms.test.ts: 18 passing, 2 failing on POST /v1/rooms/join — expected 403, got 401. Whose call is the status code?' },
  { id: 'c12', at: '10:48', from: A('auth-refactor'), to: [A('rate-limit')], kind: 'handoff', thread: 't2', pending: true,
    body: 'beforeSession hook is landing now — handing you middleware.ts as soon as the edit closes.' },
]

export const commsFor = (agentId: string) =>
  comms.filter(c => c.from.id === agentId || c.to.some(t => t.id === agentId))

export const partyName = (p: Party) =>
  p.type === 'agent' ? agentById(p.id).name : p.type === 'member' ? memberById(p.id).name : 'Harness'

export const KIND_LABEL: Record<CommKind, string> = {
  claim: 'CLAIM', question: 'QUESTION', answer: 'ANSWER', review: 'REVIEW', approve: 'APPROVED',
  note: 'NOTE', fyi: 'FYI', denied: 'DENIED', handoff: 'HANDOFF',
}

export type StreamEvent =
  | { kind: 'prompt'; text: string; at: string }
  | { kind: 'say'; text: string; at: string }
  | { kind: 'tool'; tool: string; target: string; detail?: string; ok?: boolean; at: string; live?: boolean }
  | { kind: 'coord'; text: string; at: string }
  | { kind: 'inbox'; from: string; text: string; at: string }

export const streams: Record<string, StreamEvent[]> = {
  'auth-refactor': [
    { kind: 'prompt', at: '10:31', text: 'Move session handling to signed JWTs. Keep the cookie fallback for one release.' },
    { kind: 'say', at: '10:31', text: 'I’ll publish a plan, claim src/auth/**, then work through session.ts before the middleware.' },
    { kind: 'coord', at: '10:32', text: 'Published plan · 6 steps' },
    { kind: 'coord', at: '10:32', text: 'Claimed src/auth/**' },
    { kind: 'tool', tool: 'Read', target: 'src/auth/session.ts', at: '10:33' },
    { kind: 'tool', tool: 'Edit', target: 'src/auth/session.ts', detail: '+42 −18', at: '10:38' },
    { kind: 'tool', tool: 'Bash', target: 'npm test -- auth', detail: '23 passed', ok: true, at: '10:40' },
    { kind: 'inbox', from: 'rate-limit', at: '10:43', text: 'Go first, or should I? (middleware.ts 14–22)' },
    { kind: 'say', at: '10:44', text: 'verifySession() now checks the JWT first and falls back to the cookie store. Adding a beforeSession hook so rate-limit can plug in without touching this block.' },
    { kind: 'tool', tool: 'Edit', target: 'src/auth/middleware.ts', detail: '+9 −3', at: '10:47', live: true },
  ],
  'api-tests': [
    { kind: 'prompt', at: '10:12', text: 'Write integration tests for /v1/rooms using the loopback relay.' },
    { kind: 'coord', at: '10:12', text: 'Claimed test/api/**' },
    { kind: 'tool', tool: 'Write', target: 'test/api/rooms.test.ts', detail: '+120', at: '10:29' },
    { kind: 'tool', tool: 'Bash', target: 'npm test -- rooms', detail: '18 passed · 2 failed', ok: false, at: '10:46' },
    { kind: 'say', at: '10:47', text: 'join returns 401 for a bad invite; spec says 403. Checking the daemon handler before changing the test.' },
    { kind: 'tool', tool: 'Bash', target: 'npm test -- rooms', at: '10:48', live: true },
  ],
  'migrate-db': [
    { kind: 'prompt', at: '10:20', text: 'Add a sessions table and backfill it from the cookie store.' },
    { kind: 'tool', tool: 'Edit', target: 'prisma/schema.prisma', detail: '+14 −2', at: '10:34' },
    { kind: 'tool', tool: 'Bash', target: 'prisma migrate dev --create-only', detail: '0007_sessions', ok: true, at: '10:37' },
    { kind: 'coord', at: '10:41', text: 'Gate: `prisma migrate deploy` touches shared state → froze prisma/** and asked for review' },
    { kind: 'inbox', from: 'maya', at: '10:46', text: 'Hold the backfill until Theo’s limiter is in.' },
  ],
  'billing-ui': [
    { kind: 'prompt', at: '10:25', text: 'Redesign the invoices page. Dense table, filters, CSV export.' },
    { kind: 'tool', tool: 'Read', target: 'web/billing/Invoices.tsx', at: '10:26' },
    { kind: 'tool', tool: 'Edit', target: 'web/billing/Invoices.tsx', detail: '+88 −41', at: '10:44' },
    { kind: 'say', at: '10:47', text: 'Splitting the filters into a toolbar component so the table stays virtualized.' },
  ],
  'rate-limit': [
    { kind: 'prompt', at: '10:35', text: 'Add per-token rate limiting to the API. 60 req/min, burst 20.' },
    { kind: 'tool', tool: 'Write', target: 'src/limits/bucket.ts', detail: '+54', at: '10:41' },
    { kind: 'coord', at: '10:42', text: 'Edit denied: src/auth/middleware.ts is in auth-refactor’s claim' },
    { kind: 'tool', tool: 'mp_ask', target: 'auth-refactor', at: '10:43' },
    { kind: 'inbox', from: 'auth-refactor', at: '10:44', text: 'Let me land it first (~5 min). I’ll expose a beforeSession hook.' },
  ],
}

// ── files ───────────────────────────────────────────────────────────────────

export interface TreeNode {
  name: string
  path: string
  dir?: boolean
  children?: TreeNode[]
  git?: 'M' | 'A' | 'U'
}

const f = (path: string, git?: TreeNode['git']): TreeNode => ({ name: path.split('/').pop()!, path, git })
const d = (path: string, children: TreeNode[]): TreeNode => ({ name: path.split('/').pop()!, path, dir: true, children })

export const tree: TreeNode[] = [
  d('prisma', [d('prisma/migrations', [f('prisma/migrations/0007_sessions', 'A')]), f('prisma/schema.prisma', 'M')]),
  d('src', [
    d('src/auth', [f('src/auth/index.ts'), f('src/auth/middleware.ts', 'M'), f('src/auth/session.ts', 'M'), f('src/auth/tokens.ts')]),
    d('src/db', [f('src/db/client.ts')]),
    d('src/limits', [f('src/limits/bucket.ts', 'A')]),
    d('src/routes', [f('src/routes/health.ts'), f('src/routes/rooms.ts')]),
    f('src/server.ts'),
  ]),
  d('test', [d('test/api', [f('test/api/rooms.test.ts', 'A')])]),
  d('web', [d('web/billing', [f('web/billing/Invoices.tsx', 'M')])]),
  f('package.json'),
  f('README.md'),
]

/** which agents are touching a path right now (files they modify) */
export function agentsOnPath(path: string): Agent[] {
  return agents.filter(a => a.files.some(x => x.path === path || x.path.startsWith(path + '/')))
}
/** the agent whose claim covers a directory exactly */
export function claimOn(dir: string): Agent | undefined {
  return agents.find(a => a.claims.some(c => c === `${dir}/**`))
}
export function lockOn(path: string): Agent | undefined {
  return agents.find(a => a.files.some(x => x.path === path && x.locked))
}

// ── editor content ──────────────────────────────────────────────────────────

export interface OpenFile {
  path: string
  code: string
  /** agent currently typing in this file */
  live?: { agent: string; from: number; to: number; cursorLine: number; typing: string }
  /** another agent's pending hunk (in its worktree), shown inline */
  ghost?: { agent: string; afterLine: number; overlaps?: string; lines: { t: '+' | '-' | ' '; s: string }[] }
}

export const files: Record<string, OpenFile> = {
  'src/auth/middleware.ts': {
    path: 'src/auth/middleware.ts',
    code: `import type { Handler, Request } from '../http'
import { verifySession, type Session } from './session'
import { unauthorized } from '../routes/errors'

export interface SessionHooks {
  /** Runs before the session is verified, e.g. rate limiting. */
  beforeSession?: (req: Request) => Promise<void> | void
}

// Resolves the caller's session from the Authorization header,
// falling back to the legacy cookie for one release.
export function withSession(handler: Handler, hooks: SessionHooks = {}): Handler {
  return async (req) => {
    await hooks.beforeSession?.(req)
    const token = bearer(req) ?? req.cookies.get('sid')
    if (!token) {
      return unauthorized('missing session')
    }
    const session: Session | null = await verifySession(token)
    if (!session) {
      return unauthorized('invalid or expired session')
    }
    req.session = session
    return handler(req)
  }
}

function bearer(req: Request): string | undefined {
  const header = req.headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : undefined
}
`,
    live: { agent: 'auth-refactor', from: 13, to: 22, cursorLine: 14, typing: '    await hooks.beforeSession?.(req)' },
    ghost: {
      agent: 'rate-limit', afterLine: 13, overlaps: '14–22',
      lines: [
        { t: ' ', s: '  return async (req) => {' },
        { t: '+', s: '    const bucket = limiter.take(req.ip)' },
        { t: '+', s: '    if (!bucket.ok) {' },
        { t: '+', s: "      return tooManyRequests(bucket.retryAfter)" },
        { t: '+', s: '    }' },
        { t: ' ', s: "    const token = bearer(req) ?? req.cookies.get('sid')" },
      ],
    },
  },
  'src/auth/session.ts': {
    path: 'src/auth/session.ts',
    code: `import { jwtVerify, SignJWT } from 'jose'
import { keys } from './tokens'
import { legacyStore } from '../db/client'

export interface Session {
  userId: string
  roomIds: string[]
  expiresAt: number
}

const ISSUER = 'harness'
const TTL_SECONDS = 60 * 15

export async function signSession(s: Omit<Session, 'expiresAt'>): Promise<string> {
  return new SignJWT({ roomIds: s.roomIds })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(s.userId)
    .setIssuer(ISSUER)
    .setExpirationTime(\`\${TTL_SECONDS}s\`)
    .sign(await keys.signing())
}

export async function verifySession(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, await keys.verifying(), { issuer: ISSUER })
    return { userId: payload.sub!, roomIds: payload.roomIds as string[], expiresAt: payload.exp! * 1000 }
  } catch {
    // Legacy cookie sessions stay valid for one release.
    return legacyStore.get(token)
  }
}
`,
  },
  'test/api/rooms.test.ts': {
    path: 'test/api/rooms.test.ts',
    code: `import { describe, expect, it } from 'vitest'
import { loopback } from '../fixtures/loopback'

describe('POST /v1/rooms/join', () => {
  it('joins with a valid invite', async () => {
    const { daemon, invite } = await loopback()
    const res = await daemon.post('/v1/rooms/join', { invite })
    expect(res.status).toBe(200)
  })

  it('rejects an expired invite', async () => {
    const { daemon } = await loopback()
    const res = await daemon.post('/v1/rooms/join', { invite: 'mp_expired' })
    expect(res.status).toBe(403)
  })
})
`,
    live: { agent: 'api-tests', from: 11, to: 15, cursorLine: 14, typing: '    expect(res.status).toBe(403)' },
  },
}

/** Contents for any path; files without mock contents get a small stub. */
export function openFile(path: string): OpenFile {
  return files[path] ?? {
    path,
    code: `// ${path}\n// (mock) Nobody in the room is working in this file right now.\n\nexport {}\n`,
  }
}

export const room = {
  name: 'multiplayer-ai',
  relay: 'relay.harness.dev',
  invite: 'harness://join/mp_7Hq2…',
  totals: { agents: agents.length, people: members.length, files: agents.reduce((n, a) => n + a.files.length, 0), conflicts: 1, reviews: 1 },
}
