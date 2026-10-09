// `harness setup`: one Mac joins the pilot (PB1; D-111, acceptance 1). `keygen` makes this device's key; `setup`
// writes config.toml with what the human typed: the coordinator's key and each other device's key, all checked aloud
// by fingerprint. Nothing is pinned from what a server says. The pilot's limits are fixed here: device-key auth, one
// agent, $0.10 a session and $0.25 a day (D-116), the UI on 127.0.0.1:7480 (D-117).
import fs from 'node:fs';
import path from 'node:path';
import { createDeviceKey, devicePublicKey, renderConfig, type Home } from '@harness/daemon';
import { fingerprint, parsePublicKey, publicKeyText } from '@harness/protocol/signing';
import { parse } from 'smol-toml';

/** The pilot's fixed limits (D-116, D-117); `harness doctor` checks a config against them. */
export const PILOT = { maxConcurrentAgents: 1, maxBudgetUsd: 0.1, dailyBudgetUsd: 0.25, uiPort: 7480 } as const;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const EXAMPLE_PROVIDERS = new URL('../../../docs/examples/providers.toml', import.meta.url);

export class SetupError extends Error {}

function key(text: string, what: string): string {
  try { return publicKeyText(parsePublicKey(text)); } catch { throw new SetupError(`${what} must be an Ed25519 key, ed25519:<base64 SPKI>`); }
}

/** Makes this device's key, once (it never overwrites one), and returns what to read aloud. */
export function keygen(home: Home, deviceId: string | undefined): string {
  if (fs.existsSync(home.deviceKey)) throw new SetupError(`${home.deviceKey} already exists; a device keeps its key (rotate it with the coordinator's operator)`);
  const { publicKey } = createDeviceKey(home);
  return [
    `device ${deviceId ?? '(choose a device id)'}: key created at ${home.deviceKey} (owner-only)`,
    `public_key = "${publicKey}"`,
    `fingerprint ${fingerprint(publicKey)}: read it aloud to the coordinator's operator, who checks it against what apply prints`,
  ].join('\n');
}

export type SetupOptions = {
  device: string; principal: string; serverUrl: string; serverKey: string;
  /** Other devices, `<device_id>=<human_id>:ed25519:…`. */
  trust: string[];
  project: string; repo: string; baseBranch: string; integration: 'local' | 'github';
  remote?: string; commitName?: string; commitEmail?: string;
  /** A provider table from docs/examples/providers.toml to copy in, e.g. openrouter-haiku55. */
  provider?: string;
  force: boolean;
};

/** Writes config.toml through renderConfig, so it's checked exactly as harnessd will read it. Returns the path. */
export function writeSetup(home: Home, o: SetupOptions): string {
  if (fs.existsSync(home.config) && !o.force) throw new SetupError(`${home.config} exists; re-run with --force to replace it`);
  for (const [v, what] of [[o.device, '--device'], [o.principal, '--principal'], [o.project, '--project']] as const) {
    if (!ID.test(v)) throw new SetupError(`${what} must match ${ID}`);
  }
  if (!fs.existsSync(home.deviceKey)) throw new SetupError('no device key yet: run harness setup keygen first');
  const own = devicePublicKey(home);
  const devices: Record<string, { human: string; key: string }> = { [o.device]: { human: o.principal, key: own } };
  for (const t of o.trust) {
    const m = /^([A-Za-z0-9_-]{1,64})=([A-Za-z0-9_-]{1,64}):(ed25519:\S+)$/.exec(t);
    if (!m) throw new SetupError(`--trust-device ${t}: use <device_id>=<human_id>:ed25519:…`);
    const [, id, human, text] = m as unknown as [string, string, string, string];
    const k = key(text, `--trust-device ${id}`);
    if (id === o.device && k !== own) throw new SetupError(`--trust-device ${id} is this device, with a key other than this device's own`);
    if (k === own && id !== o.device) throw new SetupError(`--trust-device ${id} has this device's own key`);
    devices[id] = { human, key: k };
  }
  const serverKey = key(o.serverKey, '--server-key');
  if (Object.values(devices).some((d) => d.key === serverKey)) throw new SetupError('--server-key is a device\'s key, not the coordinator\'s');
  if (!path.isAbsolute(o.repo) || !fs.existsSync(path.join(o.repo, '.git'))) throw new SetupError(`--repo ${o.repo} must be the absolute path of a git clone`);
  const github = o.integration === 'github';
  if (github && !(o.remote && o.commitName && o.commitEmail)) throw new SetupError('--integration github needs --remote, --commit-name and --commit-email (your GitHub noreply address)');
  let providers: Record<string, unknown> | undefined;
  if (o.provider) {
    const table = (parse(fs.readFileSync(EXAMPLE_PROVIDERS, 'utf8')).providers as Record<string, unknown> | undefined)?.[o.provider];
    if (!table) throw new SetupError(`no [providers.${o.provider}] in docs/examples/providers.toml`);
    providers = { [o.provider]: table };
  }
  const raw = {
    device_id: o.device, principal: o.principal, server_url: o.serverUrl, auth: 'device-key', server_key: serverKey,
    trust: { devices },
    limits: { max_concurrent_agents: PILOT.maxConcurrentAgents },
    agents: { max_budget_usd: PILOT.maxBudgetUsd, daily_budget_usd: PILOT.dailyBudgetUsd, ...(o.provider ? { provider: o.provider } : {}) },
    ...(providers ? { providers } : {}),
    ui: { port: PILOT.uiPort },
    projects: [{
      id: o.project, repo: o.repo, base_branch: o.baseBranch, integration: o.integration,
      ...(github ? { remote: o.remote, commit_name: o.commitName, commit_email: o.commitEmail } : {}),
    }],
  };
  let text: string;
  try { text = renderConfig(raw); } catch (e) { throw new SetupError((e as Error).message); }
  fs.mkdirSync(home.root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(home.config, text, { mode: 0o600 });
  fs.chmodSync(home.config, 0o600);
  return home.config;
}
