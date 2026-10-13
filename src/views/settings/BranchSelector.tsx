import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxContent,
  ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxValue, useComboboxAnchor,
} from '@/components/ui/combobox'
import { useOffScreen, useOnScreen } from '@/components/on-screen-context'
import type { BranchesRead, Desktop } from '@/platform/desktop'
import { branchName } from '@/settings/observing'
import { SettingsProblem } from './SettingsGroup'

/** Branch discovery belongs to this view; only the saved selection is configuration. */
export default function BranchSelector({ desktop, path, value, onChange }: {
  desktop: Desktop
  path: string
  value: string[] | undefined
  onChange: (branches: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  useOffScreen(() => setOpen(false))
  const [read, setRead] = useState<BranchesRead | null>(null)
  const onScreen = useOnScreen()
  const reads = useRef(0)
  const id = useId()
  const anchor = useComboboxAnchor()

  useEffect(() => {
    if (!onScreen) return
    let listening = true
    const stops: Array<() => void> = []
    async function refresh() {
      const mine = ++reads.current
      try {
        const next = await desktop.repositoryBranches(path)
        if (listening && mine === reads.current) setRead(next)
      } catch (error) {
        console.error('could not read repository branches', error)
        if (listening && mine === reads.current) setRead({ state: 'unreadable', reason: 'git-unavailable' })
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 60_000)
    for (const subscribe of [desktop.onRepositoryStateChanged, desktop.onSystemWoke]) {
      void subscribe(() => void refresh()).then((stop) => {
        if (listening) stops.push(stop)
        else stop()
      })
    }
    return () => {
      listening = false
      clearInterval(timer)
      for (const stop of stops) stop()
    }
  }, [desktop, path, onScreen])

  const available = read?.state === 'read' ? read.branches : []
  const selected = value ?? (read?.state === 'read' && read.defaultBranch ? [read.defaultBranch] : [])
  // Missing selections stay selected and removable; absence never means all.
  const offered = [...new Set([...available, ...selected])]
  const missing = value !== undefined && read?.state === 'read'
    ? selected.filter((reference) => !available.includes(reference)) : []

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="type-meta text-muted-foreground">Branches</label>
        <Button variant="ghost" size="sm" disabled={value?.length === 0} onClick={() => onChange([])}>
          All branches
        </Button>
      </div>
      <Combobox
        multiple
        open={open}
        onOpenChange={setOpen}
        items={offered}
        value={selected}
        onValueChange={(branches, details) => {
          // Base UI clears a closed combobox on Escape. Here clearing expands
          // observation to every branch, so only an explicit removal may do it.
          if (details.reason === 'escape-key') {
            details.cancel()
            if (!open) details.allowPropagation()
            return
          }
          onChange(branches)
        }}
        itemToStringLabel={branchName}
        disabled={read?.state !== 'read'}
      >
        <ComboboxChips ref={anchor}>
          <ComboboxValue>
            {(values: string[]) => values.map((reference) => (
              <ComboboxChip key={reference} className="max-w-full" aria-label={branchName(reference)} removeLabel={`Remove ${branchName(reference)}`}>
                <span className="truncate">{branchName(reference)}</span>
              </ComboboxChip>
            ))}
          </ComboboxValue>
          <ComboboxChipsInput id={id} aria-describedby={`${id}-help`} placeholder={selected.length === 0 ? 'All branches' : 'Add branch…'} />
        </ComboboxChips>
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>No branches found.</ComboboxEmpty>
          <ComboboxList>
            {(reference: string) => (
              <ComboboxItem key={reference} value={reference}>
                {branchName(reference)}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <p id={`${id}-help`} className="type-micro text-muted-foreground">
        No branches selected means all branches.
        {value === undefined && ' Using the default branch until you change this selection.'}
      </p>
      {missing.length > 0 && (
        <SettingsProblem>
          Selected branches unavailable: {missing.map(branchName).join(', ')}. Their commits are not being added.
        </SettingsProblem>
      )}
      {read?.state === 'unreadable' && (
        <SettingsProblem>Branches could not be read. Your selection is kept.</SettingsProblem>
      )}
    </div>
  )
}
