// Per-agent resources on this machine: port blocks (D-38, D-68) and vendor config dirs (D-65).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic, type Home } from './home.ts';

export type PortBlock = { base: number; count: number };

/**
 * Fixed-size port blocks from the local range, which sits below every OS's ephemeral range (D-68).
 * Allocations are persisted, so a restart never hands a block out twice. One block per active task,
 * so the block count also enforces max_concurrent_agents (D-38).
 */
export class PortAllocator {
  file: string;
  range: [number, number];
  blockSize: number;
  maxBlocks: number;

  constructor(home: Home, range: [number, number], blockSize: number, maxBlocks: number) {
    this.file = home.ports;
    this.range = range;
    this.blockSize = blockSize;
    this.maxBlocks = maxBlocks;
  }

  list(): Record<string, PortBlock> {
    return readJson<Record<string, PortBlock>>(this.file, {});
  }

  /** The owner's block, allocating one if needed. `count` (the repo's ports.per_agent) can only shrink it. */
  async allocate(owner: string, count = this.blockSize): Promise<PortBlock> {
    const all = this.list();
    const existing = all[owner];
    if (existing) return existing;
    if (Object.keys(all).length >= this.maxBlocks) throw new Error(`already at max_concurrent_agents (${this.maxBlocks})`);
    const taken = new Set(Object.values(all).map((b) => b.base));
    for (let base = this.range[0]; base + this.blockSize - 1 <= this.range[1]; base += this.blockSize) {
      if (taken.has(base) || !(await allFree(base, this.blockSize))) continue;
      const block = { base, count: Math.min(count, this.blockSize) };
      writeJsonAtomic(this.file, { ...all, [owner]: block });
      return block;
    }
    throw new Error(`no free block of ${this.blockSize} ports in ${this.range.join('..')}`);
  }

  release(owner: string): void {
    const { [owner]: _released, ...rest } = this.list();
    writeJsonAtomic(this.file, rest);
  }
}

async function allFree(base: number, count: number): Promise<boolean> {
  for (let port = base; port < base + count; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
      s.listen(port, '127.0.0.1');
    });
    if (!free) return false;
  }
  return true;
}

/** The env an agent gets for its ports (local-runtime §5). */
export function portEnv(block: PortBlock): Record<string, string> {
  return { PORT: String(block.base), HARNESS_PORT_BASE: String(block.base), HARNESS_PORT_COUNT: String(block.count) };
}

const AGENT_ID = /^agent_[a-z0-9]{1,40}$/;

/**
 * The agent's own CLAUDE_CONFIG_DIR (D-65). It isolates transcripts and session state, keeps the
 * owner's ~/.claude untouched, and is part of the session's resume key (SP-07).
 */
export function agentConfigDir(home: Home, agentId: string): string {
  if (!AGENT_ID.test(agentId)) throw new Error(`invalid agent id: ${agentId}`);
  const dir = path.join(home.vendor, agentId, 'claude-config');
  ensureDir(dir);
  fs.chmodSync(dir, 0o700);
  return dir;
}
