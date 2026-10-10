// Integrating a task's PR through GitHub (D-115): the human approved one exact head on one exact base; harnessd, on
// that human's device and with their GitHub login, merges that head and nothing else. In order:
// 1. pre-check, read from GitHub itself: the base's protections (squash only, strict, the required checks), the PR's
//    base, head branch and head; the base's tip by ls-remote; mergeability; the reviews CODEOWNERS requires at the
//    base; and no other PR's CI in flight (AGENTS.md's one-PR rule). Any miss fails the land, which nothing armed;
// 2. `land`: the coordinator fences the changed paths against leases, under its lease lock; the reservation is active;
// 3. `land.arm`: the coordinator's last word. From here the land can't be cancelled, and fails only on GitHub's evidence;
// 4. the merge request: squash, bound to the approved head (`sha`). Its answer, or a later read of the PR, is the outcome;
//    a timeout or a 5xx is `outcome_unknown`, reconciled from GitHub, never released by a timer;
// 5. the merged commit counts only if its parent is the approved base and its tree is the approved head's;
// 6. land.complete; then the task's worktree and branch go, only if nothing changed since (never by ancestry: a squash
//    shares none with the task's branch).
// Each step is journaled before it runs, so a restart reconciles instead of guessing.
import fs from 'node:fs';
import { git, taskBranch } from './git.ts';
import { GitHubError, type GitHubClient, type PullRequest } from './github.ts';
import { codeownersAt, requiredReviewers } from './codeowners.ts';
import { changedBlobsBetween } from './prpoll.ts';
import { fetchBase, gitRemote, lsRemoteBase } from './remote.ts';
import type { Daemon } from './daemon.ts';
import type { ProjectConfig } from './config.ts';
import type { LandInfo } from './view.ts';
import { checkDispatch } from './dispatch.ts';
import { pathsSha256 } from '@harness/protocol/signing';
import type { DispatchEnvelope } from '@harness/protocol';

const REQUIRED_CHECKS = ['guard', 'unit-linux', 'full-macos'];
/** Reads of a PR whose mergeability GitHub hasn't computed yet: about a minute. */
const MERGEABLE_TRIES = 6;

export class LandFailure extends Error {
  reason: string;
  constructor(reason: string, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

type Ctx = { d: Daemon; project: ProjectConfig; land: LandInfo; gh: GitHubClient; head: string; base: string; pr: number; branch: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * D-112 for a merge: its integrate dispatch, checked against this device's own pins. Only the agent's accountable human,
 * this device's own, may approve it, for exactly this PR, head and base. Null where dispatches aren't required.
 */
function acceptIntegrate(c: Ctx): DispatchEnvelope | null {
  if (!c.project.requireDispatch) return null;
  const view = c.d.view(c.project.id);
  const task = view.tasks.get(c.land.taskId);
  if (!task?.assignee) throw new LandFailure('dispatch_rejected', `${c.land.taskId} has no agent`);
  const j = c.d.journal();
  const records = j.read(c.project.id, c.land.taskId);
  const seq = c.land.requestedSeq ?? 0;
  const v = checkDispatch(c.land.dispatch, 'integrate', {
    trusted: c.d.config.trustedDevices, deviceId: c.d.config.deviceId, epoch: c.d.link?.epoch ?? null, now: new Date(), projectId: c.project.id,
    task: { id: task.id, title: task.title, text: task.text, scope: task.scope, ownerHumanId: task.ownerHumanId }, agentId: task.assignee,
    usedAt: (nonce) => { const r = records.find((x) => x.state === 'dispatch' && x.nonce === nonce); return r ? Number(r.seq) : null; }, seq,
  });
  if (!v.ok) throw new LandFailure('dispatch_rejected', `the integrate dispatch was refused here (${v.reason}): ${v.detail}`);
  const env = v.envelope;
  if (env.issuer_human_id !== c.d.config.principal) throw new LandFailure('dispatch_rejected', `only ${c.d.config.principal} integrates ${c.land.taskId} on this device (D-112)`);
  const i = env.integrate!;
  if (i.pr_number !== c.pr || i.head_sha !== c.head || i.base_sha !== c.base) throw new LandFailure('dispatch_rejected', 'the integrate dispatch names another PR, head or base');
  if (!records.some((r) => r.state === 'dispatch' && r.nonce === env.nonce)) j.append(c.project.id, c.land.taskId, 'dispatch', { nonce: env.nonce, kind: 'integrate', seq, land_id: c.land.id });
  return env;
}

/** Runs (or, after a restart, resumes) a GitHub-mode land on this device. */
export async function integrateRemote(d: Daemon, projectId: string, landId: string): Promise<void> {
  const project = d.project(projectId);
  const land = d.view(projectId).lands.get(landId);
  if (!land || land.mode !== 'github' || !land.prNumber || !land.approvedHead || !land.approvedBase) throw new Error(`${landId} is not a GitHub land this device can run`);
  const c: Ctx = { d, project, land, gh: d.github(project), head: land.approvedHead, base: land.approvedBase, pr: land.prNumber, branch: d.remoteBranch(projectId, land.taskId) };
  const j = d.journal();
  const steps = new Set(j.read(projectId, land.taskId).filter((r) => r.land_id === landId).map((r) => r.state));
  // Armed before a restart (or the server says so): only GitHub can say what happened.
  if (steps.has('merge_requested') || land.step === 'merge_requested' || land.step === 'outcome_unknown') return reconcile(c);
  if (land.status === 'accepted') {
    // Accepted, never armed: nothing reached GitHub. Fail it; the human approves again.
    return fail(c, 'interrupted', 'harnessd restarted before the merge was requested; nothing was merged');
  }
  try {
    const approved = acceptIntegrate(c);
    j.append(projectId, land.taskId, 'integrating', { land_id: landId, head: c.head, base: c.base, pr: c.pr });
    const changed = await precheck(c);
    // The paths the human's dispatch covers are the ones this merge changes (D-112).
    if (approved && pathsSha256(changed) !== approved.integrate!.paths_sha256) {
      throw new LandFailure('dispatch_rejected', `the changed paths of ${c.head.slice(0, 12)} on ${c.base.slice(0, 12)} aren't the ones its human approved`);
    }
    const r = await d.link!.command(projectId, 'land', {
      land_id: landId, base_branch: project.baseBranch, base_sha: c.base, merge_base_sha: c.base, head_sha: c.head,
      changed_paths: changed, lease_tokens: d.leases.tokens(projectId, land.taskId),
    });
    if (!(r.result as { accepted?: boolean }).accepted) {
      d.log(`integration of ${land.taskId} refused by the fencing check: ${JSON.stringify((r.result as { problems?: unknown }).problems)}`);
      return;
    }
    j.append(projectId, land.taskId, 'arming', { land_id: landId });
    await d.o.faults?.beforeArm?.(); // tests only: the base moves between the reservation and the arm
    await d.link!.command(projectId, 'land.arm', { land_id: landId, head_sha: c.head, base_sha: c.base });
  } catch (e) {
    if (e instanceof LandFailure) return fail(c, e.reason, e.message);
    return fail(c, /base_moved/.test((e as Error).message) ? 'base_moved' : 'error', (e as Error).message);
  }
  // Armed. From here, every path ends in GitHub's evidence.
  j.append(projectId, land.taskId, 'merge_requested', { land_id: landId });
  d.crashPoint('after_merge_request');
  return mergeAndSettle(c);
}

async function report(c: Ctx, step: string): Promise<void> {
  await c.d.link!.command(c.project.id, 'land.report', { land_id: c.land.id, step });
}

async function fail(c: Ctx, reason: string, detail: string, evidence?: Record<string, unknown>): Promise<void> {
  c.d.journal().append(c.project.id, c.land.taskId, 'integration_failed', { land_id: c.land.id, reason });
  c.d.log(`integration of ${c.land.taskId} failed (${reason}): ${detail}`);
  await c.d.report(c.project.id, 'land.fail', { land_id: c.land.id, reason, detail: detail.slice(0, 1000), ...(evidence ? { evidence } : {}) }).catch((e: Error) => c.d.log(`land.fail: ${e.message}`));
}

/** Step 1: everything read from GitHub. Returns the changed paths. Throws LandFailure with a reason. */
async function precheck(c: Ctx): Promise<string[]> {
  const rules = await c.gh.branchRules(c.project.baseBranch);
  const pullRule = rules.find((r) => r.type === 'pull_request');
  const checksRule = rules.find((r) => r.type === 'required_status_checks');
  const methods = (pullRule?.parameters?.allowed_merge_methods as string[] | undefined) ?? [];
  const strict = checksRule?.parameters?.strict_required_status_checks_policy === true;
  const contexts = ((checksRule?.parameters?.required_status_checks as { context: string }[] | undefined) ?? []).map((x) => x.context);
  if (!pullRule || methods.length !== 1 || methods[0] !== 'squash' || !strict || !REQUIRED_CHECKS.every((x) => contexts.includes(x))) {
    throw new LandFailure('protection_missing', `${c.project.baseBranch} isn't protected as the pilot needs (PRs only, squash only, strict, ${REQUIRED_CHECKS.join(', ')})`);
  }
  const pr = await settledPull(c);
  if (pr.base.ref !== c.project.baseBranch) throw new LandFailure('wrong_base', `PR #${c.pr} targets ${pr.base.ref}`);
  if (pr.head.ref !== c.branch || pr.head.repo?.full_name.toLowerCase() !== c.project.githubRepo!.toLowerCase()) throw new LandFailure('wrong_base', `PR #${c.pr} isn't ${c.branch} in ${c.project.githubRepo}`);
  if (pr.state !== 'open' || pr.merged) throw new LandFailure('pr_closed', `PR #${c.pr} is ${pr.merged ? 'merged' : 'closed'}`);
  if (pr.head.sha !== c.head) throw new LandFailure('head_changed', `PR #${c.pr}'s head is ${pr.head.sha.slice(0, 12)}, not the approved ${c.head.slice(0, 12)}`);
  const tip = await lsRemoteBase(c.project.repo, c.project.remote!, c.project.baseBranch);
  await fetchBase(c.project.repo, c.project.remote!, c.project.baseBranch, c.project.id);
  const contained = await git(c.project.repo, 'merge-base', '--is-ancestor', tip, c.head).then(() => true, () => false);
  if (tip !== c.base || !contained || pr.mergeable_state === 'behind') {
    // Behind the base (D-115): bring the PR up to date, then the human approves the new head once CI is green.
    const refreshed = await c.d.refreshPr(c.project.id, c.land.taskId).catch((e: Error & { conflicts?: string[] }) => {
      throw new LandFailure(e.conflicts ? 'conflict' : 'base_moved', e.conflicts ? e.message : `${c.project.baseBranch} moved to ${tip.slice(0, 12)} since the approval, and updating PR #${c.pr} failed: ${e.message}`);
    });
    throw new LandFailure('base_moved', `${c.project.baseBranch} moved to ${tip.slice(0, 12)} since the approval; PR #${c.pr} is updated to ${refreshed.slice(0, 12)}: approve that head once its checks are green`);
  }
  if (pr.mergeable_state !== 'clean') {
    const runs = await c.gh.checkRuns(c.head);
    const red = runs.filter((r) => REQUIRED_CHECKS.includes(r.name) && r.status === 'completed' && !['success', 'neutral', 'skipped'].includes(r.conclusion ?? ''));
    throw new LandFailure(red.length || runs.some((r) => r.status !== 'completed') ? 'checks_failed' : 'not_mergeable', `PR #${c.pr} isn't mergeable (${pr.mergeable_state}${red.length ? `; failing: ${red.map((r) => r.name).join(', ')}` : ''})`);
  }
  // The reviews AGENTS.md requires, from CODEOWNERS at the base, each approving this exact head.
  const changed = (await git(c.project.repo, 'diff', '--no-renames', '--name-only', '-z', c.base, c.head)).split('\0').filter(Boolean).sort();
  const login = await c.d.githubLoginFor(c.project);
  const required = requiredReviewers(await codeownersAt(c.project.repo, c.base), changed, login);
  const reviews = await c.gh.reviews(c.pr);
  const latest = new Map<string, { state: string; commit_id: string }>();
  for (const r of reviews) if (r.user && r.state !== 'COMMENTED') latest.set(r.user.login.toLowerCase(), r);
  const missing = required.filter((who) => { const r = latest.get(who.toLowerCase()); return !r || r.state !== 'APPROVED' || r.commit_id !== c.head; });
  if (missing.length) throw new LandFailure('review_required', `PR #${c.pr} needs an approving review of ${c.head.slice(0, 12)} from ${missing.map((m) => `@${m}`).join(', ')} (AGENTS.md, CODEOWNERS)`);
  // AGENTS.md's one-PR-in-flight rule: merging now would put another PR whose CI is running behind.
  for (const other of await c.gh.call<PullRequest[]>('GET', `/repos/${c.project.githubRepo}/pulls?state=open&per_page=50`)) {
    if (other.number === c.pr) continue;
    const running = (await c.gh.checkRuns(other.head.sha)).some((r) => r.status !== 'completed');
    if (running) throw new LandFailure('ci_busy', `PR #${other.number}'s checks are still running; merge after it (AGENTS.md, one PR in flight)`);
  }
  return changed;
}

/** The PR once GitHub has worked out its mergeability (it's null for a while after any push). */
async function settledPull(c: Ctx): Promise<PullRequest> {
  for (let i = 0; ; i++) {
    const pr = await c.gh.pull(c.pr);
    if (pr.mergeable !== null && pr.mergeable_state !== 'unknown') return pr;
    if (i >= MERGEABLE_TRIES) return pr;
    await sleep(c.d.o.github?.retryMs ?? 10_000);
  }
}

/** Steps 4 to 6, once armed. */
async function mergeAndSettle(c: Ctx): Promise<void> {
  let merged: string | null = null;
  try {
    const title = `${c.land.taskId}: ${(c.d.view(c.project.id).tasks.get(c.land.taskId)?.title ?? '').slice(0, 200)} (#${c.pr})`;
    const r = await c.gh.merge(c.pr, c.head, title, `Harness-Task: ${c.land.taskId}\nHarness-Land: ${c.land.id}`);
    if (r.merged) merged = r.sha;
  } catch (e) {
    if (e instanceof GitHubError && [405, 409, 422].includes(e.status)) {
      // A definite refusal; GitHub's state of the PR is the evidence.
      const pr = await c.gh.pull(c.pr).catch(() => null);
      if (pr?.merged && pr.merge_commit_sha) merged = pr.merge_commit_sha;
      else if (pr && !pr.merged) {
        const reason = e.status === 409 || pr.head.sha !== c.head ? 'head_changed' : pr.state === 'closed' ? 'pr_closed' : 'not_mergeable';
        return fail(c, reason, e.message, { state: pr.state, merged: false, head_sha: pr.head.sha });
      }
    }
    if (!merged) c.d.log(`the merge of ${c.land.taskId} (PR #${c.pr}) has an unknown outcome: ${(e as Error).message}`);
  }
  if (merged) {
    // Merged: a failure from here (a fetch, the coordinator) is retried by reconciling, never left armed.
    try {
      return await complete(c, merged);
    } catch (e) {
      c.d.log(`completing ${c.land.taskId}'s land after its merge: ${(e as Error).message}; reconciling`);
    }
  }
  return reconcile(c);
}

/**
 * outcome_unknown: ask GitHub until it says. Merged: complete. Closed unmerged, or a new head: fail with that evidence.
 * Still open on the approved head: our squash may already be on the base (found by its Harness-Land trailer); if not,
 * after two reads 30 s apart both say open, re-arm and ask again. Never released by a timer.
 */
async function reconcile(c: Ctx): Promise<void> {
  c.d.journal().append(c.project.id, c.land.taskId, 'outcome_unknown', { land_id: c.land.id });
  await report(c, 'outcome_unknown').catch(() => {});
  const wait = c.d.o.github?.retryMs ?? 30_000;
  for (let attempt = 0; !c.d.stopping; attempt++) {
    try {
      // Awaited inside the try: a failure while completing is retried here, never lost.
      const pr = await c.gh.pull(c.pr);
      if (pr.merged && pr.merge_commit_sha) return await complete(c, pr.merge_commit_sha);
      if (pr.state === 'closed') return await fail(c, 'pr_closed', `PR #${c.pr} was closed without merging`, { state: 'closed', merged: false, head_sha: pr.head.sha });
      if (pr.head.sha !== c.head) return await fail(c, 'head_changed', `PR #${c.pr}'s head moved to ${pr.head.sha.slice(0, 12)}`, { state: pr.state, merged: false, head_sha: pr.head.sha });
      const found = await ourSquash(c);
      if (found) return await complete(c, found);
      await sleep(wait);
      const again = await c.gh.pull(c.pr);
      if (again.state === 'open' && !again.merged && again.head.sha === c.head && !(await ourSquash(c))) {
        await c.d.link!.command(c.project.id, 'land.arm', { land_id: c.land.id, head_sha: c.head, base_sha: c.base });
        return await mergeAndSettle(c);
      }
    } catch (e) {
      c.d.log(`reconciling ${c.land.taskId}'s merge: ${(e as Error).message}`);
    }
    await sleep(Math.min(wait * 2 ** Math.min(attempt, 4), 600_000));
  }
}

/** Our squash on the base, if it got there: a first-parent descendant of the approved base carrying our land's trailer. */
async function ourSquash(c: Ctx): Promise<string | null> {
  const tip = await fetchBase(c.project.repo, c.project.remote!, c.project.baseBranch, c.project.id);
  const log = await git(c.project.repo, 'log', '--first-parent', '--format=%H%x00%B%x01', `${c.base}..${tip}`).catch(() => '');
  for (const entry of log.split('\x01')) {
    const [sha, body] = entry.trim().split('\0');
    if (sha && body?.includes(`Harness-Land: ${c.land.id}`)) return sha;
  }
  return null;
}

/** Step 5 and 6: verify the merge on the base we fetched, then land.complete, then tidy up. */
async function complete(c: Ctx, merge: string): Promise<void> {
  const { project, land } = c;
  const tip = await fetchBase(project.repo, project.remote!, project.baseBranch, project.id);
  if (!(await gitRemote(project.repo, 'merge-base', '--is-ancestor', merge, tip).then(() => true, () => false))) {
    // GitHub says merged, but the commit isn't on the base we fetched yet: ask again later.
    c.d.log(`${merge.slice(0, 12)} isn't on ${project.baseBranch} yet; reconciling`);
    await sleep(c.d.o.github?.retryMs ?? 10_000);
    return reconcile(c);
  }
  await c.d.advanceProjectBase(project, tip);
  const parent = await git(project.repo, 'rev-parse', `${merge}^1`);
  const [mergeTree, headTree] = await Promise.all([git(project.repo, 'rev-parse', `${merge}^{tree}`), git(project.repo, 'rev-parse', `${c.head}^{tree}`)]);
  if (parent !== c.base || mergeTree !== headTree) {
    // It's on the base whatever it holds: readers must hear of it. But it isn't what was approved: say so, loudly.
    c.d.log(`SECURITY: the merge ${merge.slice(0, 12)} of ${land.taskId} isn't the approved head on the approved base (parent ${parent.slice(0, 12)}, trees ${mergeTree === headTree ? 'equal' : 'differ'})`);
  }
  // Once only: a retry after the coordinator recorded it goes straight to the cleanup.
  if (c.d.view(project.id).lands.get(land.id)?.status !== 'completed') {
    const changed = await changedBlobsBetween(project.repo, parent, merge);
    c.d.journal().append(project.id, land.taskId, 'landed', { land_id: land.id, merge });
    await c.d.report(project.id, 'land.complete', { land_id: land.id, old_base_sha: c.base, new_base_sha: merge, changed });
    c.d.log(`landed ${land.taskId}: PR #${c.pr} merged as ${merge.slice(0, 12)}`);
  }
  c.d.leases.untrack(land.taskId);
  await cleanup(c, merge);
}

/** The task's worktree and branch go, only if they're exactly what was merged; a squash shares no ancestry with them. */
async function cleanup(c: Ctx, merge: string): Promise<void> {
  const { project, land } = c;
  const worktree = c.d.worktreeOf(project.id, land.taskId);
  const tip = await git(project.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${taskBranch(land.taskId)}`).catch(() => '');
  if (tip !== c.head) return c.d.log(`kept ${land.taskId}'s branch: it has commits made after the merge`);
  if (fs.existsSync(worktree)) {
    if (c.d.running.has(land.taskId) || (await git(worktree, 'status', '--porcelain', '--untracked-files=all').catch(() => 'unknown'))) {
      return c.d.log(`kept ${worktree}: it has changes made after the merge`);
    }
    await c.d.teardownTask({ projectId: project.id, taskId: land.taskId }, { force: false }).catch((e: Error) => c.d.log(`kept ${worktree}: ${e.message.split('\n')[0]}`));
  }
  // Compare-and-swap: deleted only if it still points at the merged head.
  await git(project.repo, 'update-ref', '-d', `refs/heads/${taskBranch(land.taskId)}`, c.head).catch((e: Error) => c.d.log(`kept ${taskBranch(land.taskId)}: ${e.message.split('\n')[0]}`));
  void merge;
}
