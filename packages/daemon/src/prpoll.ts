// Polling GitHub for a GitHub-mode project (D-114): no webhooks in the pilot. Each tick, bounded and backing off on
// errors:
// - the base: every daemon reads the remote base's tip (`ls-remote`). When it differs from the coordinator's chain, it
//   fetches it and reports the move (`base.observe`) with the files it changed and their new blobs. The coordinator
//   moves its chain by compare-and-swap, so many daemons reporting the same move do it once; a move the harness made
//   is already known, and one it didn't make is noticed like a land.
// - the task's PRs: the device that published a task's PR polls it (head, state, checks, reviews, mergeability) and
//   reports only changes (`pr.status`). A PR merged on GitHub without the harness is reported as `land.external`.
import { changedBetween, blobsAt } from './integrate.ts';
import { fetchBase, fetchPullHead, gitRemote, lsRemoteBase } from './remote.ts';
import { verifySquash } from './integrate-remote.ts';
import type { GitHubClient } from './github.ts';
import type { ProjectConfig } from './config.ts';
import type { ProjectView } from './view.ts';
import type { ChangedBlob, CheckConclusion } from '@harness/protocol';

export type PollerDeps = {
  projects: () => ProjectConfig[]; // the GitHub-mode ones
  view: (projectId: string) => ProjectView;
  deviceId: string;
  github: (p: ProjectConfig) => GitHubClient;
  send: (projectId: string, name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Moves harnessd's own base ref after a fetch (D-114). */
  advanceBase: (p: ProjectConfig, tip: string) => Promise<void>;
  log: (msg: string) => void;
  intervalMs?: number;
  /** How long another device's GitHub land waits, its device silent, before this one settles it (D-115). Default 10 min. */
  reconcileAfterMs?: number;
};

const ZERO = '0'.repeat(40);
const CONCLUSIONS: CheckConclusion[] = ['success', 'failure', 'pending', 'neutral', 'skipped', 'cancelled'];

/** The files `to` changed since `from`, with their blobs at `to` (null: deleted), as land.complete carries them. */
export async function changedBlobsBetween(repo: string, from: string, to: string): Promise<ChangedBlob[]> {
  const paths = await changedBetween(repo, from, to);
  const blobs = await blobsAt(repo, to, paths);
  return paths.map((path) => ({ path, new_hash: blobs.get(path) ?? null }));
}

export class Poller {
  d: PollerDeps;
  timer: NodeJS.Timeout | null = null;
  running: Promise<void> | null = null;
  stopped = false;
  failures = 0;
  /** Per project: the base tip the coordinator last acknowledged (applied, known or seeded), or the one it said is current. */
  serverTip = new Map<string, string>();

  constructor(d: PollerDeps) {
    this.d = d;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const every = this.d.intervalMs ?? 60_000;
    const loop = () => {
      // Backs off on errors, up to ten minutes; a tick never overlaps the last one.
      const wait = this.failures ? Math.min(every * 2 ** this.failures, 600_000) : every;
      this.timer = setTimeout(() => { this.running = this.tick().finally(() => { this.running = null; if (!this.stopped) loop(); }); }, wait);
      this.timer.unref?.();
    };
    this.running = this.tick().finally(() => { this.running = null; if (!this.stopped) loop(); });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  /** One round over every GitHub-mode project. Errors are logged and back the poller off; nothing is retried in a loop. */
  async tick(): Promise<void> {
    let failed = false;
    for (const p of this.d.projects()) {
      if (this.stopped) return;
      try {
        await this.pollBase(p);
        await this.pollPrs(p);
        await this.pollPeerLands(p);
      } catch (e) {
        failed = true;
        this.d.log(`polling ${p.id}: ${(e as Error).message}`);
      }
    }
    this.failures = failed ? Math.min(this.failures + 1, 6) : 0;
  }

  async pollBase(p: ProjectConfig): Promise<void> {
    const tip = await lsRemoteBase(p.repo, p.remote!, p.baseBranch);
    if (this.serverTip.get(p.id) === tip) return;
    await fetchBase(p.repo, p.remote!, p.baseBranch, p.id);
    await this.d.advanceBase(p, tip);
    // Report from the coordinator's tip as we know it; a `stale` answer names the real one, and we go again from there.
    for (let i = 0; i < 3; i++) {
      const old = this.serverTip.get(p.id) ?? ZERO;
      const changed = old === ZERO ? [] : await changedBlobsBetween(p.repo, old, tip);
      const r = await this.d.send(p.id, 'base.observe', { old_sha: old === tip ? ZERO : old, new_sha: tip, changed }) as { status: string; tip?: string };
      if (r.status === 'stale' && r.tip) { this.serverTip.set(p.id, r.tip); continue; }
      if (r.status !== 'parked') this.serverTip.set(p.id, tip); // parked: report again next tick, once the merge resolves
      if (r.status === 'applied') this.d.log(`${p.baseBranch} moved outside the harness to ${tip.slice(0, 12)}`);
      return;
    }
  }

  async pollPrs(p: ProjectConfig): Promise<void> {
    const view = this.d.view(p.id);
    const gh = this.d.github(p);
    for (const pr of view.prs.values()) {
      if (pr.deviceId !== this.d.deviceId || pr.state !== 'open' || pr.merged) continue;
      const live = await gh.pull(pr.prNumber);
      const [checks, reviews] = await Promise.all([gh.checkRuns(live.head.sha), gh.reviews(pr.prNumber)]);
      const conclusions: Record<string, CheckConclusion> = {};
      for (const c of checks) {
        const v = c.status !== 'completed' ? 'pending' : (c.conclusion ?? 'pending');
        conclusions[c.name] = CONCLUSIONS.includes(v as CheckConclusion) ? v as CheckConclusion : 'failure';
      }
      await this.d.send(p.id, 'pr.status', {
        task_id: pr.taskId, pr_number: pr.prNumber, head_sha: live.head.sha, state: live.state, merged: live.merged,
        ...(live.merged && live.merge_commit_sha ? { merge_sha: live.merge_commit_sha } : {}),
        mergeable_state: /^[a-z_]{1,40}$/.test(live.mergeable_state ?? '') ? live.mergeable_state : 'unknown', checks: conclusions,
        reviews: reviews.filter((r) => r.user && /^[A-Za-z0-9-]{1,39}$/.test(r.user.login) && ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(r.state))
          .map((r) => ({ login: r.user!.login, state: r.state, commit_id: r.commit_id })),
      });
      // Merged on GitHub, and no harness land is in flight for it: a merge outside the harness (D-115's honest limit).
      const inFlight = [...view.lands.values()].some((l) => l.taskId === pr.taskId && (l.status === 'requested' || l.status === 'accepted'));
      if (live.merged && live.merge_commit_sha && !inFlight) await this.reportExternal(p, pr.taskId, pr.prNumber, live.merge_commit_sha);
    }
  }

  /**
   * D-115: a GitHub land whose device has been offline past the threshold (asleep mid-merge, say) is settled here from
   * GitHub's evidence, read with this human's own login, so a reservation never outlives its device. The coordinator
   * checks the silence too, from the heartbeats. Merged: with the squash check, so a merge that isn't the approved head
   * on the approved base is reported as such and never lands. Not merged: the land fails and the reservation goes.
   */
  async pollPeerLands(p: ProjectConfig): Promise<void> {
    const view = this.d.view(p.id);
    const after = this.d.reconcileAfterMs ?? 10 * 60_000;
    for (const land of view.lands.values()) {
      if (land.mode !== 'github' || (land.status !== 'requested' && land.status !== 'accepted') || land.deviceId === this.d.deviceId) continue;
      const presence = view.devices.get(land.deviceId);
      if (!land.prNumber || !land.approvedHead || !land.approvedBase || !presence || presence.online || Date.now() - Date.parse(presence.at) < after) continue;
      const pr = await this.d.github(p).pull(land.prNumber);
      const tip = await fetchBase(p.repo, p.remote!, p.baseBranch, p.id);
      await this.d.advanceBase(p, tip);
      const args: Record<string, unknown> = { land_id: land.id, pr_number: land.prNumber, observed_head_sha: pr.head.sha, observed_base_sha: tip, merged: false, state: pr.state };
      if (pr.merged && pr.merge_commit_sha) {
        const merge = pr.merge_commit_sha;
        if (!(await gitRemote(p.repo, 'merge-base', '--is-ancestor', merge, tip).then(() => true, () => false))) continue; // not on the base we fetched yet
        await fetchPullHead(p.repo, p.remote!, p.id, land.prNumber); // the approved head, for the tree check
        const v = await verifySquash(p.repo, merge, land.approvedBase, land.approvedHead);
        Object.assign(args, { merged: true, merge_sha: merge, verified: v.ok, changed: await changedBlobsBetween(p.repo, v.parent, merge) });
      }
      const r = await this.d.send(p.id, 'land.reconcile', args) as { status: string; reason?: string };
      this.d.log(`settled ${land.taskId}'s land for ${land.deviceId}, offline since ${presence.at}: PR #${land.prNumber} ${pr.merged ? 'merged' : pr.state}; the land ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
    }
  }

  async reportExternal(p: ProjectConfig, taskId: string, prNumber: number, merge: string): Promise<void> {
    const tip = await fetchBase(p.repo, p.remote!, p.baseBranch, p.id);
    await this.d.advanceBase(p, tip);
    // Only a commit that's on the base we fetched ourselves (never one the API merely names).
    if (!(await gitRemote(p.repo, 'merge-base', '--is-ancestor', merge, tip).then(() => true, () => false))) return;
    const parent = await gitRemote(p.repo, 'rev-parse', `${merge}^1`);
    const r = await this.d.send(p.id, 'land.external', { task_id: taskId, pr_number: prNumber, merge_sha: merge, old_base_sha: parent, changed: await changedBlobsBetween(p.repo, parent, merge) }) as { status: string };
    if (r.status === 'landed') this.d.log(`${taskId}'s PR #${prNumber} was merged outside the harness; landed as ${merge.slice(0, 12)}`);
    if (r.status === 'not_approved') this.d.log(`${taskId}'s PR #${prNumber} was merged as ${merge.slice(0, 12)}, which isn't the approved squash: ${taskId} isn't landed`);
  }
}
