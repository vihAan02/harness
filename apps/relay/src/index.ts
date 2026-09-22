import { PROTOCOL_VERSION } from "@mp/protocol";
import type { Env } from "./env.ts";
import { hashSecret, newRoomId, newSecret } from "./secrets.ts";

export { RoomDO } from "./room.ts";

const ROOM_ID = /^[0-9a-f]{24}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  if (env.CREATE_TOKEN && request.headers.get("Authorization") !== `Bearer ${env.CREATE_TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }
  let repo: string | undefined;
  if (request.headers.get("content-type")?.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { repo?: unknown };
    if (typeof body.repo === "string" && body.repo.length <= 500) repo = body.repo;
  }
  const roomId = newRoomId();
  const secret = newSecret();
  await env.ROOMS.get(env.ROOMS.idFromName(roomId)).init(roomId, await hashSecret(secret), repo);
  return json({ roomId, secret, protocol: PROTOCOL_VERSION }, 201);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, protocol: PROTOCOL_VERSION });
    }
    if (request.method === "POST" && url.pathname === "/rooms") {
      return createRoom(request, env);
    }
    if (request.method === "GET" && parts.length === 3 && parts[0] === "rooms" && parts[2] === "ws") {
      const roomId = parts[1]!;
      if (!ROOM_ID.test(roomId)) return json({ error: "room not found" }, 404);
      return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(request);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
