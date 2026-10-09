// The CLI's line to this Mac's harnessd (PB2b; D-112, D-117): the owner-only Unix socket and token the UI bridge
// uses (`~/.harness/run/harnessd.sock`, `uirpc.token`). A lifecycle command with device keys is signed by harnessd,
// from its own view, with the device key the CLI never reads; the CLI says what the human is approving and asks for it.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { untrustedText, type Home } from '@harness/daemon';
import type { DispatchKind } from '@harness/protocol';
import { CliError } from './client.ts';

export type DispatchRequest = {
  project_id: string; kind: DispatchKind; task_id: string;
  /** The command's own args, without `dispatch` (protocol.md §11). */
  args: Record<string, unknown>;
  /** What the human saw; harnessd refuses with `conflict` when its view differs. */
  expected: Record<string, unknown>;
  command_id: string;
};

const MAX_REPLY = 1024 * 1024;

/** One request to harnessd's socket, one reply. Its errors are CliErrors that say what to do. */
export async function harnessd(home: Home, method: string, params: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
  const run = path.join(home.root, 'run');
  const socket = path.join(run, 'harnessd.sock');
  const tokenFile = path.join(run, 'uirpc.token');
  let token: string;
  try {
    if (fs.statSync(tokenFile).mode & 0o077) throw new CliError(`${tokenFile} must be owner-only`);
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError('harnessd isn\'t running on this Mac (no uirpc token): start it, then try again');
  }
  return new Promise((resolve, reject) => {
    const id = `cli-${process.pid}-${Date.now()}`;
    const c = net.connect(socket);
    let buf = '';
    const done = (e: Error | null, v?: unknown) => { clearTimeout(timer); c.destroy(); if (e) reject(e); else resolve(v); };
    const timer = setTimeout(() => done(new CliError(`harnessd didn't answer ${method} in ${timeoutMs / 1000}s`)), timeoutMs);
    c.setEncoding('utf8');
    c.on('error', (e: NodeJS.ErrnoException) => done(new CliError(e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
      ? 'harnessd isn\'t running on this Mac (its socket is gone): start it, then try again'
      : `can't talk to harnessd: ${e.message}`)));
    c.on('connect', () => c.write(`${JSON.stringify({ id, token, method, params })}\n`));
    c.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_REPLY) return done(new CliError('harnessd\'s answer was too long'));
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let m: { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
      try { m = JSON.parse(buf.slice(0, nl)) as typeof m; } catch { return done(new CliError('harnessd answered with something that isn\'t JSON')); }
      if (m.ok === true) return done(null, m.result);
      const code = typeof m.error?.code === 'string' ? m.error.code : 'error';
      const message = untrustedText(m.error?.message, 400);
      done(new CliError(
        code === 'conflict' ? `it changed since you looked: ${message}. Look again (harness status), then retry`
          : code === 'unauthorized' ? 'harnessd refused the CLI\'s token: is this the same HARNESS_HOME harnessd uses?'
            : code === 'not_available' ? `this harnessd can't sign that yet: ${message}`
              : `${code}: ${message}`));
    });
  });
}

/** Asks harnessd to sign a lifecycle dispatch from its own view and send the command (D-112; protocol.md §12). */
export function dispatchVia(home: Home, req: DispatchRequest): Promise<unknown> {
  return harnessd(home, 'dispatch', req as unknown as Record<string, unknown>);
}
