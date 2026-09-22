/*---------------------------------------------------------------------------------------------
 *  Harness: the Room sidebar view (people → their agents, live).
 *--------------------------------------------------------------------------------------------*/

import './media/multiplayer.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IMultiplayerService, IMultiplayerState } from '../../../services/multiplayer/common/multiplayer.js';
import { vendorName } from './roomHome.js';

export class RoomViewPane extends ViewPane {
	static readonly ID = 'workbench.view.harness.room';
	static readonly TITLE = localize2('roomView', "Room");

	private roomBody!: HTMLElement;

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IMultiplayerService private readonly multiplayer: IMultiplayerService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.roomBody = append(container, $('.harness-room-view'));
		this._register(autorun(reader => this.renderRoom(this.multiplayer.state.read(reader))));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.roomBody.style.height = `${height}px`;
	}

	private link(parent: HTMLElement, label: string, command: string, ...args: unknown[]): void {
		const a = append(parent, $('a.harness-link', undefined, label));
		a.onclick = () => this.commands.executeCommand(command, ...args);
	}

	private renderRoom(s: IMultiplayerState): void {
		clearNode(this.roomBody);
		if (s.daemon === 'starting') {
			append(this.roomBody, $('p.harness-empty', undefined, localize('starting', "Connecting to the multiplayer daemon…")));
			return;
		}
		if (s.daemon === 'error') {
			append(this.roomBody, $('p.harness-error', undefined, s.error ?? localize('daemonDown', "mp-daemon is not running.")));
			this.link(append(this.roomBody, $('p')), localize('retry', "Retry"), 'harness.refresh');
			return;
		}
		if (!s.repo) {
			append(this.roomBody, $('p.harness-empty', undefined, localize('noRepoView', "Open a folder that is a git repository to share it in a room.")));
			return;
		}
		if (!s.repo.room) {
			append(this.roomBody, $('p', undefined, localize('noRoomView', "{0} isn't in a room yet.", s.repo.repoKey)));
			const p = append(this.roomBody, $('p'));
			this.link(p, localize('createRoomLink', "Create a room"), 'harness.createRoom');
			append(p, document.createTextNode(' · '));
			this.link(p, localize('joinRoomLink', "Join with an invite link"), 'harness.joinRoom');
			return;
		}

		const header = append(this.roomBody, $('.harness-view-header'));
		append(header, $(`span.harness-dot.${s.connected ? 'on' : 'off'}`));
		append(header, $('span', undefined, s.connected ? localize('live', "Live") : localize('offlineView', "Offline")));
		const actions = append(this.roomBody, $('p'));
		this.link(actions, localize('whatLink', "What is everyone doing?"), 'harness.openRoomHome');
		append(actions, document.createTextNode(' · '));
		this.link(actions, localize('newAgentLink', "New agent"), 'harness.newAgent');

		const room = s.room;
		if (!room) {
			return;
		}
		const members = [...room.members].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
		for (const member of members) {
			const agents = room.agents.filter(a => a.memberId === member.id);
			const group = append(this.roomBody, $('.harness-person'));
			const title = append(group, $('.harness-person-name'));
			append(title, $(`span.harness-dot.${member.online ? 'on' : 'off'}`));
			append(title, $('strong', undefined, member.id === s.identity?.memberId ? localize('you', "{0} (you)", member.name) : member.name));
			if (!agents.length) {
				append(group, $('div.harness-sub.harness-indent', undefined, localize('noAgents', "no agents")));
			}
			for (const agent of agents) {
				const row = append(group, $('.harness-agent-row'));
				const line = append(row, $('div'));
				append(line, $(`span.harness-vendor.${agent.vendor}`, undefined, vendorName(agent.vendor)));
				append(line, $('span', undefined, agent.name));
				append(line, $(`span.harness-status.${agent.status}`, undefined, agent.status.replace('_', ' ')));
				const plan = room.plans.find(p => p.agentId === agent.id);
				const active = plan?.steps.find(st => st.status === 'active');
				const detail = active ? active.text : (agent.task ?? plan?.title);
				if (detail) {
					append(row, $('div.harness-sub', undefined, detail));
				}
				const files = room.diffs.find(d => d.agentId === agent.id)?.files.length ?? 0;
				const locks = room.locks.filter(l => l.agentId === agent.id).length;
				if (files || locks) {
					append(row, $('div.harness-sub', undefined, localize('filesLocks', "{0} files changed · {1} locked", files, locks)));
				}
				if (this.multiplayer.isLocal(agent.id)) {
					const links = append(row, $('div.harness-links'));
					this.link(links, localize('terminalLink', "terminal"), 'harness.openAgentTerminal', agent.id);
					append(links, document.createTextNode(' · '));
					this.link(links, localize('removeLink', "remove"), 'harness.removeAgent', agent.id);
				}
			}
		}
	}
}
