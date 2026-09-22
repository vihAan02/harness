import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Daemon, type DaemonOptions } from "../src/index.ts";
import { git } from "../src/git.ts";
import { LoopbackRelay } from "../src/testing/loopback.ts";

const cleanups: string[] = [];

export async function tmp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `mp-${prefix}-`)));
  cleanups.push(dir);
  return dir;
}

export async function cleanupTmp(): Promise<void> {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

export const SEED: Record<string, string> = {
  "src/auth/session.ts": "export const session = 1;\nexport const ttl = 60;\nexport const name = 'sid';\n",
  "src/auth/middleware.ts": "export function auth() {\n  return true;\n}\n",
  "src/billing/stripe.ts": "export const stripe = {};\n",
  "src/routes.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n",
  "package.json": '{ "name": "app" }\n',
  "package-lock.json": '{ "lockfileVersion": 3 }\n',
  "README.md": "# app\n",
};

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
}

const ident = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

export async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ["add", "-A"]);
  await git(dir, [...ident, "commit", "-q", "-m", message]);
}

/** A bare "origin" with one commit on main, plus clones for two teammates. */
export async function makeTeamRepos() {
  const root = await tmp("repos");
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  await git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  await git(root, ["init", "-q", "-b", "main", seed]);
  await writeFiles(seed, SEED);
  await commitAll(seed, "initial");
  await git(seed, ["remote", "add", "origin", origin]);
  await git(seed, ["push", "-q", "origin", "main"]);

  const clone = async (name: string) => {
    const dir = join(root, name);
    await git(root, ["clone", "-q", origin, dir]);
    return realpath(dir);
  };
  return { origin, sam: await clone("sam"), ria: await clone("ria") };
}

export const ROOM_ID = "0123456789abcdef01234567";
export const LOOPBACK_INVITE = `http://loopback.test/join/${ROOM_ID}#${"s".repeat(32)}`;

export async function makeDaemon(relay: LoopbackRelay, name: string, opts: Partial<DaemonOptions> = {}): Promise<Daemon> {
  const daemon = new Daemon({
    home: await tmp(`home-${name.toLowerCase()}`),
    linkFactory: (_room, identity) => relay.link({ id: identity.memberId, name: identity.name }),
    watch: false,
    fetchOnCreate: false,
    diffDebounceMs: 5,
    statusDebounceMs: 5,
    heartbeatMs: 60_000,
    holdTimeoutMs: 2_000,
    ...opts,
  });
  await daemon.start();
  daemon.identity = await daemon.home.setName(name);
  return daemon;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `fn` returns a truthy value. */
export async function eventually<T>(fn: () => T | Promise<T>, timeoutMs = 3000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}

export { ident };
