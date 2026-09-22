/** Forwarding logic for mp-hook, separate from the entry point so it can be tested in-process. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const EMPTY = "{}";

/** PreToolUse may wait while a review freezes a file; everything else should be quick. */
function timeoutFor(event: string): number {
  return event === "pre-tool-use" ? 290_000 : 25_000;
}

export function eventSlug(hookEventName: string): string {
  return hookEventName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function forward(vendor: string, raw: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  let payload: { hook_event_name?: unknown };
  try {
    payload = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  const event = typeof payload.hook_event_name === "string" ? eventSlug(payload.hook_event_name) : "";
  if (!/^[a-z-]+$/.test(event)) return EMPTY;

  const home = env.MP_HOME || join(homedir(), ".multiplayer");
  const info = JSON.parse(await readFile(join(home, "daemon.json"), "utf8")) as { port: number; token: string };
  const res = await fetch(`http://127.0.0.1:${info.port}/v1/hooks/${vendor}/${event}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${info.token}`,
      "content-type": "application/json",
      "x-mp-agent-id": env.MP_AGENT_ID ?? "",
    },
    body: raw,
    signal: AbortSignal.timeout(timeoutFor(event)),
  });
  if (!res.ok) return EMPTY;
  const text = (await res.text()).trim();
  if (!text) return EMPTY;
  JSON.parse(text); // only ever print valid JSON
  return text;
}
