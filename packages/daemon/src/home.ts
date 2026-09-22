import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { Vendor } from "@mp/protocol";

export interface Identity {
  memberId: string;
  name: string;
  deviceId: string;
}

export interface RoomRecord {
  roomId: string;
  relayUrl: string;
  secret: string;
  /** Normalized repo identity, e.g. `github.com/acme/app`. */
  repoKey: string;
  joinedAt: number;
}

export interface LocalAgent {
  id: string;
  roomId: string;
  repoKey: string;
  /** The main checkout the agent was created from. */
  repoRoot: string;
  worktree: string;
  branch: string;
  baseBranch: string;
  /** Ref the live diff is measured against, e.g. `origin/main`. */
  baseRef: string;
  vendor: Vendor;
  name: string;
  task?: string;
  createdAt: number;
  /** Ids of room messages already handed to this agent (most recent last, capped). */
  delivered: string[];
}

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
}

export function defaultHome(): string {
  return process.env.MP_HOME || join(homedir(), ".multiplayer");
}

/** Writes a file only the current user can read, creating private parent directories as needed. */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

export function randomId(bytes = 6): string {
  return randomBytes(bytes).toString("base64url").replace(/[-_]/g, "x").toLowerCase();
}

/** Files under MP_HOME. Everything is written atomically; files holding secrets are 0600. */
export class Home {
  readonly dir: string;

  constructor(dir: string = defaultHome()) {
    this.dir = dir;
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  get worktreesDir(): string {
    return this.path("worktrees");
  }

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    await mkdir(this.worktreesDir, { recursive: true, mode: 0o700 });
  }

  private async readJson<T>(name: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.path(name), "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    const target = this.path(name);
    const tmp = `${target}.${process.pid}.${randomId(3)}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, target);
  }

  async identity(): Promise<Identity> {
    const existing = await this.readJson<Identity>("identity.json");
    if (existing) return existing;
    let name = "";
    try {
      name = userInfo().username;
    } catch {
      name = "someone";
    }
    const host = hostname().split(".")[0]?.toLowerCase().replace(/[^a-z0-9-]/g, "") || "device";
    const identity: Identity = { memberId: `m_${randomId(8)}`, name, deviceId: `${host}-${randomId(3)}` };
    await this.writeJson("identity.json", identity);
    return identity;
  }

  async setName(name: string): Promise<Identity> {
    const identity = { ...(await this.identity()), name };
    await this.writeJson("identity.json", identity);
    return identity;
  }

  async rooms(): Promise<RoomRecord[]> {
    return (await this.readJson<RoomRecord[]>("rooms.json")) ?? [];
  }

  async saveRooms(rooms: RoomRecord[]): Promise<void> {
    await this.writeJson("rooms.json", rooms);
  }

  async agents(): Promise<LocalAgent[]> {
    return (await this.readJson<LocalAgent[]>("agents.json")) ?? [];
  }

  async saveAgents(agents: LocalAgent[]): Promise<void> {
    await this.writeJson("agents.json", agents);
  }

  async daemonInfo(): Promise<DaemonInfo | null> {
    return this.readJson<DaemonInfo>("daemon.json");
  }

  async writeDaemonInfo(info: DaemonInfo): Promise<void> {
    await this.writeJson("daemon.json", info);
  }

  async clearDaemonInfo(pid: number): Promise<void> {
    const info = await this.daemonInfo();
    if (info?.pid === pid) await rm(this.path("daemon.json"), { force: true });
  }
}
