import { useEffect } from 'react'
import { useOnScreenToast } from '@/components/on-screen-toast'
import { Switch } from '@/components/ui/switch'
import type { Desktop } from '@/platform/desktop'
import type { AppSettings } from '@/settings/app-settings'
import { DEFAULT_SETTINGS } from '@/settings/settings'
import type { SettingsInitialState } from './SettingsInitialState'
import { useSeededState } from './useSeededState'
import { saySettled } from './saySettled'
import { SettingsGroup, SettingsRow } from './SettingsGroup'

/**
 * The start-at-login preference. Its own first-run question is gone: a fresh
 * installation is invited to start at login inside the Onboarding flow
 * instead, once, so the app never asks about it in two places — see
 * docs/onboarding.md. What remains is the switch, which reads and writes the
 * same login item it always did.
 */
export default function StartAtLoginSettings({
  desktop,
  settings,
  initialSettings,
}: {
  desktop: Desktop
  settings: AppSettings
  initialSettings: Promise<SettingsInitialState | null> | null
}) {
  // Whether the switch was answered while the read was still landing: the
  // read must not put its older value back over that answer.
  const [startAtLogin, setStartAtLogin] = useSeededState(
    initialSettings,
    (initial) => initial.startAtLogin,
    DEFAULT_SETTINGS.startAtLogin,
  )

  useEffect(() => {
    // A Start at Login save landed — this switch's own, or the Onboarding
    // flow's. The login item is one fact the OS holds, however many controls
    // write it, and every control has to agree with it: the flow may change
    // it while this section is mounted but hidden, and the section's state
    // must not be rebuilt to hear of it — that would throw away what else
    // the user has unsaved in Settings. The announced value is newer than
    // anything this row seeded, so it is applied as a change of its own; a
    // rollback still in flight from an earlier press is discarded by the
    // attempt that this starts.
    return settings.onStartAtLoginChanged((next) => {
      setStartAtLogin(next)
    })
  }, [settings, setStartAtLogin])
  // The switch has no other answer than itself: what the OS made of it — or
  // what refused it — is said rather than left to be discovered at the next
  // login.
  const says = useOnScreenToast()

  function toggleStartAtLogin(next: boolean) {
    const rollback = setStartAtLogin(next)
    saySettled(says, settings.saveStartAtLogin(next), {
      id: 'start-at-login',
      // The outcome, not the toggle state: an answer already on with the
      // file rewritten beneath it is worth saying, because the user cannot
      // see the file.
      saved: next
        ? 'Work Journal will start at login.'
        : 'Work Journal will not start at login.',
      couldNot: 'Could not change whether Work Journal starts at login.',
      what: 'could not change the login item',
      // Roll back to what the OS says now — the login item is changed before
      // the file is written, so a refusal leaves both holding the earlier
      // wish. The re-read is newer than the initial snapshot, so it silences
      // the arriving read; the switch agrees with the OS and the file.
      onRefused: () => {
        void desktop.startsAtLogin().then(rollback, () => rollback(!next))
      },
    })
  }

  return (
    <SettingsGroup>
      <SettingsRow
        label="Start at Login"
        explanation="Whether Work Journal launches when you log in."
        controls="start-at-login"
      >
        <Switch
          id="start-at-login"
          checked={startAtLogin}
          onCheckedChange={toggleStartAtLogin}
        />
      </SettingsRow>
    </SettingsGroup>
  )
}
