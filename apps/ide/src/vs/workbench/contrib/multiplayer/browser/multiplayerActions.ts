/*---------------------------------------------------------------------------------------------
 *  Harness: multiplayer commands.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILocalAgent, Vendor } from '../../../../platform/multiplayer/common/multiplayer.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IMultiplayerService } from '../../../services/multiplayer/common/multiplayer.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { RoomHomeInput } from './roomHome.js';

export const HARNESS_CATEGORY = localize2('harness', "Harness");

export const CommandIds = {
	openRoomHome: 'harness.openRoomHome',
	newAgent: 'harness.newAgent',
	openAgentTerminal: 'harness.openAgentTerminal',
	removeAgent: 'harness.removeAgent',
	createRoom: 'harness.createRoom',
	joinRoom: 'harness.joinRoom',
	copyInvite: 'harness.copyInvite',
	sendMessage: 'harness.sendMessage',
	refresh: 'harness.refresh',
} as const;

/** One terminal per agent; reopening focuses it instead of starting a second session. */
const agentTerminals = new Map<string, ITerminalInstance>();

async function openAgentTerminal(accessor: ServicesAccessor, agent: ILocalAgent, task?: string): Promise<void> {
	const multiplayer = accessor.get(IMultiplayerService);
	const terminalService = accessor.get(ITerminalService);
	const terminalGroupService = accessor.get(ITerminalGroupService);

	const existing = agentTerminals.get(agent.id);
	if (existing && !existing.isDisposed) {
		terminalService.setActiveInstance(existing);
		await terminalGroupService.showPanel(true);
		return;
	}
	const spec = await multiplayer.launchSpec(agent, task);
	const instance = await terminalService.createTerminal({
		config: {
			name: `${agent.name} · ${agent.vendor === 'claude' ? 'Claude Code' : 'Codex'}`,
			executable: spec.command,
			args: spec.args,
			cwd: spec.cwd,
			env: spec.env,
			icon: agent.vendor === 'claude' ? Codicon.sparkle : Codicon.hubot,
		},
	});
	agentTerminals.set(agent.id, instance);
	instance.onDisposed(() => { if (agentTerminals.get(agent.id) === instance) { agentTerminals.delete(agent.id); } });
	terminalService.setActiveInstance(instance);
	await terminalGroupService.showPanel(true);
}

registerAction2(class OpenRoomHome extends Action2 {
	constructor() {
		super({ id: CommandIds.openRoomHome, title: localize2('openRoomHome', "What Is Everyone Doing?"), category: HARNESS_CATEGORY, f1: true, icon: Codicon.organization });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(RoomHomeInput.instance, { pinned: true });
	}
});

registerAction2(class NewAgent extends Action2 {
	constructor() {
		super({ id: CommandIds.newAgent, title: localize2('newAgent', "New Agent"), category: HARNESS_CATEGORY, f1: true, icon: Codicon.add });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const multiplayer = accessor.get(IMultiplayerService);
		const notifications = accessor.get(INotificationService);
		if (!multiplayer.state.get().repo?.room) {
			notifications.info(localize('needRoom', "Create or join a room for this repo first (Harness: Create Room / Join Room)."));
			return;
		}
		const vendors: (IQuickPickItem & { vendor: Vendor })[] = [
			{ label: '$(sparkle) Claude Code', description: localize('claudeDesc', "Anthropic's coding agent"), vendor: 'claude' },
			{ label: '$(hubot) Codex', description: localize('codexDesc', "OpenAI's coding agent"), vendor: 'codex' },
		];
		const picked = await quickInput.pick(vendors, { placeHolder: localize('pickVendor', "Which agent?") });
		if (!picked) {
			return;
		}
		const name = await quickInput.input({
			prompt: localize('agentName', "Name the agent after its job (it becomes the branch name)"),
			placeHolder: 'auth-refactor',
			validateInput: async v => v.trim() ? undefined : localize('nameRequired', "A name is required"),
		});
		if (!name) {
			return;
		}
		const task = await quickInput.input({ prompt: localize('agentTask', "What should it do? (optional; becomes its first prompt)"), placeHolder: localize('taskPlaceholder', "Move the auth middleware into src/auth/") });
		try {
			const agent = await multiplayer.createAgent(picked.vendor, name.trim(), task?.trim() || undefined);
			await openAgentTerminal(accessor, agent, task?.trim() || undefined);
		} catch (err) {
			notifications.error(localize('newAgentFailed', "Couldn't start the agent: {0}", String((err as Error).message ?? err)));
		}
	}
});

registerAction2(class OpenAgentTerminal extends Action2 {
	constructor() {
		super({ id: CommandIds.openAgentTerminal, title: localize2('openAgentTerminal', "Open Agent Terminal"), category: HARNESS_CATEGORY, f1: false, icon: Codicon.terminal });
	}
	async run(accessor: ServicesAccessor, agentId: string): Promise<void> {
		const multiplayer = accessor.get(IMultiplayerService);
		const agent = multiplayer.state.get().localAgents.find(a => a.id === agentId);
		if (!agent) {
			return;
		}
		try {
			await openAgentTerminal(accessor, agent);
		} catch (err) {
			accessor.get(INotificationService).error(localize('openTerminalFailed', "Couldn't open the agent's terminal: {0}", String((err as Error).message ?? err)));
		}
	}
});

registerAction2(class RemoveAgent extends Action2 {
	constructor() {
		super({ id: CommandIds.removeAgent, title: localize2('removeAgent', "Remove Agent"), category: HARNESS_CATEGORY, f1: false, icon: Codicon.trash });
	}
	async run(accessor: ServicesAccessor, agentId: string): Promise<void> {
		const multiplayer = accessor.get(IMultiplayerService);
		const dialogs = accessor.get(IDialogService);
		const agent = multiplayer.state.get().localAgents.find(a => a.id === agentId);
		if (!agent) {
			return;
		}
		const { confirmed } = await dialogs.confirm({
			message: localize('removeConfirm', "Remove {0}?", agent.name),
			detail: localize('removeDetail', "Its worktree is deleted and it leaves the room. The branch {0} is kept.", agent.branch),
			primaryButton: localize('remove', "Remove"),
		});
		if (!confirmed) {
			return;
		}
		agentTerminals.get(agentId)?.dispose();
		try {
			await multiplayer.removeAgent(agentId);
		} catch (err) {
			const message = String((err as Error).message ?? err);
			if (!/uncommitted|dirty|modified/i.test(message)) {
				accessor.get(INotificationService).error(message);
				return;
			}
			const force = await dialogs.confirm({
				message: localize('dirtyWorktree', "{0} has uncommitted changes", agent.name),
				detail: localize('dirtyDetail', "Removing it now throws those changes away."),
				primaryButton: localize('discardRemove', "Discard and Remove"),
			});
			if (force.confirmed) {
				await multiplayer.removeAgent(agentId, true);
			}
		}
	}
});

registerAction2(class CreateRoom extends Action2 {
	constructor() {
		super({ id: CommandIds.createRoom, title: localize2('createRoom', "Create Room for This Repo"), category: HARNESS_CATEGORY, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const configuration = accessor.get(IConfigurationService);
		const multiplayer = accessor.get(IMultiplayerService);
		const relayUrl = await quickInput.input({
			prompt: localize('relayUrl', "Relay URL (your deployed mp-relay, e.g. https://mp-relay.<you>.workers.dev)"),
			value: configuration.getValue<string>('harness.relayUrl') || '',
			validateInput: async v => /^https?:\/\/\S+$/.test(v.trim()) ? undefined : localize('badUrl', "Enter an http(s) URL"),
		});
		if (!relayUrl) {
			return;
		}
		try {
			await multiplayer.createRoom(relayUrl.trim());
			await configuration.updateValue('harness.relayUrl', relayUrl.trim());
			const invite = multiplayer.state.get().repo?.room?.invite;
			if (invite) {
				await accessor.get(IClipboardService).writeText(invite);
				accessor.get(INotificationService).info(localize('roomCreated', "Room created. The invite link is on your clipboard: share it with your teammates."));
			}
		} catch (err) {
			accessor.get(INotificationService).error(localize('createRoomFailed', "Couldn't create the room: {0}", String((err as Error).message ?? err)));
		}
	}
});

registerAction2(class JoinRoom extends Action2 {
	constructor() {
		super({ id: CommandIds.joinRoom, title: localize2('joinRoom', "Join Room with Invite Link"), category: HARNESS_CATEGORY, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const invite = await accessor.get(IQuickInputService).input({
			prompt: localize('invite', "Paste the invite link (https://…/join/<room>#<secret>)"),
			password: true,
		});
		if (!invite) {
			return;
		}
		try {
			await accessor.get(IMultiplayerService).joinRoom(invite.trim());
		} catch (err) {
			accessor.get(INotificationService).error(localize('joinFailed', "Couldn't join the room: {0}", String((err as Error).message ?? err)));
		}
	}
});

registerAction2(class CopyInvite extends Action2 {
	constructor() {
		super({ id: CommandIds.copyInvite, title: localize2('copyInvite', "Copy Room Invite Link"), category: HARNESS_CATEGORY, f1: true, icon: Codicon.link });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const invite = accessor.get(IMultiplayerService).state.get().repo?.room?.invite;
		if (invite) {
			await accessor.get(IClipboardService).writeText(invite);
			accessor.get(INotificationService).info(localize('inviteCopied', "Invite link copied. It contains the room secret: share it only with teammates."));
		}
	}
});

registerAction2(class SendMessage extends Action2 {
	constructor() {
		super({ id: CommandIds.sendMessage, title: localize2('sendMessage', "Message the Room"), category: HARNESS_CATEGORY, f1: true, icon: Codicon.commentDiscussion });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const body = await accessor.get(IQuickInputService).input({ prompt: localize('messagePrompt', "Message everyone in the room (people and agents)") });
		if (body?.trim()) {
			await accessor.get(IMultiplayerService).sendMessage(body.trim());
		}
	}
});

registerAction2(class Refresh extends Action2 {
	constructor() {
		super({ id: CommandIds.refresh, title: localize2('refresh', "Reconnect to Room"), category: HARNESS_CATEGORY, f1: true, icon: Codicon.refresh });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IMultiplayerService).refresh();
	}
});
