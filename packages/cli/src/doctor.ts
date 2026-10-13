// `harness doctor`: is this Mac ready for the pilot (PB1; D-111, D-116, D-119)? Each check prints ok, or what's wrong
// and the exact fix. It never prints a secret: a key's fingerprint, never the key; where a provider key was found,
// never its value. Exit 1 if anything fails.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  CLAUDE_PINNED, devicePublicKey, findTrustPostgres, Handshake, installedClaudeSdkVersion, loadConfig, loadDeviceKey, serverFrame, ServerIdentityError,
  untrustedText, type Home, type LocalConfig,
} from '@harness/daemon';
import { fingerprint, keyId } from '@harness/protocol/signing';
import type { Welcome } from '@harness/protocol';
import { parse } from 'smol-toml';
import { PILOT } from './setup.ts';

const run = promisify(execFile);
export type Check = { name: string; ok: boolean | 'skip'; detail: string };

/** A minimal environment for the tools doctor runs: nothing that carries a token. */
const env = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? os.homedir(), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
const tool = (cmd: string, args: string[], timeout = 20_000) =>
  run(cmd, args, { env: env(), timeout }).then((r) => ({ ok: true, out: `${r.stdout}${r.stderr}` }), (e: { stdout?: string; stderr?: string; message: string }) => ({ ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message }));

/** Says hello with this device's key and waits for the welcome; any failure is a fix for the human. */
export function probeServer(config: LocalConfig, home: Home, timeoutMs = 10_000): Promise<Welcome> {
  // Subscribed, so the welcome lists each project this human is a member of; the socket closes at the welcome.
  const hs = new Handshake({ config, deviceKey: loadDeviceKey(home), clientKind: 'cli', subscribe: config.projects.map((p) => ({ project_id: p.id, after_seq: 0 })) });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(config.serverUrl);
    let verified = false;
    let said = '';
    const done = (e?: Error, w?: Welcome) => { clearTimeout(timer); ws.close(); if (e) reject(e); else resolve(w!); };
    const timer = setTimeout(() => done(new Error(`no ${verified ? '' : 'verified '}answer from ${config.serverUrl} in ${timeoutMs / 1000}s${said}`)), timeoutMs);
    ws.addEventListener('error', () => done(new Error(`can't reach ${config.serverUrl}: is the SSH tunnel up (scripts/pilot/tunnel.sh status)?`)));
    ws.addEventListener('open', () => ws.send(JSON.stringify(hs.hello())));
    ws.addEventListener('message', (ev) => {
      const m = serverFrame(ev.data);
      if (!m) return;
      if (!verified) {
        if (m.type === 'error') said = ` (an unverified answer said ${untrustedText(m.code, 40)}: ${untrustedText(m.message)})`;
        if (m.type !== 'challenge') return;
        try {
          ws.send(JSON.stringify(hs.answer(m)));
          verified = true;
        } catch (e) {
          done(new Error(e instanceof ServerIdentityError
            ? `server_identity_mismatch: whatever answers at ${config.serverUrl} doesn't hold the pinned coordinator key (${fingerprint(config.serverKey!)}). Don't trust it; check the tunnel and the key with the operator`
            : `the server's challenge couldn't be checked: ${untrustedText((e as Error).message)}`));
        }
        return;
      }
      if (m.type === 'welcome') return done(undefined, m);
      if (m.type === 'error') {
        done(new Error(m.code === 'unauthorized'
          ? `the coordinator refused this device: has its operator applied pilot.toml with ${config.deviceId}'s key (${fingerprint(devicePublicKey(home))}), for ${config.principal}, and not revoked it?`
          : `${untrustedText(m.code, 40)}: ${untrustedText(m.message)}`));
      }
    });
  });
}

const portFree = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

export async function doctor(home: Home, o: { offline?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean | 'skip', detail: string) => checks.push({ name, ok, detail });
  let config: LocalConfig;
  try {
    config = loadConfig(home);
    // It holds the pins: nobody else may change what this device trusts (D-111).
    const loose = fs.statSync(home.config).mode & 0o022;
    check('config', !loose, loose ? `${home.config} is writable by others: chmod 600 ${home.config}` : home.config);
  } catch (e) {
    check('config', false, `${(e as Error).message}. Write it with harness setup`);
    return checks;
  }
  if (config.auth !== 'device-key') check('auth', false, 'the pilot authenticates with device keys: auth = "device-key" (harness setup writes it)');

  // This device's key: owner-only, and the one pinned for this device.
  let pub = '';
  try {
    pub = devicePublicKey(home);
    const pinned = config.trustedDevices[config.deviceId]?.key;
    check('device key', pinned === pub, pinned === pub ? `${config.deviceId} ${fingerprint(pub)}` : `${home.deviceKey} isn't the key pinned for ${config.deviceId} in [trust.devices]; re-run harness setup`);
  } catch (e) {
    check('device key', false, (e as Error).message);
  }

  // The coordinator, through the tunnel: its pinned key, the epoch, each project's mode, and our clock.
  if (o.offline) check('coordinator', 'skip', '--offline');
  else if (!pub || !config.serverKey) check('coordinator', 'skip', !pub ? 'not contacted: this device\'s key isn\'t usable (see above)' : 'not contacted: no server_key pinned (harness setup --server-key)');
  else {
    try {
      const w = await probeServer(config, home);
      check('coordinator', true, `${config.serverUrl}: key ${fingerprint(config.serverKey)} (id ${keyId(config.serverKey)}), epoch ${w.epoch ?? '(none)'}`);
      const skew = Math.abs(Date.now() - Date.parse(w.server_time)) / 1000;
      check('clock', skew < 60, skew < 60 ? `${skew.toFixed(1)} s from the coordinator` : `${skew.toFixed(0)} s from the coordinator; turn on Set time automatically`);
      for (const p of config.projects) {
        const head = w.projects.find((x) => x.project_id === p.id) as (Welcome['projects'][number] & { integration_mode?: string }) | undefined;
        if (!head) check(`project ${p.id}`, false, `the coordinator doesn't list ${p.id} for ${config.principal}: ask the operator to add the membership`);
        else if (head.integration_mode && head.integration_mode !== p.integration) check(`project ${p.id}`, false, `the coordinator integrates ${p.id} as "${head.integration_mode}", this config as "${p.integration}"`);
        else check(`project ${p.id}`, true, `member, ${head.integration_mode ?? 'local'} integration`);
      }
    } catch (e) {
      check('coordinator', false, (e as Error).message);
    }
  }

  // Each project's clone: a git repository outside iCloud, whose origin carries no credentials and answers.
  const home_ = os.homedir();
  const icloudDocs = fs.existsSync(path.join(home_, 'Library/Mobile Documents/com~apple~CloudDocs/Desktop'));
  for (const p of config.projects) {
    const where = `repo ${p.id}`;
    if (!fs.existsSync(path.join(p.repo, '.git'))) { check(where, false, `${p.repo} isn't a git clone`); continue; }
    const real = fs.realpathSync(p.repo);
    const synced = real.startsWith(path.join(home_, 'Library/Mobile Documents')) || (icloudDocs && [path.join(home_, 'Desktop'), path.join(home_, 'Documents')].some((d) => real === d || real.startsWith(d + path.sep)));
    if (synced) { check(where, false, `${real} is inside iCloud; clone it somewhere else (~/code, say): iCloud makes "name 2" copies and breaks Git`); continue; }
    if (p.integration === 'local') { check(where, true, `${real} (local integration: no remote)`); continue; }
    const origin = await tool('git', ['-C', p.repo, 'remote', 'get-url', 'origin']);
    const url = origin.out.trim();
    if (!origin.ok) { check(where, false, `no origin remote in ${p.repo}`); continue; }
    // Parsed, never echoed: a URL can carry a token in any scheme or case (review of #116).
    let parsed: URL | null = null;
    try { parsed = new URL(url); } catch { /* not a URL: scp-style or garbage */ }
    if (!parsed || parsed.protocol !== 'https:') { check(where, false, `origin in ${p.repo} isn't an https URL; set it with git remote set-url origin ${p.remote ?? '<the https URL>'}`); continue; }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) { check(where, false, `origin's URL in ${p.repo} carries credentials or extra parts; set it to the plain https URL (git remote set-url origin ${p.remote ?? '<url>'}) and use gh auth setup-git`); continue; }
    const same = (a: URL, b: string) => { try { const u = new URL(b); return u.host.toLowerCase() === a.host.toLowerCase() && u.pathname.replace(/\.git$/, '') === a.pathname.replace(/\.git$/, ''); } catch { return false; } };
    if (p.remote && !same(parsed, p.remote)) { check(where, false, `origin in ${p.repo} isn't config.toml's remote (${p.remote}): git remote set-url origin ${p.remote}`); continue; }
    if (o.offline) { check(where, true, `${real} (not contacted: --offline)`); continue; }
    const ls = await tool('git', ['-C', p.repo, 'ls-remote', 'origin', 'HEAD']);
    check(where, ls.ok, ls.ok ? `${real}, origin answers` : `git ls-remote origin failed: ${untrustedText(ls.out.trim().split('\n').at(-1))}. Run gh auth setup-git`);
  }

  // GitHub: the human's own login, with the scopes publishing needs, and Git using it.
  if (config.projects.some((p) => p.integration === 'github')) {
    const gh = await tool('gh', ['auth', 'status', '--hostname', 'github.com']);
    const scopes = /Token scopes: (.*)/.exec(gh.out)?.[1] ?? '';
    const missing = ['repo', 'workflow'].filter((s) => !scopes.includes(`'${s}'`));
    check('gh', gh.ok && !missing.length, gh.ok ? (missing.length ? `the token lacks ${missing.join(', ')}: gh auth refresh -s ${missing.join(',')}` : `logged in, scopes ok`) : 'not logged in: gh auth login');
    const helper = await tool('git', ['config', '--global', '--get-all', 'credential.https://github.com.helper']);
    check('git credentials', helper.out.includes('gh auth git-credential'), helper.out.includes('gh auth git-credential') ? 'Git uses gh' : 'Git doesn\'t use your gh login: gh auth setup-git');
  }

  // The model key: where it was found, never its value; and never in a shell profile or a launchd plist.
  const provider = config.agents.provider ? config.providers[config.agents.provider] : undefined;
  if (!provider) check('provider', false, 'no [agents] provider: re-run harness setup with --provider openrouter-haiku55 (D-126)');
  else {
    const inEnv = !!process.env[provider.keyEnv];
    let inSecrets = false;
    try { inSecrets = fs.existsSync(home.secrets) && typeof (parse(fs.readFileSync(home.secrets, 'utf8')) as Record<string, unknown>)[provider.keyEnv] === 'string'; } catch { /* unreadable: reported below */ }
    if (fs.existsSync(home.secrets) && fs.statSync(home.secrets).mode & 0o077) check('secrets', false, `${home.secrets} must be owner-only: chmod 600 ${home.secrets}`);
    check('provider key', inEnv || inSecrets, inSecrets ? `${provider.keyEnv} in ${home.secrets}` : inEnv ? `${provider.keyEnv} in the environment; D-116 keeps it in ${home.secrets} instead` : `put ${provider.keyEnv} = "…" in ${home.secrets} (chmod 600), with a $${PILOT.dailyBudgetUsd}/day limit on the key`);
  }
  const leaky = [path.join(home_, '.zshrc'), path.join(home_, '.zprofile'), ...(() => {
    const dir = path.join(home_, 'Library/LaunchAgents');
    try { return fs.readdirSync(dir).filter((f) => /harness/i.test(f) && f.endsWith('.plist')).map((f) => path.join(dir, f)); } catch { return []; }
  })()].filter((f) => { try { return /sk-or-|sk-ant-/.test(fs.readFileSync(f, 'utf8')); } catch { return false; } });
  check('no keys in profiles', !leaky.length, leaky.length ? `${leaky.join(', ')} holds a model key; move it to ${home.secrets} (D-116)` : 'none in shell profiles or harness plists');

  // The pilot's limits (D-116): at most one agent, $0.10 a session, $0.25 a day.
  const { maxBudgetUsd, dailyBudgetUsd } = config.agents;
  const within = config.limits.maxConcurrentAgents <= PILOT.maxConcurrentAgents && maxBudgetUsd !== null && maxBudgetUsd <= PILOT.maxBudgetUsd && dailyBudgetUsd !== null && dailyBudgetUsd <= PILOT.dailyBudgetUsd;
  check('budgets', within, `${config.limits.maxConcurrentAgents} agent(s), $${maxBudgetUsd ?? '?'} a session, $${dailyBudgetUsd ?? '?'} a day${within ? '' : `: the pilot allows ${PILOT.maxConcurrentAgents}, $${PILOT.maxBudgetUsd} and $${PILOT.dailyBudgetUsd}; raising them is the owners' call`}`);

  // What this Mac's agents can reach on loopback (D-143), said outright: a config written without --ports-per-agent 0
  // gives every agent a port block, and with it every loopback listener here.
  const agentPorts = config.limits.portsPerAgent;
  check('agent loopback', true, agentPorts === 0 ? 'none: ports_per_agent = 0 (D-143)'
    : `${agentPorts} ports per agent, so agents can reach every loopback listener on this Mac; harness setup … --ports-per-agent 0 --force closes it`);

  // The runtime: Node 24, and the sandbox actually runs a command.
  const major = Number(process.versions.node.split('.')[0]);
  check('node', major === 24, major === 24 ? `v${process.versions.node}` : `v${process.versions.node}; the pilot runs on Node 24`);
  try {
    const req = createRequire(import.meta.resolve('@harness/daemon'));
    const cli = path.join(path.dirname(req.resolve('@anthropic-ai/sandbox-runtime/package.json')), 'dist', 'cli.js');
    const srt = await tool(process.execPath, [cli, '-c', 'true'], 30_000);
    check('sandbox', srt.ok, srt.ok ? 'srt runs a command' : `srt couldn't run \`true\`: ${untrustedText(srt.out.trim().split('\n').at(-1))}`);
  } catch (e) {
    check('sandbox', false, `srt not found: ${(e as Error).message}`);
  }
  let installed: string | null = null;
  try { installed = installedClaudeSdkVersion(); } catch { /* not installed: reported below */ }
  check('claude code', installed === CLAUDE_PINNED.sdk, installed === CLAUDE_PINNED.sdk ? `Agent SDK ${installed} (CLI ${CLAUDE_PINNED.cli}), the pinned version (D-49)`
    : `the Agent SDK here is ${installed ?? 'missing'}, but this runtime is pinned to ${CLAUDE_PINNED.sdk}: run npm ci in the runtime (scripts/pilot/install.sh)`);

  // No password-less loopback Postgres beside the agents (D-119).
  // The same raw probe harnessd runs before it starts agents (PA11): every loopback listener, as this user and postgres.
  const notes: string[] = [];
  const hits = await findTrustPostgres({ log: (m) => notes.push(m) });
  const ports = [...new Set(hits.map((h) => h.port))];
  check('postgres', !hits.length, hits.length
    ? `a loopback Postgres on ${ports.join(', ')} accepts password-less logins, so harnessd won't start agents (D-119): harden it (scripts/pilot/pg-harden.sh) or stop it`
    : `no loopback Postgres accepts a password-less login${notes.length ? ` (${notes.map((n) => untrustedText(n, 200)).join('; ')})` : ''}`);

  // The UI's port: outside the agents' range (config.ts checks) and free.
  if (config.ui.port !== null) {
    const free = await portFree(config.ui.port);
    // While the UI's bridge runs it holds this port, which is fine; anything else there would keep the bridge from starting.
    check('ui port', free ? true : 'skip', `127.0.0.1:${config.ui.port} ${free ? 'is free' : 'is taken: fine if it\'s harness ui\'s bridge, otherwise stop whatever holds it'}`);
  }
  return checks;
}

export function renderChecks(checks: Check[]): string {
  return checks.map((c) => `${c.ok === 'skip' ? 'skip' : c.ok ? ' ok ' : 'FAIL'}  ${c.name.padEnd(20)} ${c.detail}`).join('\n');
}
