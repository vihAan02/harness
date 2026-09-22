/*---------------------------------------------------------------------------------------------
 *  Harness: Room home, the "What is everyone doing?" editor.
 *--------------------------------------------------------------------------------------------*/

import './media/multiplayer.css';
import { $, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Conflict, IRoomSnapshot, IStatusRow } from '../../../../platform/multiplayer/common/multiplayer.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { agentLabel, IMultiplayerService, IMultiplayerState } from '../../../services/multiplayer/common/multiplayer.js';

const roomHomeIcon = registerIcon('harness-room-home', Codicon.organization, localize('roomHomeIcon', "Icon of the Harness room home editor."));

export class RoomHomeInput extends EditorInput {
	static readonly ID = 'workbench.editor.harness.roomHome';
	static readonly RESOURCE = URI.from({ scheme: 'harness-room', path: 'home' });

	private static _instance: RoomHomeInput | undefined;
	static get instance(): RoomHomeInput {
		if (!RoomHomeInput._instance || RoomHomeInput._instance.isDisposed()) {
			RoomHomeInput._instance = new RoomHomeInput();
		}
		return RoomHomeInput._instance;
	}

	override get typeId(): string { return RoomHomeInput.ID; }
	override get editorId(): string | undefined { return RoomHomeInput.ID; }
	override get capabilities(): EditorInputCapabilities { return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton; }
	readonly resource = RoomHomeInput.RESOURCE;
	override getName(): string { return localize('roomHomeName', "Room"); }
	override getIcon(): ThemeIcon { return roomHomeIcon; }
	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof RoomHomeInput;
	}
}

const STATUS_LABEL: Record<string, string> = {
	starting: 'starting', idle: 'idle', thinking: 'thinking', editing: 'editing', running: 'running',
	blocked: 'blocked', waiting_permission: 'waiting for permission', waiting_review: 'waiting for review', offline: 'offline',
};

export function describeConflict(c: Conflict, room: IRoomSnapshot | undefined): string {
	switch (c.kind) {
		case 'collision': return `${c.path}: also changed by ${c.with.map(id => agentLabel(room, id)).join(', ')}${c.overlappingLines ? ' (same lines)' : ''}`;
		case 'in_foreign_claim': return `${c.path} is in ${agentLabel(room, c.owner)}'s area ${c.claimPattern}`;
		case 'claim_overlap': return `claim ${c.pattern} overlaps ${agentLabel(room, c.with)}'s ${c.otherPattern}`;
		case 'review': return `${c.role === 'requester' ? 'waiting on review of' : 'asked to review'} \`${c.command}\``;
		case 'frozen': return `paused by a review: ${c.paths.slice(0, 3).join(', ')}`;
	}
}

export function vendorName(v: string): string {
	return v === 'claude' ? 'Claude' : 'Codex';
}

export class RoomHomeEditor extends EditorPane {
	static readonly ID = RoomHomeInput.ID;

	private root!: HTMLElement;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IMultiplayerService private readonly multiplayer: IMultiplayerService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super(RoomHomeEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.harness-room-home'));
		this._register(autorun(reader => this.render(this.multiplayer.state.read(reader))));
	}

	override layout(dimension: Dimension): void {
		this.root.style.height = `${dimension.height}px`;
		this.root.style.width = `${dimension.width}px`;
	}

	private button(parent: HTMLElement, label: string, command: string, ...args: unknown[]): void {
		const b = append(parent, $('button.harness-button', undefined, label));
		b.onclick = () => this.commands.executeCommand(command, ...args);
	}

	private render(s: IMultiplayerState): void {
		clearNode(this.root);
		const header = append(this.root, $('.harness-header'));
		append(header, $('h1', undefined, localize('whatIsEveryoneDoing', "What is everyone doing?")));
		const meta = append(header, $('.harness-meta'));

		if (s.daemon === 'error') {
			append(meta, $('span.harness-error', undefined, s.error ?? 'mp-daemon is not running'));
			this.button(header, localize('retry', "Retry"), 'harness.refresh');
			return;
		}
		if (!s.repo?.room) {
			append(meta, $('span', undefined, s.repo ? localize('noRoom', "This repo isn't in a room yet.") : localize('noRepo', "Open a folder that is a git repository to use Harness.")));
			if (s.repo) {
				const actions = append(this.root, $('.harness-actions'));
				this.button(actions, localize('createRoomBtn', "Create room"), 'harness.createRoom');
				this.button(actions, localize('joinRoomBtn', "Join with invite link"), 'harness.joinRoom');
			}
			return;
		}

		append(meta, $(`span.harness-dot.${s.connected ? 'on' : 'off'}`));
		append(meta, $('span', undefined, `${s.repo.repoKey} · ${s.connected ? localize('connected', "connected") : localize('offline', "offline, showing last known state")}`));
		const actions = append(this.root, $('.harness-actions'));
		this.button(actions, localize('newAgentBtn', "New agent"), 'harness.newAgent');
		this.button(actions, localize('messageBtn', "Message the room"), 'harness.sendMessage');
		this.button(actions, localize('copyInviteBtn', "Copy invite link"), 'harness.copyInvite');

		this.renderTable(s.rows, s);
		const columns = append(this.root, $('.harness-columns'));
		this.renderMessages(append(columns, $('.harness-panel')), s);
		this.renderActivity(append(columns, $('.harness-panel')), s);
	}

	private renderTable(rows: readonly IStatusRow[], s: IMultiplayerState): void {
		if (!rows.length) {
			append(this.root, $('p.harness-empty', undefined, localize('nobody', "Nobody is working in this room yet. Start an agent with \"New agent\".")));
			return;
		}
		const table = append(this.root, $('table.harness-table'));
		const head = append(append(table, $('thead')), $('tr'));
		for (const h of [localize('colAgent', "Agent"), localize('colTask', "Current task"), localize('colPlan', "Plan"), localize('colClaims', "Claimed directories"), localize('colFiles', "Files being modified"), localize('colConflicts', "Conflicts")]) {
			append(head, $('th', undefined, h));
		}
		const body = append(table, $('tbody'));
		for (const r of rows) {
			const tr = append(body, $('tr'));
			const agentCell = append(tr, $('td.harness-agent'));
			append(agentCell, $(`span.harness-vendor.${r.agent.vendor}`, undefined, vendorName(r.agent.vendor)));
			append(agentCell, $('strong', undefined, r.agent.name));
			append(agentCell, $('div.harness-sub', undefined, `${r.agent.owner} · `));
			append(agentCell.lastChild as HTMLElement, $(`span.harness-status.${r.agent.status}`, undefined, STATUS_LABEL[r.agent.status] ?? r.agent.status));
			if (s.localAgents.some(a => a.id === r.agent.id)) {
				const links = append(agentCell, $('div.harness-links'));
				const open = append(links, $('a', undefined, localize('terminal', "terminal")));
				open.onclick = () => this.commands.executeCommand('harness.openAgentTerminal', r.agent.id);
			}
			append(tr, $('td', undefined, r.currentTask ?? '—'));
			const plan = append(tr, $('td'));
			if (r.plan) {
				append(plan, $('div', undefined, `${r.plan.title} · ${r.plan.done}/${r.plan.total}`));
				if (r.plan.activeStep) {
					append(plan, $('div.harness-sub', undefined, localize('now', "now: {0}", r.plan.activeStep)));
				}
			} else {
				append(plan, $('span.harness-sub', undefined, localize('noPlan', "no plan yet")));
			}
			append(tr, $('td', undefined, r.claimedDirectories.join(', ') || '—'));
			const files = append(tr, $('td'));
			for (const f of r.filesBeingModified.slice(0, 8)) {
				append(files, $('div', undefined, `${f.path} `, $('span.harness-add', undefined, `+${f.additions}`), ' ', $('span.harness-del', undefined, `-${f.deletions}`), f.locked ? $('span.harness-lock', undefined, ' (locked)') : ''));
			}
			if (r.filesBeingModified.length > 8) {
				append(files, $('div.harness-sub', undefined, localize('more', "and {0} more", r.filesBeingModified.length - 8)));
			}
			if (!r.filesBeingModified.length) {
				files.textContent = '—';
			}
			const conflicts = append(tr, $('td'));
			for (const c of r.conflicts) {
				append(conflicts, $('div.harness-conflict', undefined, describeConflict(c, s.room)));
			}
			if (!r.conflicts.length) {
				conflicts.textContent = '—';
			}
		}
	}

	private renderMessages(panel: HTMLElement, s: IMultiplayerState): void {
		append(panel, $('h2', undefined, localize('messages', "Messages")));
		const room = s.room;
		const messages = (room?.messages ?? []).slice(-40);
		if (!messages.length) {
			append(panel, $('p.harness-empty', undefined, localize('noMessages', "No messages yet. Agents talk here when they coordinate.")));
			return;
		}
		const list = append(panel, $('.harness-messages'));
		for (const m of messages) {
			const from = m.from.type === 'agent' ? agentLabel(room, m.from.id) : (room?.members.find(x => x.id === m.from.id)?.name ?? m.from.id);
			const to = m.to.map(t => t.type === 'agent' ? agentLabel(room, t.id) : (room?.members.find(x => x.id === t.id)?.name ?? t.id)).join(', ');
			const row = append(list, $('.harness-message'));
			append(row, $('div.harness-sub', undefined, `${from}${to ? ` → ${to}` : ''} · ${m.kind}${m.urgent ? ' · urgent' : ''} · ${new Date(m.createdAt).toLocaleTimeString()}`));
			append(row, $('div', undefined, m.body));
		}
	}

	private renderActivity(panel: HTMLElement, s: IMultiplayerState): void {
		append(panel, $('h2', undefined, localize('activity', "Live activity")));
		const room = s.room;
		const all = Object.entries(room?.streams ?? {})
			.flatMap(([agentId, events]) => events.slice(-30).map(e => ({ agentId, e })))
			.sort((a, b) => a.e.at - b.e.at)
			.slice(-40);
		if (!all.length) {
			append(panel, $('p.harness-empty', undefined, localize('noActivity', "Agents' replies, commands and edits stream in here.")));
			return;
		}
		const list = append(panel, $('.harness-messages'));
		for (const { agentId, e } of all) {
			const row = append(list, $('.harness-message'));
			const what = e.kind === 'message' ? (e.role === 'user' ? 'prompt' : 'says') : e.tool ?? e.kind;
			append(row, $('div.harness-sub', undefined, `${agentLabel(room, agentId)} · ${what} · ${new Date(e.at).toLocaleTimeString()}`));
			append(row, $('div', undefined, (e.text ?? e.input ?? e.output ?? '').slice(0, 400)));
		}
	}
}
