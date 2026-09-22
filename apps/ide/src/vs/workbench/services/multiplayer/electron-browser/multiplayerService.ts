/*---------------------------------------------------------------------------------------------
 *  Harness: workbench multiplayer service (desktop). Talks to the main process over IPC.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ILaunchSpec, ILocalAgent, IMultiplayerMainService, IRepoInfo, IRoomEvent, IRoomStreamMessage, IStatusRow, MULTIPLAYER_CHANNEL, Vendor } from '../../../../platform/multiplayer/common/multiplayer.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { agentLabel, applyRoomEvent, EMPTY_STATE, IMultiplayerService, IMultiplayerState } from '../common/multiplayer.js';

registerMainProcessRemoteService(IMultiplayerMainService, MULTIPLAYER_CHANNEL);

export class MultiplayerService extends Disposable implements IMultiplayerService {

	declare readonly _serviceBrand: undefined;

	private readonly _state = observableValue<IMultiplayerState>(this, EMPTY_STATE);
	readonly state: IObservable<IMultiplayerState> = this._state;

	private readonly _onDidRoomEvent = this._register(new Emitter<IRoomEvent>());
	readonly onDidRoomEvent: Event<IRoomEvent> = this._onDidRoomEvent.event;

	private readonly rowsScheduler = this._register(new RunOnceScheduler(() => this.fetchRows(), 250));
	private watchedRoom: string | undefined;

	constructor(
		@IMultiplayerMainService private readonly main: IMultiplayerMainService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.main.onDidRoomMessage(m => this.onRoomMessage(m)));
		this._register(this.workspace.onDidChangeWorkspaceFolders(() => this.refresh()));
		void this.refresh();
	}

	private set(patch: Partial<IMultiplayerState>): void {
		this._state.set({ ...this._state.get(), ...patch }, undefined);
	}

	private get roomId(): string | undefined {
		return this._state.get().repo?.room?.roomId;
	}

	async refresh(): Promise<void> {
		const status = await this.main.ensureDaemon();
		if (!status.running) {
			this.set({ daemon: 'error', error: status.error });
			return;
		}
		const folder = this.workspace.getWorkspace().folders[0];
		if (!folder || folder.uri.scheme !== 'file') {
			this.set({ daemon: 'running', error: undefined, repo: undefined });
			return;
		}
		let repo: IRepoInfo | undefined;
		try {
			repo = await this.main.request('GET', `/repos/resolve?path=${encodeURIComponent(folder.uri.fsPath)}`) as IRepoInfo;
		} catch (err) {
			this.logService.trace(`[harness] ${folder.uri.fsPath} is not a git repo: ${String(err)}`);
		}
		this.set({ daemon: 'running', error: undefined, repo });
		const roomId = repo?.room?.roomId;
		if (roomId && roomId !== this.watchedRoom) {
			if (this.watchedRoom) {
				await this.main.unwatchRoom(this.watchedRoom);
			}
			this.watchedRoom = roomId;
			await this.main.watchRoom(roomId);
		}
	}

	private onRoomMessage(m: IRoomStreamMessage): void {
		if (m.roomId !== this.roomId) {
			return;
		}
		const state = this._state.get();
		switch (m.kind) {
			case 'snapshot':
				this.set({ connected: m.data.connected, room: m.data.room, localAgents: m.data.localAgents, identity: m.data.identity });
				this.rowsScheduler.schedule(0);
				return;
			case 'status':
				this.set({ connected: m.data.connected });
				return;
			case 'stream': {
				if (!state.room) {
					return;
				}
				const prev = state.room.streams[m.data.agentId] ?? [];
				const streams = { ...state.room.streams, [m.data.agentId]: [...prev, ...m.data.events].slice(-500) };
				this.set({ room: { ...state.room, streams } });
				return;
			}
			case 'event':
				if (!state.room) {
					return;
				}
				this.set({ room: applyRoomEvent(state.room, m.data) });
				this._onDidRoomEvent.fire(m.data);
				if (m.data.type !== 'message.posted' && m.data.type !== 'thread.opened') {
					this.rowsScheduler.schedule();
				}
				if (m.data.type === 'agent.updated' || m.data.type === 'agent.removed') {
					void this.refreshLocalAgents();
				}
				return;
		}
	}

	private async fetchRows(): Promise<void> {
		const roomId = this.roomId;
		if (!roomId) {
			return;
		}
		try {
			const res = await this.main.request('GET', `/rooms/${encodeURIComponent(roomId)}/status`) as { rows: IStatusRow[] };
			this.set({ rows: res.rows });
		} catch (err) {
			this.logService.warn(`[harness] could not load room status: ${String(err)}`);
		}
	}

	private async refreshLocalAgents(): Promise<void> {
		const roomId = this.roomId;
		const all = await this.main.request('GET', '/agents') as ILocalAgent[];
		this.set({ localAgents: all.filter(a => a.roomId === roomId) });
	}

	private workspacePath(): string {
		const folder = this.workspace.getWorkspace().folders[0];
		if (!folder || folder.uri.scheme !== 'file') {
			throw new Error('Open a folder that is a git repository first.');
		}
		return folder.uri.fsPath;
	}

	async createRoom(relayUrl: string): Promise<void> {
		await this.main.request('POST', '/rooms', { repoPath: this.workspacePath(), relayUrl });
		await this.refresh();
	}

	async joinRoom(invite: string): Promise<void> {
		await this.main.request('POST', '/rooms/join', { repoPath: this.workspacePath(), invite });
		await this.refresh();
	}

	async createAgent(vendor: Vendor, name: string, task?: string): Promise<ILocalAgent> {
		const agent = await this.main.request('POST', '/agents', { repoPath: this.workspacePath(), name, vendor, ...(task ? { task } : {}) }) as ILocalAgent;
		await this.refreshLocalAgents();
		return agent;
	}

	async launchSpec(agent: ILocalAgent, task?: string): Promise<ILaunchSpec> {
		return await this.main.request('POST', `/agents/${encodeURIComponent(agent.id)}/launch/${agent.vendor}`, task ? { task } : {}) as ILaunchSpec;
	}

	async removeAgent(agentId: string, force = false): Promise<void> {
		await this.main.request('DELETE', `/agents/${encodeURIComponent(agentId)}${force ? '?force=1' : ''}`);
		await this.refreshLocalAgents();
	}

	async sendMessage(body: string, to: { type: 'agent' | 'member'; id: string }[] = []): Promise<void> {
		const roomId = this.roomId;
		if (!roomId) {
			throw new Error('This repo is not in a room yet.');
		}
		await this.main.request('POST', `/rooms/${encodeURIComponent(roomId)}/messages`, { body, to });
	}

	agentLabel(agentId: string): string {
		return agentLabel(this._state.get().room, agentId);
	}

	isLocal(agentId: string): boolean {
		return this._state.get().localAgents.some(a => a.id === agentId);
	}
}

registerSingleton(IMultiplayerService, MultiplayerService, InstantiationType.Delayed);
