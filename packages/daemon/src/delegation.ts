// The owner's delegation (D-145): routine decisions harnessd makes for its own human without a click, on this device
// and only within a policy that human wrote in config.toml (never the repo's harness.yaml, D-52). Two decisions can be
// delegated, each for this human's own agents only:
// - publish: approve publishing a finished task whose changes all lie inside its scope, touch no protected path, are
//   few enough, and that the publish gate held nothing of (a dependency manifest, say). The approval binds the exact
//   head and PR text, as a click would (D-114).
// - integrate: once GitHub shows the task's PR clean, its required checks green and an approving review of its exact
//   head by another code owner (reviewRefusal), sign the integrate a click would sign. harnessd re-reads the PR and the base, and the land checks the
//   protections, the checks, the CODEOWNERS reviews of that head and the leases (D-115): nothing is skipped. A PR behind
//   its base is brought up to date instead, once per head and base.
// Never delegated: the repo's setup and test commands, another human's start of a session here (D-34), a held change,
// and GitHub reviews (a review is a reading, not a click). Every delegated decision is written to
// ~/.harness/logs/delegation.jsonl and reported to the coordinator (`delegation.acted`), so both humans see it.
// Revocation: `harness delegation off` (no restart), removing [delegation], or its `until` passing.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { requiredReviewers, type Rule } from './codeowners.ts';
import { ensureDir, type Home } from './home.ts';

export type DelegationAction = 'publish' | 'integrate';
export const DELEGATION_ACTIONS: DelegationAction[] = ['publish', 'integrate'];

export type DelegationPolicy = {
  devices: string[]; projects: string[]; actions: DelegationAction[];
  /** When it lapses: the start (UTC) of the day named in config. */
  until: string;
  /** Paths whose change always needs this human's click, in addition to ALWAYS_PROTECTED. */
  protectedPaths: string[];
  maxFiles: number;
  /** The policy as parsed, hashed: each audit record names the policy it acted under. */
  sha256: string;
};

/**
 * Paths a delegated publish never covers, whatever the policy says: CI and review rules, agent and harness config, and
 * dependency manifests. An entry ending in `/` is a folder at the repo's root; one with no `/` is a file name anywhere.
 */
export const ALWAYS_PROTECTED = ['.github/', '.claude/', '.harness/', '.mcp.json', '.gitmodules', '.gitattributes', 'harness.yaml', 'CODEOWNERS', 'AGENTS.md', 'CLAUDE.md', 'package.json', 'package-lock.json'];
/** A delegation lasts at most this long from when it's loaded: the owner renews it on purpose. */
const MAX_DAYS = 31;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function bad(msg: string): never {
  throw new Error(`config: delegation.${msg}`);
}
function cleanPath(p: unknown): string {
  if (typeof p !== 'string' || !p || p.length > 300 || p.startsWith('/') || /[*?[\]{}\\\u0000-\u001f\u007f]/.test(p)) bad(`protected entries are repo paths like docs/ or a file name: ${JSON.stringify(p)}`);
  if (p.replace(/\/$/, '').split('/').some((s) => s === '' || s === '.' || s === '..')) bad(`protected entry ${JSON.stringify(p)} isn't a normalized relative path`);
  return p;
}

/** `[delegation]` from config.toml, or null when there's none. `projects` must be GitHub-mode projects this config lists. */
export function parseDelegation(v: unknown, githubProjects: string[], now = Date.now()): DelegationPolicy | null {
  if (v === undefined) return null;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('config: [delegation] must be a table');
  const t = v as Record<string, unknown>;
  const unknown = Object.keys(t).filter((k) => !['devices', 'projects', 'actions', 'until', 'protected', 'max_files'].includes(k));
  if (unknown.length) throw new Error(`config: [delegation] has unknown keys: ${unknown.join(', ')}`);
  const ids = (x: unknown, name: string) => {
    if (!Array.isArray(x) || !x.length || !x.every((s) => typeof s === 'string' && ID.test(s))) bad(`${name} must list at least one id`);
    return [...new Set(x as string[])];
  };
  const devices = ids(t.devices, 'devices');
  const projects = ids(t.projects, 'projects');
  for (const p of projects) if (!githubProjects.includes(p)) bad(`projects: ${p} isn't a GitHub-mode project in this config`);
  if (!Array.isArray(t.actions) || !t.actions.length || !t.actions.every((a) => DELEGATION_ACTIONS.includes(a as DelegationAction))) bad(`actions must list some of: ${DELEGATION_ACTIONS.join(', ')}`);
  const actions = [...new Set(t.actions as DelegationAction[])];
  if (typeof t.until !== 'string' || !DAY.test(t.until) || Number.isNaN(Date.parse(`${t.until}T00:00:00Z`))) bad('until must be a date, "YYYY-MM-DD": the delegation lapses at its start (UTC)');
  const until = new Date(`${t.until}T00:00:00Z`).toISOString();
  if (Date.parse(until) - now > MAX_DAYS * 86_400_000) bad(`until is more than ${MAX_DAYS} days away: renew it instead`);
  const extra = t.protected === undefined ? [] : Array.isArray(t.protected) ? t.protected.map(cleanPath) : bad('protected must be a list of paths');
  const maxFiles = t.max_files ?? 40;
  if (!Number.isSafeInteger(maxFiles) || (maxFiles as number) < 1 || (maxFiles as number) > 200) bad('max_files must be a whole number from 1 to 200');
  const shaped = { devices: [...devices].sort(), projects: [...projects].sort(), actions: [...actions].sort(), until, protectedPaths: [...new Set(extra)].sort(), maxFiles: maxFiles as number };
  return { ...shaped, sha256: createHash('sha256').update(JSON.stringify({ v: 1, ...shaped })).digest('hex') };
}

/**
 * Whether a path is one only a click may change. Matched without regard to case: on a Mac's case-insensitive disk
 * `site/Package.json` is the `package.json` npm reads there, and `site/claude.md` the `CLAUDE.md` an agent reads.
 */
export function isProtected(file: string, extra: string[] = []): boolean {
  const f = file.toLowerCase();
  return [...ALWAYS_PROTECTED, ...extra].map((p) => p.toLowerCase()).some((p) => p.endsWith('/') ? f.startsWith(p) : p.includes('/') ? f === p : f === p || f.endsWith(`/${p}`));
}

export type PrReview = { login: string; state: string; commit_id: string };

/**
 * Why a PR's reviews aren't the reading a delegated integrate needs, or null. Each login counts by its latest review
 * that isn't a comment, as GitHub and the land's precheck read them. Every CODEOWNERS owner of a changed path other than
 * this human (`author`) must have approved this exact head; where this human owns every changed path, so that the land
 * would ask for no review at all, another owner named in CODEOWNERS must have. An approval from anyone else (on a public
 * repository anyone can leave one), of another head, or followed by a change request doesn't count.
 */
export function reviewRefusal(rules: Rule[], changed: string[], author: string | null, reviews: PrReview[], head: string): string | null {
  if (!author) return "this human's GitHub login isn't known";
  const latest = new Map<string, PrReview>();
  for (const r of reviews) if (typeof r.login === 'string' && r.login && r.state !== 'COMMENTED') latest.set(r.login.toLowerCase(), r);
  const approved = (who: string) => { const r = latest.get(who.toLowerCase()); return r?.state === 'APPROVED' && r.commit_id === head; };
  const required = requiredReviewers(rules, changed, author);
  const others = required.length ? required : [...new Set(rules.flatMap((r) => r.owners))].filter((o) => o.toLowerCase() !== author.toLowerCase());
  if (!others.length) return 'CODEOWNERS names no other human to review it';
  const objecting = others.filter((o) => latest.get(o.toLowerCase())?.state === 'CHANGES_REQUESTED');
  if (objecting.length) return `${objecting.map((o) => `@${o}`).join(', ')} requested changes`;
  if (required.length) {
    const missing = required.filter((o) => !approved(o));
    return missing.length ? `it needs an approving review of ${head.slice(0, 12)} from ${missing.map((o) => `@${o}`).join(', ')}` : null;
  }
  return others.some(approved) ? null : `no other code owner (${others.map((o) => `@${o}`).join(', ')}) approved ${head.slice(0, 12)}`;
}

/** A scope entry is a folder prefix (`src/api/`) or an exact file (D-21). */
export function inScope(file: string, scope: string[]): boolean {
  return scope.some((s) => s === file || (s.endsWith('/') && file.startsWith(s)));
}

export type DelegationRecord = {
  action: DelegationAction | 'refresh'; project_id: string; task_id: string; head_sha: string; base_sha: string;
  pr_number?: number; land_id?: string; approval_id?: string; files?: number;
};

export class Delegation {
  readonly policy: DelegationPolicy | null;
  readonly deviceId: string;
  readonly revokedFile: string;
  readonly auditFile: string;

  constructor(home: Home, deviceId: string, policy: DelegationPolicy | null) {
    this.policy = policy;
    this.deviceId = deviceId;
    this.revokedFile = path.join(home.root, 'delegation.revoked');
    this.auditFile = path.join(home.logs, 'delegation.jsonl');
  }

  /** Why `action` on `projectId` isn't delegated right now, or null when it is. Read at every decision. */
  refusal(action: DelegationAction, projectId: string, now = Date.now()): string | null {
    const p = this.policy;
    if (!p) return 'there is no [delegation] in config.toml';
    if (fs.existsSync(this.revokedFile)) return 'it was turned off (harness delegation off)';
    if (now >= Date.parse(p.until)) return `it lapsed at ${p.until}`;
    if (!p.devices.includes(this.deviceId)) return `this device (${this.deviceId}) isn't in delegation.devices`;
    if (!p.projects.includes(projectId)) return `${projectId} isn't in delegation.projects`;
    if (!p.actions.includes(action)) return `${action} isn't in delegation.actions`;
    return null;
  }

  /** Why a change isn't routine (outside its task's scope, protected, or too big), or null. */
  changeRefusal(changed: string[], scope: string[]): string | null {
    const p = this.policy;
    if (!p) return 'there is no [delegation] in config.toml';
    if (!scope.length) return 'the task has no scope';
    if (!changed.length) return 'it changes nothing';
    if (changed.length > p.maxFiles) return `it changes ${changed.length} files, more than delegation.max_files (${p.maxFiles})`;
    for (const f of changed) {
      if (!inScope(f, scope)) return `${f} is outside the task's scope`;
      if (isProtected(f, p.protectedPaths)) return `${f} is protected`;
    }
    return null;
  }

  /** Appends one decision to the local audit log (0600), with the policy it was made under. */
  audit(r: DelegationRecord): void {
    ensureDir(path.dirname(this.auditFile));
    fs.appendFileSync(this.auditFile, `${JSON.stringify({ at: new Date().toISOString(), device_id: this.deviceId, policy_sha256: this.policy?.sha256 ?? null, ...r })}\n`, { mode: 0o600 });
  }
}
