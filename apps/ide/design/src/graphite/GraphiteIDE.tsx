import { useState } from 'react'
import { NewAgentDialog } from '@/shared/NewAgentDialog'
import { AgentPanel } from './AgentPanel'
import { Editor, ROOM_TAB } from './Editor'
import { CommandPalette, StatusBar, TitleBar } from './parts'
import { Sidebar } from './Sidebar'

/**
 * Direction A · Graphite. Keeps VS Code's editor-first shape but rebuilt the way Cursor did:
 * floating panels on a dark frame, a centered command bar, horizontal view tabs, and a right-hand
 * agent panel. Multiplayer shows up in every surface: title-bar presence, tree, tabs, the editor.
 *
 * `room` (option C) adds the Room window as the first editor tab: it opens there, and the agent
 * panel stays out of the way until you pick an agent.
 */
export function GraphiteIDE({ room = false }: { room?: boolean }) {
  const [file, setFile] = useState(room ? ROOM_TAB : 'src/auth/middleware.ts')
  const [focus, setFocus] = useState('auth-refactor')
  const [palette, setPalette] = useState(false)
  const [newAgent, setNewAgent] = useState(false)
  const [panel, setPanel] = useState(!room)

  const openAgent = (id: string) => { setFocus(id); setPanel(true) }
  const openFile = (p: string) => { setFile(p); if (room && p !== ROOM_TAB) setPanel(true) }

  return (
    <div className="flex h-full flex-col bg-frame text-foreground">
      <TitleBar onPalette={() => setPalette(true)} onInvite={() => {}}
        panelOpen={panel} onTogglePanel={() => setPanel(o => !o)}
        onRoom={room ? () => setFile(ROOM_TAB) : undefined} />
      <div className="flex min-h-0 flex-1 gap-1.5 px-1.5">
        <div className="w-[264px] shrink-0 overflow-hidden rounded-xl border border-hairline bg-panel">
          <Sidebar file={file} onFile={openFile} onAgent={openAgent} onNewAgent={() => setNewAgent(true)}
            onRoom={room ? () => setFile(ROOM_TAB) : undefined} />
        </div>
        <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-hairline">
          <Editor file={file} onFile={openFile} onAgent={setFocus} roomTab={room} focus={focus}
            onOpenAgent={openAgent} onNewAgent={() => setNewAgent(true)} />
        </div>
        {panel && (
          <div className="w-[392px] shrink-0 overflow-hidden rounded-xl border border-hairline bg-panel max-[1180px]:hidden">
            <AgentPanel focus={focus} onFocus={setFocus} onNewAgent={() => setNewAgent(true)} onClose={room ? () => setPanel(false) : undefined} />
          </div>
        )}
      </div>
      <StatusBar />
      <CommandPalette open={palette} onOpenChange={setPalette} onAgent={openAgent} onFile={openFile}
        onNewAgent={() => setNewAgent(true)} onRoom={room ? () => setFile(ROOM_TAB) : undefined} />
      <NewAgentDialog open={newAgent} onOpenChange={setNewAgent} variant="graphite" />
    </div>
  )
}
