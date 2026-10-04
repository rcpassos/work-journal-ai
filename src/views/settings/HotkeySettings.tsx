import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useOnScreenToast } from '@/components/on-screen-toast'
import type { Desktop } from '@/platform/desktop'
import {
  describeHotkeyAction,
  describeUnavailableHotkey,
  hotkeyForKeystroke,
  HOTKEY_ACTIONS,
  keysOfHotkey,
  type HotkeyAction,
  type HotkeyStatus,
} from '@/settings/hotkey'
import type { SettingsInitialState } from './SettingsInitialState'
import { useSeededState } from './useSeededState'
import { saySettled } from './saySettled'
import {
  SettingsAside,
  SettingsGroup,
  SettingsProblem,
  SettingsRow,
} from './SettingsGroup'

/** The Note and Task Hotkeys, each independently remappable. */
export default function HotkeySettings({
  desktop,
  initialSettings,
}: {
  desktop: Desktop
  initialSettings: Promise<SettingsInitialState | null> | null
}) {
  // The pair as the window opens with it, seeded by the read until a remap
  // the user completed in the gap has set it — the read's pair is captured
  // before that remap, and must not be put back over it.
  const [hotkeys, setHotkeys] = useSeededState(
    initialSettings,
    (initial) => initial.hotkeys,
    null,
  )
  // The reason the last remap of each action was refused, if it was. Cleared by
  // the next one, and kept per action: a Task Hotkey the OS refused says
  // nothing about the Note Hotkey sitting above it.
  const [hotkeyProblem, setHotkeyProblem] = useState<
    Partial<Record<HotkeyAction, string>>
  >({})
  // Which recorder is listening, if either. One at a time: a keystroke can only
  // belong to one of them.
  const [recording, setRecording] = useState<HotkeyAction | null>(null)
  // A remap is a save with no other feedback than the chips changing: the
  // toast is where the user hears that the combination was taken, or why it
  // was refused.
  const says = useOnScreenToast()

  const remap = useCallback(
    (action: HotkeyAction, next: string) => {
      setRecording(null)
      // The setting's own name — `Note Hotkey`, not the bare action — the
      // same name a refusal below is said against.
      const { label } = describeHotkeyAction(action)
      saySettled(says, desktop.setHotkey(action, next), {
        id: `hotkey-${action}`,
        saved: `${label} saved.`,
        couldNot: `Could not save the ${label}.`,
        onSaved: (status) => {
          setHotkeys(status)
          setHotkeyProblem((problems) => ({ ...problems, [action]: undefined }))
        },
        onRefused: (reason: unknown) => {
          setHotkeyProblem((problems) => ({
            ...problems,
            [action]: describeUnavailableHotkey(action, next, String(reason)),
          }))
        },
      })
    },
    [desktop, says, setHotkeys],
  )

  return (
    <SettingsGroup>
      {HOTKEY_ACTIONS.map(({ action, label, explanation }) => {
        const status = hotkeys?.[action] ?? null
        const refused = hotkeyProblem[action]

        return (
          <div key={action} className="flex flex-col gap-2">
            <SettingsRow label={label} explanation={explanation}>
              <HotkeyRecorder
                label={label}
                recording={recording === action}
                hotkey={status}
                onStart={() => {
                  setRecording(action)
                  setHotkeyProblem((problems) => ({
                    ...problems,
                    [action]: undefined,
                  }))
                }}
                onAbandon={() => setRecording(null)}
                onRecord={(next) => remap(action, next)}
              />
            </SettingsRow>

            {status?.state === 'unavailable' && (
              <SettingsProblem>
                {describeUnavailableHotkey(
                  action,
                  status.hotkey,
                  status.reason,
                )}
              </SettingsProblem>
            )}
            {refused !== undefined && <SettingsProblem>{refused}</SettingsProblem>}
          </div>
        )
      })}

      <SettingsAside>
        The two can't be the same, or a combination another app has claimed.
      </SettingsAside>
    </SettingsGroup>
  )
}

/**
 * The Hotkey as it stands, and the one way to change it: press the combination
 * rather than describe it, so what is recorded is what the OS will see. It
 * reads as keys because that is what it is — one chip per key, in the order
 * they are held down.
 */
function HotkeyRecorder({
  label,
  recording,
  hotkey,
  onStart,
  onAbandon,
  onRecord,
}: {
  /** Which Hotkey this is, so the two recorders are told apart out loud. */
  label: string
  recording: boolean
  hotkey: HotkeyStatus | null
  onStart: () => void
  onAbandon: () => void
  onRecord: (hotkey: string) => void
}) {
  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    // Every keystroke belongs to the recorder while it is listening, including
    // the ones the OS would otherwise act on.
    event.preventDefault()
    event.stopPropagation()

    if (event.key === 'Escape') {
      onAbandon()
      return
    }

    const next = hotkeyForKeystroke(event)
    // Null while only modifiers are down: the combination is not finished yet.
    if (next !== null) {
      onRecord(next)
    }
  }

  if (recording) {
    return (
      <button
        type="button"
        autoFocus
        onKeyDown={onKeyDown}
        onBlur={onAbandon}
        className="rounded-md border border-ring bg-transparent px-3 py-1.5 type-meta text-foreground outline-none ring-2 ring-ring/30"
      >
        Press a combination…
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <KbdGroup role="group" aria-label={`Current ${label}`}>
        {/* Nothing yet while the Rust side is still being asked. */}
        {(hotkey === null ? ['…'] : keysOfHotkey(hotkey.hotkey)).map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </KbdGroup>
      <Button
        variant="outline"
        size="sm"
        onClick={onStart}
        aria-label={`Change ${label}`}
      >
        Change
      </Button>
    </div>
  )
}
