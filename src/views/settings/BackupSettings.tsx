import { useEffect, useLayoutEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useOnScreen } from '@/components/on-screen-context'
import { useOnScreenToast } from '@/components/on-screen-toast'
import type { Desktop } from '@/platform/desktop'
import { SettingsAside, SettingsGroup, SettingsRow } from './SettingsGroup'

/**
 * When a local instant is said, it is said the way the journal says days and
 * times everywhere else — as the user's own clock reads it, not as a machine
 * formats it. Epoch seconds are what travels; this is the only place that
 * turns them into words.
 */
function saidWhen(epochSeconds: number | null): string {
  if (epochSeconds === null) {
    return 'No automatic backup yet — one is taken at launch.'
  }

  const taken = new Date(epochSeconds * 1000)
  const when = taken.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  return `Last automatic backup: ${when}.`
}

/**
 * The Backup group: the automatic snapshots the app takes at launch, beside
 * the journal, and the manual one that goes wherever the user says — the only
 * one that leaves this disk — plus the restore that returns the journal to
 * an earlier whole. The copy keeps to what it does: it names what is not
 * included, and it never calls the automatic folder safe from a failed
 * disk, because it is not — see
 * docs/adr/0032-a-backup-is-a-sqlite-snapshot-taken-with-vacuum-into.md.
 */
export default function BackupSettings({ desktop }: { desktop: Desktop }) {
  const [status, setStatus] = useState<string | null>(null)
  const [backingUp, setBackingUp] = useState(false)
  const [confirmingRestore, setConfirmingRestore] = useState(false)
  const [restoring, setRestoring] = useState(false)
  // Staged and waiting for the restart that applies it. The stage is still
  // this value and the line still under the button, so coming back to
  // Settings runs the restart then rather than abandoning it.
  const [restartPending, setRestartPending] = useState(false)
  // Every message this group says, and only while it is the section showing:
  // the picker can sit open for a minute, and the line under the buttons
  // keeps the answer for a reader who has gone elsewhere.
  const says = useOnScreenToast()
  // Settings keeps every section mounted and shows one — so being rendered
  // is not being read. See docs/adr/0024-a-view-is-told-whether-it-is-on-screen.md.
  const onScreen = useOnScreen()

  useEffect(() => {
    let stale = false
    void desktop.automaticBackups().then(
      (automatic) => {
        if (!stale) {
          setStatus(saidWhen(automatic.newestTakenAt))
        }
      },
      (error: unknown) => {
        console.error('could not read the automatic backups', error)
        if (!stale) {
          setStatus('Could not read the automatic backups.')
        }
      },
    )
    return () => {
      stale = true
    }
  }, [desktop])

  /**
   * The restart, once the restored line has been on screen and not before.
   * It runs here rather than beside the stage it follows because it takes
   * this webview with it: a state set and a process ended in the same breath
   * is a line nobody ever reads, which is exactly what this group promised
   * to say — as with the updater, the message is on screen before the
   * webview goes away.
   *
   * Two frames, for the reason the updater names: the first callback runs
   * before the next paint, and the second only after that paint has
   * happened. Both are cancelled if this is torn down or goes off screen.
   */
  useLayoutEffect(() => {
    if (!onScreen || !restartPending) return

    let painted = 0
    const committed = requestAnimationFrame(() => {
      painted = requestAnimationFrame(() => {
        desktop.restart().catch((error: unknown) => {
          console.error('could not restart into the restored journal', error)
          // The stage still took, so this is not a way back to the press
          // that made it. What is left is a quit, and the app cannot make it
          // on the user's behalf.
          const answer =
            'Journal restored. Quit and open it again to use it.'
          setRestartPending(false)
          setStatus(answer)
          says.failure(answer)
        })
      })
    })

    return () => {
      cancelAnimationFrame(committed)
      cancelAnimationFrame(painted)
    }
  }, [desktop, onScreen, says, restartPending])

  /**
   * One gesture, two operations: the picker first, then the write. A
   * cancelled dialog resolves to null and means the backup never happens —
   * quietly, because a cancelled save is not an error. The button reads
   * "Backing up…" only for the write, and only from the moment the write
   * begins: set after the picker resolves, never before it, because a
   * dialog the user browses for minutes is not a backup in progress — and
   * a disabled button behind the dialog would read as one.
   */
  function backUpNow() {
    void (async () => {
      try {
        const destination = await desktop.chooseBackupLocation()
        if (destination === null) {
          says.success('Backup cancelled.')
          return
        }

        // The write is the moment the label covers.
        setBackingUp(true)
        const backup = await desktop.backupJournal(destination)
        const said = `Backed up to ${backup.path}.`
        says.success(said)
        setStatus(said)
      } catch (error) {
        console.error('could not back up the journal', error)
        const said = 'Could not back up the journal.'
        says.failure(said)
        setStatus(said)
      } finally {
        setBackingUp(false)
      }
    })()
  }

  /**
   * Revealing can fail like any other operation here — the folder may be
   * gone, or the Finder refuse — so its failure is said the way the write's
   * is: a toast where the user is looking, the line for after.
   */
  function revealBackups() {
    void desktop.revealBackups().catch((error: unknown) => {
      console.error('could not reveal the backups', error)
      const said = 'Could not reveal the backups.'
      says.failure(said)
      setStatus(said)
    })
  }

  /**
   * One gesture, two operations like the backup: the open dialog first, then
   * the validate-and-stage. A cancelled dialog stages nothing and is not an
   * error. The button reads "Restoring…" only for the stage, set after the
   * picker resolves, never before it.
   */
  function restoreFromBackup() {
    setConfirmingRestore(false)
    void (async () => {
      try {
        const candidate = await desktop.chooseRestoreCandidate()
        if (candidate === null) {
          says.success('Restore cancelled.')
          return
        }

        setRestoring(true)
        await desktop.stageRestore(candidate)
        const said = 'Journal restored. Restarting…'
        says.success(said)
        setStatus(said)
        setRestartPending(true)
      } catch (error) {
        console.error('could not restore the journal', error)
        const said = restoreRefusal(error)
        says.failure(said)
        setStatus(said)
      } finally {
        setRestoring(false)
      }
    })()
  }

  return (
    <SettingsGroup>
      <SettingsRow
        label="Backup"
        explanation="A snapshot of the journal database — every Note and Task as stored."
      >
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={backUpNow}
            disabled={backingUp}
          >
            {backingUp ? 'Backing up…' : 'Back up now'}
          </Button>
          <Button variant="outline" size="sm" onClick={revealBackups}>
            Reveal backups
          </Button>
        </div>
      </SettingsRow>

      <SettingsAside>
        Taken automatically at launch into a backups folder beside the
        journal, so it shares the disk's fate; Back up now goes wherever you
        say, which is the copy that leaves this machine. Your API Key, Hotkeys
        and settings are never included.
      </SettingsAside>

      <SettingsRow
        label="Restore"
        explanation="Return the journal to an earlier backup."
      >
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmingRestore(true)}
            disabled={restoring || restartPending}
          >
            {restoring
              ? 'Restoring…'
              : restartPending
                ? 'Restarting…'
                : 'Restore from backup…'}
          </Button>
        </div>
      </SettingsRow>

      <SettingsAside>
        The current journal is kept as a rollback file beside it and never
        deleted, and the app restarts into the restored one. Your API Key,
        Hotkeys and settings are not restored.
      </SettingsAside>

      <AlertDialog
        open={confirmingRestore}
        onOpenChange={(open) => {
          if (!open) setConfirmingRestore(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore the journal from a backup?</AlertDialogTitle>
            <AlertDialogDescription>
              The current journal will be replaced by the backup you choose.
              The previous journal is kept as a rollback file beside it and
              never deleted. The app restarts into the restored journal. Your
              API Key, Hotkeys and settings are not restored.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={restoreFromBackup}>
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* The toast is where the user is looking; this is where the answer
          stays. Here before there is anything to say, so what it says next
          is announced rather than merely appearing. */}
      <p
        role="status"
        aria-live="polite"
        className="type-meta text-muted-foreground"
      >
        {status}
      </p>
    </SettingsGroup>
  )
}

/**
 * What a refused restore says: why the candidate was refused, in the Rust
 * side's own words — a newer snapshot, a missing table, a failed integrity
 * check — rather than a generic failure that leaves the user guessing. A
 * refusal stages nothing and restarts nothing.
 */
function restoreRefusal(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message
  }
  if (typeof error === 'string' && error.trim() !== '') {
    return error
  }
  return 'Could not restore the journal.'
}
