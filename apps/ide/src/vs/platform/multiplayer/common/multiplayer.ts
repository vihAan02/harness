/*---------------------------------------------------------------------------------------------
 *  Harness: multiplayer platform types shared by the main process and the workbench.
 *  These mirror the wire types of mp-daemon (packages/protocol in the multiplayer-ai repo).
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export type Vendor = 'claude' | 'codex';
export type AgentStatus = 'starting' | 'idle' | 'thinking' | 'editing' | 'running' | 'blocked' | 'waiting_permission' | 'waiting_review' | 'offline';

export interface IActorRef { readonly type: 'agent' | 'member'; readonly id: string }

export interface IMember { readonly id: string; readonly name: string; readonly online: boolean; readonly lastSeenAt: number }

export interface IAgent {
	readonly id: string;
	readonly memberId: string;
	readonly deviceId: string;
	readonly vendor: Vendor;
	readonly name: string;
	readonly status: AgentStatus;
	readonly task?: string;
	readonly branch?: string;
	readonly startedAt: number;
	readonly lastSeenAt: number;
}

export interface IPlanStep { readonly id: string; readonly text: string; readonly status: 'pending' | 'active' | 'done' | 'skipped' }
export interface IPlan { readonly agentId: string; readonly title: string; readonly summary?: string; readonly steps: readonly IPlanStep[]; readonly paths: readonly string[]; readonly updatedAt: number }
export interface IClaim { readonly id: string; readonly agentId: string; readonly pattern: string; readonly reason?: string }
export interface ILock { readonly path: string; readonly agentId: string; readonly acquiredAt: number }
export interface IHunk { readonly oldStart: number; readonly oldLines: number; readonly newStart: number; readonly newLines: number }
export interface IDiffFile { readonly path: string; readonly oldPath?: string; readonly status: string; readonly additions: number; readonly deletions: number; readonly hunks: readonly IHunk[]; readonly patch?: string }
export interface ILiveDiff { readonly agentId: string; readonly files: readonly IDiffFile[]; readonly updatedAt: number }
export interface IThread { readonly id: string; readonly kind: 'room' | 'direct' | 'group' | 'review'; readonly participants: readonly IActorRef[]; readonly topic?: string; readonly lastMessageAt: number }
export interface IMessage { readonly id: string; readonly threadId: string; readonly from: IActorRef; readonly to: readonly IActorRef[]; readonly kind: string; readonly body: string; readonly replyTo?: string; readonly urgent?: boolean; readonly createdAt: number }
export interface IReview { readonly id: string; readonly requesterAgentId: string; readonly command: string; readonly status: string; readonly affectedAgentIds: readonly string[] }
export interface IFreeze { readonly id: string; readonly reviewId: string; readonly scope: 'agents' | 'room'; readonly agentIds: readonly string[]; readonly paths: readonly string[] }
export interface IAgentEvent { readonly at: number; readonly kind: string; readonly role?: 'user' | 'assistant'; readonly text?: string; readonly tool?: string; readonly input?: string; readonly output?: string; readonly exitCode?: number }

export interface IRoomSnapshot {
	readonly roomId: string;
	readonly seq: number;
	readonly members: IMember[];
	readonly agents: IAgent[];
	readonly plans: IPlan[];
	readonly claims: IClaim[];
	readonly locks: ILock[];
	readonly diffs: ILiveDiff[];
	readonly threads: IThread[];
	readonly messages: IMessage[];
	readonly reviews: IReview[];
	readonly freezes: IFreeze[];
	readonly streams: Record<string, IAgentEvent[]>;
}

/** A room event as broadcast by the relay (see packages/protocol RoomEvent). */
export type IRoomEvent = { readonly seq: number; readonly at: number; readonly by: string | null; readonly type: string } & Record<string, unknown>;

export type Conflict =
	| { kind: 'collision'; path: string; with: string[]; overlappingLines: boolean }
	| { kind: 'in_foreign_claim'; path: string; claimPattern: string; owner: string }
	| { kind: 'claim_overlap'; pattern: string; otherPattern: string; with: string }
	| { kind: 'review'; reviewId: string; role: 'requester' | 'affected'; status: string; command: string }
	| { kind: 'frozen'; reviewId: string; paths: string[] };

/** One row of "What is everyone doing?". */
export interface IStatusRow {
	readonly agent: { id: string; name: string; vendor: Vendor; status: AgentStatus; owner: string; deviceId: string; branch?: string };
	readonly currentTask: string | null;
	readonly plan: { title: string; done: number; total: number; activeStep: string | null } | null;
	readonly claimedDirectories: string[];
	readonly filesBeingModified: { path: string; additions: number; deletions: number; locked: boolean }[];
	readonly conflicts: Conflict[];
}

/** An agent this machine runs (from mp-daemon's agents.json). */
export interface ILocalAgent {
	readonly id: string;
	readonly roomId: string;
	readonly repoKey: string;
	readonly worktree: string;
	readonly branch: string;
	readonly baseRef: string;
	readonly vendor: Vendor;
	readonly name: string;
	readonly task?: string;
}

export interface IIdentity { readonly memberId: string; readonly name: string; readonly deviceId: string }

export interface IRepoInfo {
	readonly root: string;
	readonly repoKey: string;
	readonly defaultBase: string;
	readonly room: { roomId: string; repoKey: string; relayUrl: string; connected: boolean; invite: string } | null;
}

export interface ILaunchSpec { readonly command: string; readonly args: string[]; readonly env: Record<string, string>; readonly cwd: string }

export interface IDaemonStatus {
	readonly running: boolean;
	readonly error?: string;
}

/** Messages from the room event stream, relayed from mp-daemon by the main process. */
export type IRoomStreamMessage =
	| { readonly roomId: string; readonly kind: 'snapshot'; readonly data: { connected: boolean; room: IRoomSnapshot; localAgents: ILocalAgent[]; identity: IIdentity } }
	| { readonly roomId: string; readonly kind: 'event'; readonly data: IRoomEvent }
	| { readonly roomId: string; readonly kind: 'stream'; readonly data: { agentId: string; events: IAgentEvent[] } }
	| { readonly roomId: string; readonly kind: 'status'; readonly data: { connected: boolean } };

export const MULTIPLAYER_CHANNEL = 'multiplayer';

export const IMultiplayerMainService = createDecorator<IMultiplayerMainService>('multiplayerMainService');

/**
 * Lives in the Electron main process (which, unlike the sandboxed window, may talk to mp-daemon on
 * localhost). Exposed to windows over IPC as the `multiplayer` channel.
 */
export interface IMultiplayerMainService {
	readonly _serviceBrand: undefined;

	readonly onDidRoomMessage: Event<IRoomStreamMessage>;

	/** Makes sure mp-daemon is running (starting it if needed). */
	ensureDaemon(): Promise<IDaemonStatus>;

	/** Calls mp-daemon's localhost API (`/v1` + path). Rejects with the daemon's error message. */
	request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<unknown>;

	/** Starts relaying a room's live event stream through `onDidRoomMessage`. Idempotent. */
	watchRoom(roomId: string): Promise<void>;
	unwatchRoom(roomId: string): Promise<void>;
}
