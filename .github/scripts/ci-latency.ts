// CI latency per job (B1; the workboard's §9 tracks it as a development metric): p50 and p90 runtime,
// and p90 queue wait, over the latest completed runs of the `ci` workflow. Prints a Markdown table.
// Usage: npm run ci:latency [-- --runs 20 --workflow ci.yml --repo owner/name]. Needs `gh`, logged in
// (GH_TOKEN in Actions). full-macos stays a required check only while its p90 runtime is ≤ 15 minutes.
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : fallback;
};
const REPO = opt('repo', process.env.GITHUB_REPOSITORY ?? 'vihAan02/harness');
const WORKFLOW = opt('workflow', 'ci.yml');
const RUNS = Number(opt('runs', '20'));

type Job = { name: string; conclusion: string | null; created_at: string; started_at: string; completed_at: string | null };
const gh = <T>(path: string): T => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' })) as T;

const { workflow_runs: runs } = gh<{ workflow_runs: { id: number }[] }>(
  `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?status=completed&per_page=${RUNS}`);
const byJob = new Map<string, { run: number[]; queue: number[] }>();
for (const { id } of runs) {
  for (const job of gh<{ jobs: Job[] }>(`repos/${REPO}/actions/runs/${id}/jobs?per_page=100`).jobs) {
    // A failed job still made someone wait; cancelled and skipped ones didn't run to the end.
    if ((job.conclusion !== 'success' && job.conclusion !== 'failure') || !job.completed_at) continue;
    const entry = byJob.get(job.name) ?? { run: [], queue: [] };
    entry.run.push(Date.parse(job.completed_at) - Date.parse(job.started_at));
    entry.queue.push(Date.parse(job.started_at) - Date.parse(job.created_at));
    byJob.set(job.name, entry);
  }
}

/** Nearest-rank percentile. */
const pct = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil((p / 100) * values.length) - 1)] ?? 0;
const mmss = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

console.log(`### CI latency: \`${WORKFLOW}\`, last ${runs.length} completed runs (${new Date().toISOString().slice(0, 10)})\n`);
console.log('| Job | Runs | Runtime p50 | Runtime p90 | Queue p90 |');
console.log('|---|---|---|---|---|');
for (const [name, { run, queue }] of [...byJob].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`| ${name} | ${run.length} | ${mmss(pct(run, 50))} | ${mmss(pct(run, 90))} | ${mmss(pct(queue, 90))} |`);
}
