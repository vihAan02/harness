// Local approval of repo-controlled commands (D-52). An approval covers a hash of the command text and
// the content of every declared manifest (e.g. package.json and its lockfile), so a change to either
// needs a fresh approval. It's a tripwire: the command still runs sandboxed, which is the real
// boundary (D-69). harnessd writes requests; `harness approve` reads and grants them.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic, type Home } from './home.ts';
import { regularFileIn } from './repo-config.ts';

export type ManifestDigest = { path: string; sha256: string | null }; // null: declared but absent
/** `publish`: pushing a finished task to the public repo, bound to its exact head and PR text (D-114). */
export type ApprovalKind = 'setup' | 'test' | 'publish';
export type ApprovalRequest = {
  id: string; projectId: string; taskId: string; command: string; manifests: ManifestDigest[]; hash: string; requestedAt: string;
  kind?: ApprovalKind; // absent on requests written before 0B: setup
};
type Approved = ApprovalRequest & { approvedAt: string };

function digests(worktree: string, manifests: string[]): ManifestDigest[] {
  return manifests.map((m) => {
    const file = regularFileIn(worktree, m);
    return { path: m, sha256: file ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null };
  });
}

export function setupHash(worktree: string, command: string, manifests: string[]): { hash: string; manifests: ManifestDigest[] } {
  const d = digests(worktree, manifests);
  const hash = createHash('sha256').update(JSON.stringify({ v: 1, command, manifests: d })).digest('hex');
  return { hash, manifests: d };
}

/** The test command's approval (D-51). Its hash includes the kind, so approving a setup command never approves the same text as a test. */
export function testHash(worktree: string, command: string, manifests: string[]): { hash: string; manifests: ManifestDigest[] } {
  const d = digests(worktree, manifests);
  const hash = createHash('sha256').update(JSON.stringify({ v: 1, kind: 'test', command, manifests: d })).digest('hex');
  return { hash, manifests: d };
}

export class Approvals {
  home: Home;
  constructor(home: Home) {
    this.home = home;
  }

  isApproved(projectId: string, hash: string): boolean {
    return Boolean(readJson<Record<string, Approved>>(this.home.approvals, {})[`${projectId}:${hash}`]);
  }

  /** Records a request for the human; one per (project, hash), whichever task asked first. */
  request(r: Omit<ApprovalRequest, 'id' | 'requestedAt'>): ApprovalRequest {
    const req: ApprovalRequest = { ...r, id: r.hash.slice(0, 12), requestedAt: new Date().toISOString() };
    const file = path.join(this.home.pending, `${req.projectId}-${req.id}.json`);
    if (!fs.existsSync(file)) writeJsonAtomic(file, req);
    return readJson<ApprovalRequest>(file, req);
  }

  pending(): ApprovalRequest[] {
    ensureDir(this.home.pending);
    return fs.readdirSync(this.home.pending).filter((f) => f.endsWith('.json'))
      .map((f) => readJson<ApprovalRequest | null>(path.join(this.home.pending, f), null))
      .filter((r): r is ApprovalRequest => r !== null)
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  /** Grants a pending request by its id (or a unique prefix of it). */
  approve(id: string): ApprovalRequest {
    const matches = this.pending().filter((r) => r.id.startsWith(id));
    if (matches.length !== 1) throw new Error(matches.length ? `${id} matches more than one request` : `no pending approval ${id}`);
    const req = matches[0]!;
    const all = readJson<Record<string, Approved>>(this.home.approvals, {});
    writeJsonAtomic(this.home.approvals, { ...all, [`${req.projectId}:${req.hash}`]: { ...req, approvedAt: new Date().toISOString() } });
    fs.rmSync(path.join(this.home.pending, `${req.projectId}-${req.id}.json`), { force: true });
    return req;
  }
}
