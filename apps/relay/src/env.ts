import type { EngineOptions } from "@mp/room";
import type { RoomDO } from "./room.ts";

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDO>;
  /** When set, `POST /rooms` requires `Authorization: Bearer <CREATE_TOKEN>`. */
  CREATE_TOKEN?: string;
  AGENT_OFFLINE_MS?: string;
  LOCK_STALE_MS?: string;
  LOCK_CLEAN_GRACE_MS?: string;
}

declare global {
  namespace Cloudflare {
    interface Env {
      ROOMS: DurableObjectNamespace<RoomDO>;
      CREATE_TOKEN?: string;
      AGENT_OFFLINE_MS?: string;
      LOCK_STALE_MS?: string;
      LOCK_CLEAN_GRACE_MS?: string;
    }
  }
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function engineOptionsFromEnv(env: Env): Partial<EngineOptions> {
  const out: Partial<EngineOptions> = { newId: () => crypto.randomUUID() };
  const offline = num(env.AGENT_OFFLINE_MS);
  const stale = num(env.LOCK_STALE_MS);
  const grace = num(env.LOCK_CLEAN_GRACE_MS);
  if (offline !== undefined) out.agentOfflineMs = offline;
  if (stale !== undefined) out.lockStaleMs = stale;
  if (grace !== undefined) out.lockCleanGraceMs = grace;
  return out;
}
