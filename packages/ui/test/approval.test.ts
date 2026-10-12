// The approval page's model (D-117, D-112): every kind laid out in full, the heading matched to the board's, the hash
// passed through, and untrusted text carried as data. A null-details request falls back to the command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PendingApproval, ProjectSnapshot, TaskSnapshot } from '@harness/protocol';
import { approvalModel } from '../web/model/approval.ts';

function task(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: 'T-1', title: 'Widget', text: 'do it', scope: ['src/**'], owner_human_id: 'h1', priority: 0,
    assignee_agent_id: null, task_sha256: 'sha', status: 'open', state: 'open', state_detail: null,
    summary: null, created_at: 'x', assigned_at: null, completed_at: null, session: null, pr: null, land: null,
    publish_blocked: null, stale_reads: [], changing: [], overlaps: [], leases: [], open_wait: null, cost_usd: 0, ...over,
  };
}

function snapshot(over: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    v: 1, project_id: 'p1', head_seq: 1, integration_mode: 'local', taken_at: 'x', device_id: 'dev-1', principal: 'me',
    connection: 'connected', tasks: [task()], agents: [], devices: [], messages: [], waits: [], lands: [], base_advances: [],
    budget: { day: 'd', spent_usd: 0, daily_budget_usd: null, session_cap_usd: null },
    repo: { github_repo: null, base_branch: 'main' }, alerts: [], provider: { circuit: null }, ...over,
  };
}

function approval(over: Partial<PendingApproval> = {}): PendingApproval {
  return { id: 'ap1', project_id: 'p1', task_id: 'T-1', command: 'run it', manifests: [], hash: 'h', requested_at: 'x', kind: 'setup', details: null, ...over } as PendingApproval;
}

const rows = (m: ReturnType<typeof approvalModel>) => Object.fromEntries(m.rows);
const longs = (m: ReturnType<typeof approvalModel>) => Object.fromEntries(m.long);

test('setup: the command and each manifest, with the hash passed through', () => {
  const m = approvalModel(approval({ hash: 'abc123', command: 'npm ci', manifests: [{ path: 'package-lock.json', sha256: 'deadbeef' }, { path: 'MISSING', sha256: null }] }), snapshot());
  assert.equal(m.id, 'ap1');
  assert.equal(m.kind, 'setup');
  assert.equal(m.hash, 'abc123');
  assert.equal(m.heading, 'Approve the setup command for Widget');
  assert.equal(rows(m).Command, 'npm ci');
  assert.equal(rows(m)['Manifest "package-lock.json"'], 'deadbeef');
  assert.equal(rows(m)['Manifest "MISSING"'], 'missing');
});

test('test: the heading names landing, and the command is a row', () => {
  const m = approvalModel(approval({ kind: 'test', command: 'npm run check' }), snapshot());
  assert.equal(m.heading, 'Approve the test command for landing Widget');
  assert.equal(rows(m).Command, 'npm run check');
});

test('a null-details setup falls back to the command as a long request', () => {
  const m = approvalModel(approval({ command: 'the whole text' }), snapshot());
  assert.deepEqual(longs(m).Request, 'the whole text');
});

test('publish: repo, branch, full SHAs, PR title, held paths, and the PR body and diffstat as long texts', () => {
  const details = {
    github_repo: 'vihAan02/harness', branch: 'daniyal/T-4', head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40),
    pr_title: 'Add the task page', pr_body: 'body text', held: [{ rule: 'manifests', path: 'package-lock.json' }, { rule: 'locks', path: 'yarn.lock' }], diffstat: '2 files changed',
  };
  const m = approvalModel(approval({ kind: 'publish', details }), snapshot());
  assert.equal(m.heading, 'Approve publishing Widget as a PR');
  assert.equal(rows(m).Repository, 'vihAan02/harness');
  assert.equal(rows(m).Branch, 'daniyal/T-4');
  assert.equal(rows(m).Head, 'a'.repeat(40));
  assert.equal(rows(m).Base, 'b'.repeat(40));
  assert.equal(rows(m)['PR title'], 'Add the task page');
  assert.equal(rows(m)['Held by "manifests"'], 'package-lock.json');
  assert.equal(rows(m)['Held by "locks"'], 'yarn.lock');
  assert.equal(longs(m)['PR body'], 'body text');
  assert.equal(longs(m).Diffstat, '2 files changed');
});

test('agent_session: the issuer, kind, agent, task, scope, owner and expiry, with the task text and message long', () => {
  const details = {
    kind: 'start' as const, issuer_human_id: 'alice', issuer_device_id: 'mac-2', nonce: 'n', expires_at: '2026-10-12T15:00:00.000Z',
    agent_name: 'Bot', task_id: 'T-1', task_title: 'Widget', task_text: 'do the thing', task_scope: ['src/**', 'test/**'],
    task_owner_human_id: 'h1', task_sha256: 's', message: 'please start it',
  };
  const m = approvalModel(approval({ kind: 'agent_session', details }), snapshot());
  assert.equal(m.heading, 'alice asks to start Bot on Widget');
  assert.equal(rows(m)['Asked by'], 'alice on mac-2');
  assert.equal(rows(m).Kind, 'start');
  assert.equal(rows(m).Agent, 'Bot');
  assert.equal(rows(m).Task, 'T-1: Widget');
  assert.equal(rows(m).Scope, 'src/**, test/**');
  assert.equal(rows(m)['Task owner'], 'h1');
  assert.equal(rows(m).Expires, '2026-10-12T15:00:00.000Z');
  assert.equal(longs(m)['Task text'], 'do the thing');
  assert.equal(longs(m).Message, 'please start it');
});

test('agent_session: no message means no long message; null details fall back to the command', () => {
  const details = { kind: 'resume' as const, issuer_human_id: 'a', issuer_device_id: 'd', nonce: 'n', expires_at: 'x', agent_name: 'Bot', task_id: 'T-1', task_title: 'Widget', task_text: 't', task_scope: [], task_owner_human_id: 'h1', task_sha256: 's', message: null };
  const m = approvalModel(approval({ kind: 'agent_session', details }), snapshot());
  assert.equal('Message' in longs(m), false);
  const fallback = approvalModel(approval({ kind: 'agent_session', command: 'the request', details: null }), snapshot());
  assert.equal(longs(fallback).Request, 'the request');
});

test('security_review: about, from, rules, and the held text as a long', () => {
  const details = { about: 'message' as const, from: 'peer-agent', rules: ['credential', 'path-escape'], text: 'the held text' };
  const m = approvalModel(approval({ kind: 'security_review', details }), snapshot());
  assert.equal(m.heading, 'A held message for Widget: review it');
  assert.equal(rows(m).About, 'message');
  assert.equal(rows(m).From, 'peer-agent');
  assert.equal(rows(m).Rules, 'credential, path-escape');
  assert.equal(longs(m)['Held text'], 'the held text');
});

test('the board’s heading and the page’s heading agree for every kind', () => {
  // The board builds these strings in model/attention.ts; the page must read the same. Checked here as literals.
  const snap = snapshot();
  assert.equal(approvalModel(approval({ kind: 'setup' }), snap).heading, 'Approve the setup command for Widget');
  assert.equal(approvalModel(approval({ kind: 'test' }), snap).heading, 'Approve the test command for landing Widget');
  assert.equal(approvalModel(approval({ kind: 'publish' }), snap).heading, 'Approve publishing Widget as a PR');
  assert.equal(approvalModel(approval({ kind: 'security_review' }), snap).heading, 'A held message for Widget: review it');
});

test('the task line names the task and its state; without a snapshot it is the id', () => {
  const withSnap = approvalModel(approval(), snapshot({ tasks: [task({ state: 'running' })] }));
  assert.equal(withSnap.task, 'T-1: Widget — working');
  assert.equal(approvalModel(approval(), null).task, 'T-1');
});

test('a title, a message and a held text with markup come back unchanged as strings', () => {
  const markup = '<img src=x onerror=alert(1)>';
  const publish = approvalModel(approval({ kind: 'publish', details: {
    github_repo: 'r', branch: 'b', head_sha: 'h', base_sha: 'b', pr_title: markup, pr_body: markup, held: [], diffstat: '',
  } }), snapshot({ tasks: [task({ title: markup })] }));
  assert.equal(rows(publish)['PR title'], markup);
  assert.equal(longs(publish)['PR body'], markup);
  const review = approvalModel(approval({ kind: 'security_review', details: { about: 'task', from: 'h', rules: [], text: markup } }), snapshot());
  assert.equal(longs(review)['Held text'], markup);
});
