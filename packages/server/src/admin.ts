// Provisioning for the two-Mac pilot (D-110, D-111; acceptance 1): the humans, each device's public key, the project,
// its memberships and its device-bound agents, from one reviewed file, idempotently and with no hand-written SQL. The
// coordinator's operator runs it (`npm run admin -- apply <pilot.toml>`, scripts/pilot/admin.ts). Device keys are
// pinned from fingerprints read aloud (D-111): an existing device's key changes only with an explicit rotate, a
// device never changes hands, and a revoke ends its connections at their next message.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { fingerprint, generateKeyPair, parsePrivateKey, parsePublicKey, publicKeyText } from '@harness/protocol/signing';
import { AGENT_NAME } from './agents.ts';
import { inTransaction } from './db.ts';
import { appendEvents, notifyProject } from './events.ts';

export type PilotSpec = {
  humans: { id: string; display_name: string; github_login: string | null }[];
  devices: { id: string; human: string; name: string; public_key: string }[];
  projects: { id: string; name: string; repo_url: string | null; default_branch: string; integration_mode: 'local' | 'github' | null }[];
  memberships: { project: string; human: string; role: 'owner' | 'member' | 'viewer' }[];
  agents: { project: string; name: string; human: string; device: string; vendor: 'claude' | 'codex' }[];
};
export type ApplyOptions = { rotate?: string[]; revoke?: string[] };
export type ApplyReport = { changes: string[]; fingerprints: { device_id: string; human: string; fingerprint: string }[] };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const ROLES = ['owner', 'member', 'viewer'];
const VENDORS = ['claude', 'codex'];

/** Checks a pilot file as parsed (TOML or JSON): known keys only, well-formed ids and keys, every reference resolved. */
export function parsePilot(raw: unknown): PilotSpec {
  const bad = (m: string): never => { throw new Error(`pilot: ${m}`); };
  const table = (v: unknown, where: string): Record<string, unknown> =>
    (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : bad(`${where} must be a table`));
  const only = (t: Record<string, unknown>, keys: string[], where: string) => {
    const extra = Object.keys(t).filter((k) => !keys.includes(k));
    if (extra.length) bad(`${where}: unknown ${extra.length > 1 ? 'keys' : 'key'} ${extra.join(', ')}`);
  };
  const list = (v: unknown, where: string) => (v === undefined ? [] : Array.isArray(v) ? v.map((x, i) => table(x, `${where}[${i}]`)) : bad(`${where} must be a list of tables`));
  const id = (v: unknown, where: string) => (typeof v === 'string' && ID.test(v) ? v : bad(`${where} must match ${ID}`));
  const text = (v: unknown, where: string, max = 200) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : bad(`${where} must be 1 to ${max} characters`));
  const top = table(raw, 'the file');
  only(top, ['humans', 'devices', 'projects', 'memberships', 'agents'], 'the file');

  const humans = list(top.humans, 'humans').map((h, i) => {
    only(h, ['id', 'display_name', 'github_login'], `humans[${i}]`);
    const login = h.github_login === undefined ? null : typeof h.github_login === 'string' && GITHUB_LOGIN.test(h.github_login) ? h.github_login : bad(`humans[${i}].github_login is malformed`);
    return { id: id(h.id, `humans[${i}].id`), display_name: text(h.display_name, `humans[${i}].display_name`), github_login: login };
  });
  const devices = list(top.devices, 'devices').map((d, i) => {
    only(d, ['id', 'human', 'name', 'public_key'], `devices[${i}]`);
    let key: string;
    try { key = publicKeyText(parsePublicKey(String(d.public_key))); } catch { return bad(`devices[${i}].public_key must be an Ed25519 key, ed25519:<base64 SPKI>`); }
    return { id: id(d.id, `devices[${i}].id`), human: id(d.human, `devices[${i}].human`), name: text(d.name, `devices[${i}].name`), public_key: key };
  });
  const projects = list(top.projects, 'projects').map((p, i) => {
    only(p, ['id', 'name', 'repo_url', 'default_branch', 'integration_mode'], `projects[${i}]`);
    const mode: 'local' | 'github' | null = p.integration_mode === undefined ? null : p.integration_mode === 'local' || p.integration_mode === 'github' ? p.integration_mode : bad(`projects[${i}].integration_mode must be "local" or "github"`);
    const branch = p.default_branch === undefined ? 'main' : typeof p.default_branch === 'string' && BRANCH.test(p.default_branch) ? p.default_branch : bad(`projects[${i}].default_branch is malformed`);
    return { id: id(p.id, `projects[${i}].id`), name: text(p.name, `projects[${i}].name`), repo_url: p.repo_url === undefined ? null : text(p.repo_url, `projects[${i}].repo_url`, 500), default_branch: branch, integration_mode: mode };
  });
  const memberships = list(top.memberships, 'memberships').map((m, i) => {
    only(m, ['project', 'human', 'role'], `memberships[${i}]`);
    if (typeof m.role !== 'string' || !ROLES.includes(m.role)) bad(`memberships[${i}].role must be one of ${ROLES.join(', ')}`);
    return { project: id(m.project, `memberships[${i}].project`), human: id(m.human, `memberships[${i}].human`), role: m.role as PilotSpec['memberships'][number]['role'] };
  });
  const agents = list(top.agents, 'agents').map((a, i) => {
    only(a, ['project', 'name', 'human', 'device', 'vendor'], `agents[${i}]`);
    if (typeof a.name !== 'string' || !AGENT_NAME.test(a.name)) bad(`agents[${i}].name must look like agent/backend-1`);
    const vendor = a.vendor === undefined ? 'claude' : typeof a.vendor === 'string' && VENDORS.includes(a.vendor) ? a.vendor : bad(`agents[${i}].vendor must be one of ${VENDORS.join(', ')}`);
    return { project: id(a.project, `agents[${i}].project`), name: a.name as string, human: id(a.human, `agents[${i}].human`), device: id(a.device, `agents[${i}].device`), vendor: vendor as 'claude' | 'codex' };
  });

  const unique = (ids: string[], what: string) => { const seen = new Set<string>(); for (const x of ids) { if (seen.has(x)) bad(`${what} ${x} appears twice`); seen.add(x); } };
  unique(humans.map((h) => h.id), 'human');
  unique(devices.map((d) => d.id), 'device');
  for (const d of devices) {
    const other = devices.find((x) => x.id !== d.id && x.public_key === d.public_key);
    if (other) bad(`devices ${d.id} and ${other.id} have the same key; each device makes its own (harness setup keygen)`);
  }
  unique(projects.map((p) => p.id), 'project');
  unique(memberships.map((m) => `${m.project}/${m.human}`), 'membership');
  unique(agents.map((a) => `${a.project}/${a.name}`), 'agent');
  const human = new Set(humans.map((h) => h.id));
  const project = new Set(projects.map((p) => p.id));
  for (const d of devices) if (!human.has(d.human)) bad(`device ${d.id} belongs to ${d.human}, who isn't in [[humans]]`);
  for (const m of memberships) {
    if (!project.has(m.project)) bad(`a membership names project ${m.project}, which isn't in [[projects]]`);
    if (!human.has(m.human)) bad(`a membership names ${m.human}, who isn't in [[humans]]`);
  }
  for (const a of agents) {
    const role = memberships.find((m) => m.project === a.project && m.human === a.human)?.role;
    if (!role || role === 'viewer') bad(`${a.name}'s human ${a.human} must be an owner or member of ${a.project}`);
    const device = devices.find((d) => d.id === a.device);
    if (!device) bad(`${a.name} runs on ${a.device}, which isn't in [[devices]]`);
    if (device!.human !== a.human) bad(`${a.name} is ${a.human}'s, but ${a.device} is ${device!.human}'s: an agent runs on its own human's device (D-113)`);
  }
  return { humans, devices, projects, memberships, agents };
}

/**
 * Applies a pilot file in one transaction, under an advisory lock: creates what's missing and updates names, never
 * deletes. An agent created here is logged as `agent.created`, so every client's view learns it. Returns what changed
 * and each device's fingerprint, for the humans to read aloud.
 */
export async function applyPilot(pool: pg.Pool, spec: PilotSpec, o: ApplyOptions = {}): Promise<ApplyReport> {
  const rotate = new Set(o.rotate ?? []);
  const revoke = new Set(o.revoke ?? []);
  for (const d of [...rotate, ...revoke]) if (!spec.devices.some((x) => x.id === d)) throw new Error(`pilot: ${d} isn't in [[devices]]`);
  return inTransaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('harness.admin'))");
    const changes: string[] = [];
    for (const h of spec.humans) {
      const row = (await tx.query<{ display_name: string; github_login: string | null }>('SELECT display_name, github_login FROM human_principals WHERE id = $1', [h.id])).rows[0];
      if (!row) {
        await tx.query('INSERT INTO human_principals (id, display_name, github_login) VALUES ($1, $2, $3)', [h.id, h.display_name, h.github_login]);
        changes.push(`human ${h.id}: created`);
      } else if (row.display_name !== h.display_name || row.github_login !== h.github_login) {
        await tx.query('UPDATE human_principals SET display_name = $2, github_login = $3 WHERE id = $1', [h.id, h.display_name, h.github_login]);
        changes.push(`human ${h.id}: updated`);
      }
    }
    for (const d of spec.devices) {
      const row = (await tx.query<{ human_id: string; name: string; public_key: string | null; revoked_at: Date | null }>(
        'SELECT human_id, name, public_key, revoked_at FROM devices WHERE id = $1 FOR UPDATE', [d.id])).rows[0];
      if (!row) {
        if (revoke.has(d.id)) throw new Error(`pilot: ${d.id} doesn't exist yet; add it before revoking it`);
        await tx.query('INSERT INTO devices (id, human_id, name, public_key) VALUES ($1, $2, $3, $4)', [d.id, d.human, d.name, d.public_key]);
        changes.push(`device ${d.id}: created for ${d.human}`);
        continue;
      }
      if (row.human_id !== d.human) throw new Error(`pilot: device ${d.id} is ${row.human_id}'s; a device never changes hands (register a new one)`);
      const current = row.public_key === null ? null : publicKeyText(parsePublicKey(row.public_key));
      if (current !== d.public_key) {
        if (!rotate.has(d.id)) throw new Error(`pilot: device ${d.id}'s key differs from the registered one (${current ? fingerprint(current) : 'none'}); check its fingerprint aloud, then apply with --rotate ${d.id}`);
        await tx.query('UPDATE devices SET public_key = $2, revoked_at = NULL WHERE id = $1', [d.id, d.public_key]);
        changes.push(`device ${d.id}: key rotated`);
      }
      if (row.name !== d.name) {
        await tx.query('UPDATE devices SET name = $2 WHERE id = $1', [d.id, d.name]);
        changes.push(`device ${d.id}: renamed`);
      }
      if (revoke.has(d.id) && row.revoked_at === null) {
        await tx.query('UPDATE devices SET revoked_at = now() WHERE id = $1', [d.id]);
        changes.push(`device ${d.id}: revoked`);
      }
    }
    // projects.integration_mode arrives with PA5b's migration 0016; until then a project can only be local.
    const hasMode = !!(await tx.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'projects' AND column_name = 'integration_mode'")).rowCount;
    for (const p of spec.projects) {
      if (p.integration_mode === 'github' && !hasMode) throw new Error(`pilot: project ${p.id} wants integration_mode = "github", which needs migration 0016 (PA5b) on this coordinator`);
      const row = (await tx.query<{ name: string; repo_url: string | null; default_branch: string; mode: string | null }>(
        `SELECT name, repo_url, default_branch, ${hasMode ? 'integration_mode' : 'NULL'} AS mode FROM projects WHERE id = $1 FOR UPDATE`, [p.id])).rows[0];
      if (!row) {
        await tx.query('INSERT INTO projects (id, name, repo_url, default_branch) VALUES ($1, $2, $3, $4)', [p.id, p.name, p.repo_url, p.default_branch]);
        changes.push(`project ${p.id}: created`);
      } else if (row.name !== p.name || row.repo_url !== p.repo_url || row.default_branch !== p.default_branch) {
        await tx.query('UPDATE projects SET name = $2, repo_url = $3, default_branch = $4 WHERE id = $1', [p.id, p.name, p.repo_url, p.default_branch]);
        changes.push(`project ${p.id}: updated`);
      }
      if (hasMode && p.integration_mode && row?.mode !== p.integration_mode) {
        await tx.query('UPDATE projects SET integration_mode = $2 WHERE id = $1', [p.id, p.integration_mode]);
        changes.push(`project ${p.id}: integration_mode ${p.integration_mode}`);
      }
    }
    for (const m of spec.memberships) {
      const role = (await tx.query<{ role: string }>('SELECT role FROM project_memberships WHERE project_id = $1 AND human_id = $2', [m.project, m.human])).rows[0]?.role;
      if (role === m.role) continue;
      await tx.query(
        `INSERT INTO project_memberships (project_id, human_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (project_id, human_id) DO UPDATE SET role = EXCLUDED.role`, [m.project, m.human, m.role]);
      changes.push(`${m.human} in ${m.project}: ${role ? `${role} → ` : ''}${m.role}`);
    }
    const touched = new Set<string>();
    for (const a of spec.agents) {
      const row = (await tx.query<{ id: string; accountable_human_id: string; device_id: string | null; vendor: string }>(
        'SELECT id, accountable_human_id, device_id, vendor FROM agent_principals WHERE project_id = $1 AND name = $2 FOR UPDATE', [a.project, a.name])).rows[0];
      if (row) {
        if (row.accountable_human_id !== a.human) throw new Error(`pilot: ${a.name} in ${a.project} is ${row.accountable_human_id}'s; an agent never changes hands`);
        if (row.device_id !== a.device) throw new Error(`pilot: ${a.name} in ${a.project} runs on ${row.device_id ?? 'no device'}; it never moves (add a new agent for ${a.device})`);
        if (row.vendor !== a.vendor) throw new Error(`pilot: ${a.name} in ${a.project} is a ${row.vendor} agent; its vendor never changes`);
        continue;
      }
      const id = `agent_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
      await tx.query(
        'INSERT INTO agent_principals (id, project_id, accountable_human_id, vendor, name, device_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, a.project, a.human, a.vendor, a.name, a.device]);
      await appendEvents(tx, a.project, [{
        kind: 'agent.created', actor: a.human,
        data: { agent_id: id, name: a.name, vendor: a.vendor, accountable_human_id: a.human, device_id: a.device },
      }]);
      touched.add(a.project);
      changes.push(`agent ${a.name} in ${a.project}: created on ${a.device}`);
    }
    for (const p of touched) await notifyProject(tx, p);
    return {
      changes,
      fingerprints: spec.devices.map((d) => ({ device_id: d.id, human: d.human, fingerprint: fingerprint(d.public_key) })),
    };
  });
}

/**
 * The coordinator's key: created once, owner-only, never overwritten (D-111). Returns its public key and fingerprint
 * for every device to pin, read aloud.
 */
export function ensureServerKey(file: string): { publicKey: string; fingerprint: string; created: boolean } {
  let created = false;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, generateKeyPair().privateKeyPem, { mode: 0o600, flag: 'wx' });
    created = true;
  }
  if (fs.statSync(file).mode & 0o077) throw new Error(`${file} must not be readable by others: chmod 600 ${file}`);
  const publicKey = publicKeyText(parsePrivateKey(fs.readFileSync(file, 'utf8')));
  return { publicKey, fingerprint: fingerprint(publicKey), created };
}
