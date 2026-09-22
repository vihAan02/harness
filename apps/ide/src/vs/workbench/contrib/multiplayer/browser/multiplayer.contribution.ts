/*---------------------------------------------------------------------------------------------
 *  Harness: multiplayer workbench contribution. Registers the Room view container, the Room home
 *  editor, Explorer decorations, the status bar entry and startup behaviour.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStatusRow } from '../../../../platform/multiplayer/common/multiplayer.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IDecorationData, IDecorationsProvider, IDecorationsService } from '../../../services/decorations/common/decorations.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { agentLabel, IMultiplayerService, IMultiplayerState } from '../../../services/multiplayer/common/multiplayer.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { CommandIds } from './multiplayerActions.js';
import { RoomHomeEditor, RoomHomeInput } from './roomHome.js';
import { RoomViewPane } from './roomView.js';

// ---------------------------------------------------------------- settings

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'harness',
	order: 0,
	title: localize('harnessConfigTitle', "Harness"),
	type: 'object',
	properties: {
		'harness.relayUrl': {
			type: 'string',
			default: '',
			description: localize('harness.relayUrl', "The multiplayer relay new rooms are created on (your deployed mp-relay Worker)."),
		},
		'harness.openRoomOnStartup': {
			type: 'boolean',
			default: true,
			description: localize('harness.openRoomOnStartup', "Open \"What is everyone doing?\" when a repo that's in a room is opened."),
		},
	},
});

// Harness defaults: the room is the home screen, so no Welcome page and no Copilot sign-in overlay.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'workbench.startupEditor': 'none',
		'workbench.welcomePage.experimentalOnboarding': false,
		'workbench.secondarySideBar.defaultVisibility': 'hidden',
	},
}]);

// ---------------------------------------------------------------- Room view container (first in the activity bar)

const roomViewIcon = registerIcon('harness-room-view', Codicon.organization, localize('roomViewIcon', "Icon of the Harness Room view."));
const CONTAINER_ID = 'workbench.view.harness';

const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: CONTAINER_ID,
	title: localize2('harnessContainer', "Room"),
	icon: roomViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: CONTAINER_ID,
	order: -10,
}, ViewContainerLocation.Sidebar, { isDefault: false });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: RoomViewPane.ID,
	name: RoomViewPane.TITLE,
	containerIcon: roomViewIcon,
	ctorDescriptor: new SyncDescriptor(RoomViewPane),
	canToggleVisibility: false,
	canMoveView: true,
}], container);

// ---------------------------------------------------------------- Room home editor

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(RoomHomeEditor, RoomHomeEditor.ID, localize('roomHome', "Room")),
	[new SyncDescriptor(RoomHomeInput)],
);

class RoomHomeSerializer implements IEditorSerializer {
	canSerialize(): boolean { return true; }
	serialize(): string { return ''; }
	deserialize(_instantiationService: IInstantiationService): EditorInput { return RoomHomeInput.instance; }
}
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(RoomHomeInput.ID, RoomHomeSerializer);

// ---------------------------------------------------------------- Explorer decorations

/** Marks files other agents have locked or are changing, so you see them before you touch them. */
class RoomDecorations extends Disposable implements IDecorationsProvider {
	readonly label = localize('roomDecorations', "Room");
	private readonly _onDidChange = this._register(new Emitter<readonly URI[]>());
	readonly onDidChange = this._onDidChange.event;
	private marks = new Map<string, IDecorationData>();

	constructor(private readonly multiplayer: IMultiplayerService) {
		super();
		this._register(autorun(reader => this.update(this.multiplayer.state.read(reader))));
	}

	private update(s: IMultiplayerState): void {
		const next = new Map<string, IDecorationData>();
		const root = s.repo?.root;
		const room = s.room;
		if (root && room) {
			const others = (agentId: string) => !s.localAgents.some(a => a.id === agentId);
			for (const diff of room.diffs) {
				if (!others(diff.agentId)) {
					continue;
				}
				for (const f of diff.files) {
					next.set(URI.file(`${root}/${f.path}`).toString(), {
						letter: Codicon.account,
						color: 'charts.purple',
						tooltip: localize('beingChanged', "Being changed by {0}", agentLabel(room, diff.agentId)),
						bubble: true,
						weight: 10,
					});
				}
			}
			for (const lock of room.locks) {
				if (!others(lock.agentId)) {
					continue;
				}
				next.set(URI.file(`${root}/${lock.path}`).toString(), {
					letter: Codicon.lock,
					color: 'list.warningForeground',
					tooltip: localize('lockedBy', "Locked by {0}: their changes haven't landed yet", agentLabel(room, lock.agentId)),
					bubble: true,
					weight: 20,
				});
			}
		}
		const changed = new Set([...this.marks.keys(), ...next.keys()]);
		this.marks = next;
		if (changed.size) {
			this._onDidChange.fire([...changed].map(u => URI.parse(u)));
		}
	}

	provideDecorations(uri: URI, _token: CancellationToken): IDecorationData | undefined {
		const root = this.multiplayer.state.get().repo?.root;
		if (!root || !isEqualOrParent(uri, URI.file(root))) {
			return undefined;
		}
		return this.marks.get(uri.toString());
	}
}

// ---------------------------------------------------------------- status bar

function conflictCount(rows: readonly IStatusRow[]): number {
	return rows.reduce((n, r) => n + r.conflicts.length, 0);
}

class RoomContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.harness.room';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private openedRoomHome = false;

	constructor(
		@IMultiplayerService multiplayer: IMultiplayerService,
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@IDecorationsService decorations: IDecorationsService,
		@IEditorService private readonly editors: IEditorService,
		@IViewsService private readonly views: IViewsService,
		@IStorageService private readonly storage: IStorageService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		const provider = this._register(new RoomDecorations(multiplayer));
		this._register(decorations.registerDecorationsProvider(provider));
		this._register(autorun(reader => this.update(multiplayer.state.read(reader))));
	}

	private update(s: IMultiplayerState): void {
		let text: string;
		let tooltip: string;
		if (s.daemon === 'error') {
			text = '$(error) Room';
			tooltip = s.error ?? localize('daemonError', "mp-daemon is not running");
		} else if (!s.repo?.room) {
			text = '$(organization) No room';
			tooltip = localize('noRoomTooltip', "This repo isn't in a multiplayer room. Click to set one up.");
		} else {
			const agents = s.room?.agents.length ?? 0;
			const conflicts = conflictCount(s.rows);
			text = `$(organization) ${agents} ${agents === 1 ? 'agent' : 'agents'}${conflicts ? ` $(warning) ${conflicts}` : ''}${s.connected ? '' : ' $(debug-disconnect)'}`;
			tooltip = localize('roomTooltip', "What is everyone doing? {0} agents, {1} conflicts{2}", agents, conflicts, s.connected ? '' : localize('offlineSuffix', " (offline)"));
		}
		const entry = { name: localize('roomEntry', "Room"), text, ariaLabel: tooltip, tooltip, command: CommandIds.openRoomHome };
		if (this.entry.value) {
			this.entry.value.update(entry);
		} else {
			this.entry.value = this.statusbar.addEntry(entry, 'status.harness.room', StatusbarAlignment.LEFT, 10);
		}

		// Room home is the home screen for a repo that's in a room: open it once per session, and show
		// the Room sidebar the first time a workspace joins a room (after that, the user's choice sticks).
		if (!this.openedRoomHome && s.repo?.room && s.room) {
			this.openedRoomHome = true;
			if (!this.editors.activeEditor && this.configuration.getValue<boolean>('harness.openRoomOnStartup') !== false) {
				void this.editors.openEditor(RoomHomeInput.instance, { pinned: true, preserveFocus: true });
			}
			const key = `harness.roomViewShown.${s.repo.room.roomId}`;
			if (!this.storage.getBoolean(key, StorageScope.WORKSPACE)) {
				this.storage.store(key, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
				void this.views.openViewContainer(CONTAINER_ID);
			}
		}
	}
}

registerWorkbenchContribution2(RoomContribution.ID, RoomContribution, WorkbenchPhase.AfterRestored);
