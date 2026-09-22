import { useState } from 'react'
import { Check, FolderGit2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ShaderOrb } from '@/gpu/components'
import { cn } from '@/lib/utils'
import type { Variant } from './CodeView'

const VENDORS = [
  { id: 'claude', name: 'Claude Code', detail: 'found on PATH · signed in', graphite: '#f0aa88', prism: '#ff6b4a' },
  { id: 'codex', name: 'Codex', detail: 'found on PATH · signed in', graphite: '#90b9f2', prism: '#4fd6ff' },
] as const

export function NewAgentDialog({ open, onOpenChange, variant }: { open: boolean; onOpenChange: (o: boolean) => void; variant: Variant }) {
  const [vendor, setVendor] = useState<'claude' | 'codex'>('claude')
  const prism = variant === 'prism'
  const label = prism ? 'micro text-muted-foreground' : 'text-xs font-medium text-muted-foreground'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-[460px]', prism && 'rounded-lg border-white/10 bg-black')}>
        <DialogHeader>
          <DialogTitle className={cn(prism && 'font-serif text-3xl font-normal tracking-tight')}>New agent</DialogTitle>
          <DialogDescription>
            Runs your own install in a fresh worktree. It publishes a plan and claims its area before editing.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-2">
            {VENDORS.map(v => (
              <button key={v.id} onClick={() => setVendor(v.id)}
                className={cn('flex items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                  vendor === v.id ? 'border-foreground/40 bg-accent' : 'border-border hover:bg-accent/60')}>
                <ShaderOrb color={v[variant]} status={vendor === v.id ? 'editing' : 'idle'} size={22} seed={v.id === 'claude' ? 1 : 2} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{v.name}</span>
                  <span className={cn('block truncate text-muted-foreground', prism ? 'font-mono text-[10.5px]' : 'text-xs')}>{v.detail}</span>
                </span>
                {vendor === v.id && <Check className="size-4" />}
              </button>
            ))}
          </div>
          <label className="grid gap-1.5"><span className={label}>Name</span><Input defaultValue="docs-sweep" /></label>
          <label className="grid gap-1.5"><span className={label}>Task</span>
            <Textarea rows={3} defaultValue="Update README and apps/ide/README for the new room API." /></label>
          <div className={cn('flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-muted-foreground', prism ? 'font-mono text-[11px]' : 'text-xs')}>
            <FolderGit2 className="size-3.5" /> worktree <span className="text-foreground">~/.multiplayer/worktrees/multiplayer-ai/docs-sweep</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => onOpenChange(false)}>Start agent</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
