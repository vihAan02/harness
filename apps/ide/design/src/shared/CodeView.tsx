import { Fragment, type ReactNode } from 'react'
import { Braces, Database, FileCode2, FileText, FlaskConical, Folder, FolderOpen } from 'lucide-react'
import { agentById, type OpenFile } from '@/data/room'
import { highlight } from '@/lib/highlight'
import { useTyping } from '@/lib/motion'
import { cn } from '@/lib/utils'

export type Variant = 'graphite' | 'prism'

/**
 * The editor surface with multiplayer drawn in: the live region another agent is editing
 * (rail + tint), its typing cursor with a name flag, and other agents' pending hunks inline.
 */
export function CodeView({ file, variant, renderGhost, renderFlag, gutter = 48 }: {
  file: OpenFile
  variant: Variant
  renderGhost?: (g: NonNullable<OpenFile['ghost']>) => ReactNode
  renderFlag: (agentId: string, color: string) => ReactNode
  gutter?: number
}) {
  const lines = file.code.replace(/\n$/, '').split('\n')
  const live = file.live
  const color = live ? agentById(live.agent).color[variant] : ''
  const typed = useTyping(live?.typing)

  return (
    <div className="min-w-max py-3 font-mono text-[13px] leading-5">
      {lines.map((text, i) => {
        const n = i + 1
        const inLive = !!live && n >= live.from && n <= live.to
        const isCursor = !!live && n === live.cursorLine
        return (
          <Fragment key={n}>
            <div className="relative flex pr-8" style={inLive ? { background: `${color}${variant === 'prism' ? '12' : '0d'}` } : undefined}>
              {inLive && <span className="absolute top-0 bottom-0 w-[2px]" style={{ left: gutter + 4, background: color, boxShadow: variant === 'prism' ? `0 0 10px ${color}` : undefined }} />}
              <span className={cn('shrink-0 select-none pr-3 text-right tabular-nums', isCursor ? 'text-muted-foreground' : 'text-faint')} style={{ width: gutter }}>{n}</span>
              <span className="whitespace-pre pl-5">
                {isCursor ? (
                  <>
                    {highlight(typed)}
                    <span className="relative inline-block h-[18px] w-[2px] translate-y-[3px]" style={{ background: color }}>
                      {renderFlag(live!.agent, color)}
                    </span>
                  </>
                ) : highlight(text)}
              </span>
            </div>
            {file.ghost && file.ghost.afterLine === n && renderGhost?.(file.ghost)}
          </Fragment>
        )
      })}
    </div>
  )
}

export function FileIcon({ name, dir, open, className }: { name: string; dir?: boolean; open?: boolean; className?: string }) {
  const c = cn('size-3.5 shrink-0', className)
  if (dir) return open ? <FolderOpen className={c} /> : <Folder className={c} />
  if (name.includes('.test.')) return <FlaskConical className={c} style={{ color: '#d4a656' }} />
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return <FileCode2 className={c} style={{ color: '#5e9ce0' }} />
  if (name.endsWith('.json')) return <Braces className={c} style={{ color: '#d6b94f' }} />
  if (name.endsWith('.prisma') || name.endsWith('.sql')) return <Database className={c} style={{ color: '#7fb8b0' }} />
  return <FileText className={c} style={{ color: '#8f8e88' }} />
}
