/*---------------------------------------------------------------------------------------------
 *  Harness: the workbench's view of the multiplayer room.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IObservable } from '../../../../base/common/observable.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IAgent, IIdentity, ILaunchSpec, ILocalAgent, IRepoInfo, IRoomEvent, IRoomSnapshot, IStatusRow, Vendor } from '../../../../platform/multiplayer/common/multiplayer.js';

export type DaemonState = 'starting' | 'running' | 'error';

export interface IMultiplayerState {
	readonly daemon: DaemonState;
	readonly error?: string;
	/** The repo of the first workspace folder, if it is a git repo. */
	readonly repo?: IRepoInfo;
	readonly connected: boolean;
	readonly room?: IRoomSnapshot;
	readonly localAgents: readonly ILocalAgent[];
	readonly identity?: IIdentity;
	/** "What is everyone doing?", recomputed by mp-daemon after each change. */
	readonly rows: readonly IStatusRow[];
}

export const EMPTY_STATE: IMultiplayerState = { daemon: 'starting', connected: false, localAgents: [], rows: [] };

export const IMultiplayerService = createDecorator<IMultiplayerService>('multiplayerService');

export interface IMultiplayerService {
	readonly _serviceBrand: undefined;

	readonly state: IObservable<IMultiplayerState>;
	/** Fires for every room event (after the state has been updated). */
	readonly onDidRoomEvent: Event<IRoomEvent>;

	refresh(): Promise<void>;
	createRoom(relayUrl: string): Promise<void>;
	joinRoom(invite: string): Promise<void>;
	createAgent(vendor: Vendor, name: string, task?: string): Promise<ILocalAgent>;
	/** The command, args and env to start an agent's terminal session (prepared by mp-daemon). */
	launchSpec(agent: ILocalAgent, task?: string): Promise<ILaunchSpec>;
	removeAgent(agentId: string, force?: boolean): Promise<void>;
	sendMessage(body: string, to?: { type: 'agent' | 'member'; id: string }[]): Promise<void>;

	agentLabel(agentId: string): string;
	isLocal(agentId: string): boolean;
}

/** `Sam's auth-refactor (Claude)` */
export function agentLabel(room: IRoomSnapshot | undefined, agentId: string): string {
	const agent: IAgent | undefined = room?.agents.find(a => a.id === agentId);
	if (!agent) {
		return agentId;
	}
	const owner = room?.members.find(m => m.id === agent.memberId)?.name ?? 'someone';
	return `${owner}'s ${agent.name} (${agent.vendor === 'claude' ? 'Claude' : 'Codex'})`;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
function upsert<T>(list: T[], item: T, key: (t: T) => string): T[] {
	const k = key(item);
	const i = list.findIndex(x => key(x) === k);
	if (i >= 0) {
		const next = list.slice();
		next[i] = item;
		return next;
	}
	return [...list, item];
}

/**
 * Applies a relay event to a snapshot, returning a new snapshot. Mirrors RoomMirror in
 * packages/room (the daemon's replica), including per-thread message trimming.
 */
export function applyRoomEvent(room: IRoomSnapshot, e: IRoomEvent, maxMessagesPerThread = 500): IRoomSnapshot {
	const r = { ...room, seq: Math.max(room.seq, e.seq) } as Mutable<IRoomSnapshot>;
	const p = e as unknown as Record<string, any>;
	switch (e.type) {
		case 'member.updated': r.members = upsert(r.members, p.member, m => m.id); break;
		case 'agent.updated': r.agents = upsert(r.agents, p.agent, a => a.id); break;
		case 'agent.removed': r.agents = r.agents.filter(a => a.id !== p.agentId); break;
		case 'plan.updated': r.plans = upsert(r.plans, p.plan, x => x.agentId); break;
		case 'plan.removed': r.plans = r.plans.filter(x => x.agentId !== p.agentId); break;
		case 'claim.added': r.claims = upsert(r.claims, p.claim, c => c.id); break;
		case 'claim.released': r.claims = r.claims.filter(c => !p.claimIds.includes(c.id)); break;
		case 'lock.acquired': for (const l of p.locks) { r.locks = upsert(r.locks, l, x => x.path); } break;
		case 'lock.released': r.locks = r.locks.filter(l => !(p.paths.includes(l.path) && l.agentId === p.agentId)); break;
		case 'diff.updated': r.diffs = upsert(r.diffs, p.diff, d => d.agentId); break;
		case 'diff.removed': r.diffs = r.diffs.filter(d => d.agentId !== p.agentId); break;
		case 'thread.opened': r.threads = upsert(r.threads, p.thread, t => t.id); break;
		case 'message.posted': {
			const m = p.message;
			const inThread = [...r.messages.filter(x => x.threadId === m.threadId), m];
			const drop = new Set(inThread.slice(0, Math.max(0, inThread.length - maxMessagesPerThread)).map(x => x.id));
			r.messages = [...r.messages.filter(x => !drop.has(x.id)), m];
			break;
		}
		case 'review.updated': r.reviews = upsert(r.reviews, p.review, x => x.id); break;
		case 'freeze.set': r.freezes = upsert(r.freezes, p.freeze, x => x.id); break;
		case 'freeze.cleared': r.freezes = r.freezes.filter(f => f.id !== p.freezeId); break;
	}
	return r;
}
