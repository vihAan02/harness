/*---------------------------------------------------------------------------------------------
 *  Harness: the main-process side of multiplayer. Starts and talks to mp-daemon.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IDaemonStatus, IMultiplayerMainService, IRoomStreamMessage } from '../common/multiplayer.js';

interface IDaemonInfo { readonly pid: number; readonly port: number; readonly token: string }

const START_TIMEOUT_MS = 15_000;

export class MultiplayerMainService extends Disposable implements IMultiplayerMainService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidRoomMessage = this._register(new Emitter<IRoomStreamMessage>());
	readonly onDidRoomMessage: Event<IRoomStreamMessage> = this._onDidRoomMessage.event;

	private readonly home = process.env['MP_HOME'] || join(homedir(), '.multiplayer');
	private readonly watchers = new Map<string, AbortController>();
	private starting: Promise<IDaemonStatus> | undefined;

	constructor(
		private readonly logService: ILogService,
		private readonly appRoot: string,
	) {
		super();
		this._register({ dispose: () => { for (const w of this.watchers.values()) { w.abort(); } this.watchers.clear(); } });
	}

	private async readInfo(): Promise<IDaemonInfo | undefined> {
		try {
			return JSON.parse(await fs.readFile(join(this.home, 'daemon.json'), 'utf8')) as IDaemonInfo;
		} catch {
			return undefined;
		}
	}

	private async healthy(info: IDaemonInfo | undefined): Promise<boolean> {
		if (!info) {
			return false;
		}
		try {
			const res = await fetch(`http://127.0.0.1:${info.port}/v1/health`, { headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(2000) });
			return res.ok;
		} catch {
			return false;
		}
	}

	/** In a dev checkout, mp-daemon lives in the multiplayer-ai repo that contains apps/ide/vscode. */
	private daemonEntry(): string {
		return process.env['HARNESS_DAEMON_ENTRY'] || resolve(this.appRoot, '..', '..', '..', 'packages', 'daemon', 'src', 'main.ts');
	}

	ensureDaemon(): Promise<IDaemonStatus> {
		if (!this.starting) {
			this.starting = this.doEnsureDaemon().finally(() => this.starting = undefined);
		}
		return this.starting;
	}

	private async doEnsureDaemon(): Promise<IDaemonStatus> {
		if (await this.healthy(await this.readInfo())) {
			return { running: true };
		}
		const node = process.env['HARNESS_NODE'] || 'node';
		const entry = this.daemonEntry();
		this.logService.info(`[harness] starting mp-daemon: ${node} ${entry}`);
		try {
			// Detached: the daemon outlives window reloads and IDE restarts, and serves every window.
			const child = cp.spawn(node, ['--no-deprecation', entry], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
			child.on('error', err => this.logService.error('[harness] could not start mp-daemon', err));
			child.unref();
		} catch (err) {
			return { running: false, error: `Could not start mp-daemon (${node} ${entry}): ${String(err)}` };
		}
		const deadline = Date.now() + START_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await new Promise(r => setTimeout(r, 250));
			if (await this.healthy(await this.readInfo())) {
				return { running: true };
			}
		}
		return { running: false, error: `mp-daemon didn't start. Make sure Node 22.18+ is on PATH (or set HARNESS_NODE) and that ${entry} exists.` };
	}

	async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
		let info = await this.readInfo();
		if (!info || !(await this.healthy(info))) {
			const status = await this.ensureDaemon();
			if (!status.running) {
				throw new Error(status.error ?? 'mp-daemon is not running');
			}
			info = await this.readInfo();
		}
		const res = await fetch(`http://127.0.0.1:${info!.port}/v1${path}`, {
			method,
			headers: { authorization: `Bearer ${info!.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
		const text = await res.text();
		const json = text ? JSON.parse(text) as unknown : {};
		if (!res.ok) {
			const message = (json as { error?: { message?: string } }).error?.message ?? `mp-daemon returned ${res.status}`;
			throw new Error(message);
		}
		return json;
	}

	async watchRoom(roomId: string): Promise<void> {
		if (this.watchers.has(roomId)) {
			return;
		}
		const ctrl = new AbortController();
		this.watchers.set(roomId, ctrl);
		void this.pump(roomId, ctrl.signal);
	}

	async unwatchRoom(roomId: string): Promise<void> {
		this.watchers.get(roomId)?.abort();
		this.watchers.delete(roomId);
	}

	/** Follows the room's server-sent events, reconnecting (and re-snapshotting) until unwatched. */
	private async pump(roomId: string, signal: AbortSignal): Promise<void> {
		let backoff = 500;
		while (!signal.aborted) {
			try {
				const info = await this.readInfo();
				if (!info) {
					throw new Error('mp-daemon is not running');
				}
				const res = await fetch(`http://127.0.0.1:${info.port}/v1/rooms/${encodeURIComponent(roomId)}/events`, { headers: { authorization: `Bearer ${info.token}` }, signal });
				if (!res.ok || !res.body) {
					throw new Error(`room events returned ${res.status}`);
				}
				backoff = 500;
				const decoder = new TextDecoder();
				let buf = '';
				for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
					buf += decoder.decode(chunk, { stream: true });
					let cut: number;
					while ((cut = buf.indexOf('\n\n')) >= 0) {
						const block = buf.slice(0, cut);
						buf = buf.slice(cut + 2);
						let kind = '';
						const data: string[] = [];
						for (const line of block.split('\n')) {
							if (line.startsWith('event: ')) { kind = line.slice(7); }
							else if (line.startsWith('data: ')) { data.push(line.slice(6)); }
						}
						if (kind && data.length) {
							this._onDidRoomMessage.fire({ roomId, kind, data: JSON.parse(data.join('\n')) } as IRoomStreamMessage);
						}
					}
				}
			} catch (err) {
				if (signal.aborted) {
					return;
				}
				this.logService.trace(`[harness] room ${roomId} events interrupted: ${String(err)}`);
			}
			this._onDidRoomMessage.fire({ roomId, kind: 'status', data: { connected: false } });
			await new Promise(r => setTimeout(r, backoff));
			backoff = Math.min(backoff * 2, 15_000);
		}
	}
}
