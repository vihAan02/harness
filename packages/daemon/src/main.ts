#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { Daemon } from "./daemon.ts";
import { Home } from "./home.ts";
import { startServer } from "./server.ts";

const DEFAULT_PORT = 47800;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const home = new Home();
  await home.ensure();

  const existing = await home.daemonInfo();
  if (existing && existing.pid !== process.pid && alive(existing.pid)) {
    console.log(`mp-daemon is already running (pid ${existing.pid}, port ${existing.port}).`);
    return;
  }

  const port = Number(process.env.MP_DAEMON_PORT ?? DEFAULT_PORT);
  const token = randomBytes(24).toString("base64url");
  const daemon = new Daemon({ home });
  await daemon.start();
  const server = await startServer(daemon, { port, token });
  await home.writeDaemonInfo({ pid: process.pid, port: server.port, token, startedAt: Date.now() });
  console.log(`mp-daemon listening on 127.0.0.1:${server.port} (home ${home.dir})`);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`mp-daemon stopping (${signal})`);
    await server.close();
    await daemon.stop();
    await home.clearDaemonInfo(process.pid);
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((err) => {
  console.error("mp-daemon failed to start:", err);
  process.exit(1);
});
