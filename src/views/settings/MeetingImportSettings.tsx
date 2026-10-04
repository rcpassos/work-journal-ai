import { useEffect, useRef, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { useOnScreenToast } from '@/components/on-screen-toast'
import { CalendarTicks } from '@/components/CalendarTicks'
import type { CalendarInfo, Desktop } from '@/platform/desktop'
import { describeCalendarAccess } from '@/settings/calendar-access'
import type { AppSettings } from '@/settings/app-settings'
import { DEFAULT_SETTINGS } from '@/settings/settings'
import type { SettingsInitialState } from './SettingsInitialState'
import { useSeededState } from './useSeededState'
import { saySettled } from './saySettled'
import {
  SettingsAside,
  SettingsGroup,
  SettingsProblem,
  SettingsRow,
} from './SettingsGroup'

/** Whether today's meetings are imported, and which calendars are read. */
export default function MeetingImportSettings({
  desktop,
  settings,
  initialSettings,
}: {
  desktop: Desktop
  settings: AppSettings
  initialSettings: Promise<SettingsInitialState | null> | null
}) {
  // Whether the Import switch was touched while the read was still landing:
  // the read must not put its older value back over that press, and it must
  // not take away what the toggle made in the gap produced — the calendars
  // fetched over a permission just granted, or the problem line for one just
  // refused. Gating the calendar work on the toggle's ref alone is enough: a
  // tick made in the gap always follows a toggle (the calendars are only on
  // screen once Import is on), and the ticks' own seed guards itself.
  const [importMeetings, setImportMeetings, importTouched] = useSeededState(
    initialSettings,
    (initial) => initial.stored.importMeetings,
    DEFAULT_SETTINGS.importMeetings,
  )
  const [importCalendars, setImportCalendars] = useSeededState(
    initialSettings,
    (initial) => initial.stored.importCalendars,
    DEFAULT_SETTINGS.importCalendars,
  )
  const [calendars, setCalendars] = useState<CalendarInfo[]>([])
  // Why Import is not on, when the reason is the OS rather than the user.
  // Nothing until there is something to say.
  const [calendarProblem, setCalendarProblem] = useState<string | null>(null)
  // How many Import changes have been started since this group mounted —
  // presses here and announcements of saves made anywhere. A slow
  // permission re-read belongs to the change that started it, and is
  // discarded if a newer one has begun by then.
  const order = useRef(0)
  // A save here ends in a login item, a permission, or a file write the user
  // cannot see; the toast is where each of those is confirmed.
  const says = useOnScreenToast()

  // The calendars to read, and why they are not being read, answered by the
  // read's snapshot of macOS. Skipped when the user already turned Import on
  // in the gap: that toggle asked macOS itself and fetched the calendars over
  // the answer, and the read's older snapshot must not take them away.
  useEffect(() => {
    if (initialSettings === null) return

    void initialSettings.then((initial) => {
      if (initial === null) return
      if (importTouched.current) return

      const { stored, calendarAccess } = initial
      if (calendarAccess === 'granted') {
        void desktop.calendars().then(
          setCalendars,
          (error: unknown) => {
            console.error('could not read the settings', error)
          },
        )
        setCalendarProblem(null)
        return
      }

      setCalendars([])
      // Only worth saying to someone who asked for Import: a user who has
      // never turned it on is owed no explanation for something they never
      // wanted, and the toggle says so for itself the moment they do. The
      // stored wish is the evidence, and it survives the permission going —
      // the sweep does not overwrite it, precisely so this can be said.
      setCalendarProblem(
        stored.importMeetings ? describeCalendarAccess(calendarAccess) : null,
      )
    })
  }, [desktop, initialSettings, importTouched])

  useEffect(() => {
    // An Import save landed — this group's own, or the Onboarding flow's.
    // The wish and the ticks are one fact the file holds, however many
    // controls write it: the flow may change them while this section is
    // mounted but hidden, and the section must hear of it without being
    // rebuilt — that would throw away what else the user has unsaved in
    // Settings. The announcement is newer than anything this group seeded,
    // so it is applied as a change of its own; a rollback still in flight
    // from an earlier press is discarded by the attempt that this starts.
    // The reason underneath is re-derived from what macOS allows now, so a
    // withdrawal made elsewhere takes its reason with it and a grant won
    // elsewhere clears a stale one — and the calendars are fetched over a
    // granted answer, so ticks chosen elsewhere arrive visible.
    return settings.onImportChanged(({ importMeetings, importCalendars }) => {
      const seen = ++order.current
      setImportMeetings(importMeetings)
      setImportCalendars(importCalendars)
      void desktop.calendarAccess().then(
        (access) => {
          if (order.current !== seen) return
          if (access === 'granted') {
            setCalendarProblem(null)
            if (importMeetings) {
              void desktop.calendars().then(
                setCalendars,
                (error: unknown) => {
                  console.error('could not read the calendars', error)
                },
              )
            }
            return
          }
          setCalendarProblem(
            importMeetings ? describeCalendarAccess(access) : null,
          )
        },
        (error: unknown) => {
          console.error('could not read the calendar permission', error)
        },
      )
    })
  }, [desktop, settings, setImportCalendars, setImportMeetings])

  // Import as the window shows it: the user's wish, less whatever macOS is
  // withholding. The stored wish outlives a lost permission — that is what
  // makes the reason sayable — so the toggle is off whenever there is a reason
  // underneath it saying why.
  const importing = importMeetings && calendarProblem === null

  /**
   * Turning Import on is also where the calendar is asked for, because it is
   * the one moment the user has said they want it. Refused, it stays off and
   * says why — the app asks once here and never again on its own.
   */
  function toggleImport(next: boolean) {
    // A press supersedes any announcement still resolving: what it says
    // about the reason underneath belongs to the newer word.
    ++order.current
    void (async () => {
      // The rollback for whatever this press moved, if it moved anything.
      let rollback: ((value: boolean) => void) | undefined
      try {
        if (!next) {
          rollback = setImportMeetings(false)
          await settings.saveImportMeetings(false)
          // Withdrawing takes the reason underneath with it — said by the
          // save's own announcement, which re-derives the reason from what
          // macOS allows now: the switch read off while the wish was on
          // only because the reason said so. A refusal keeps the reason the
          // rollback restores, because a refused save announces nothing.
          says.success('Meetings will no longer be imported.', 'import-meetings')
          return
        }

        const access =
          (await desktop.calendarAccess()) === 'granted'
            ? 'granted'
            : await desktop.requestCalendarAccess()

        if (access !== 'granted') {
          // The wish is kept, not discarded: the toggle reads off because the
          // reason underneath it says so, and a grant given in System Settings
          // later resumes Import without being asked for a second time.
          rollback = setImportMeetings(true)
          setCalendarProblem(describeCalendarAccess(access))
          await settings.saveImportMeetings(true)
          says.success(
            'Meetings will be imported once macOS allows calendars.',
            'import-meetings',
          )
          return
        }

        rollback = setImportMeetings(true)
        setCalendarProblem(null)
        setCalendars(await desktop.calendars())
        await settings.saveImportMeetings(true)
        says.success('Meetings will be imported.', 'import-meetings')
      } catch (error) {
        console.error('could not change how meetings are imported', error)
        says.failure('Could not change how meetings are imported.', 'import-meetings')
        // A refusal from the permission check never moved the switch, so
        // there is nothing to roll back — the arriving read may still seed
        // it. Anything the press did move is rolled back to what the file
        // holds now: the file is what a save is, so only its refusal can
        // arrive after a change took. The rollback belongs to this change: a
        // newer press that landed while it was in flight is not undone by it.
        if (rollback === undefined) return
        const rollbackThisChange = rollback
        void settings.load().then(
          (stored) => rollbackThisChange(stored.importMeetings),
          () => rollbackThisChange(!next),
        )
      }
    })()
  }

  /** Ticking a calendar, or unticking it — an unticked one is ignored. */
  function toggleCalendar(id: string, ticked: boolean) {
    const next = ticked
      ? [...importCalendars, id]
      : importCalendars.filter((each) => each !== id)

    const rollback = setImportCalendars(next)
    saySettled(says, settings.saveImportCalendars(next), {
      id: 'import-calendars',
      saved: 'Calendars saved.',
      couldNot: 'Could not save which calendars to import.',
      what: 'could not change which calendars are imported',
      // Roll back to what the file holds now: the file is what a save is,
      // so the ticks agree with it whatever the refused press moved.
      // The rollback belongs to this change: a newer press that landed while
      // the re-read was in flight is not undone by it. The re-read is newer
      // than the initial snapshot, so it silences the arriving read; the
      // ticks agree with the file.
      onRefused: () => {
        void settings.load().then(
          (stored) => rollback(stored.importCalendars),
          () => rollback(importCalendars),
        )
      },
    })
  }

  return (
    <SettingsGroup>
      <SettingsRow
        label="Meetings"
        explanation="Today's meetings, added to the journal as they end."
        controls="import-meetings"
      >
        <Switch
          id="import-meetings"
          checked={importing}
          // Pressed, the switch means the opposite of the wish rather than
          // the opposite of what it reads: with the permission gone it reads
          // off while the wish is on, and a press there is the user
          // withdrawing it — the reason underneath goes with it. Reading the
          // switch back would ask to turn on what is already wished for,
          // leaving no way to change their mind.
          onCheckedChange={() => toggleImport(!importMeetings)}
        />
      </SettingsRow>

      {calendarProblem !== null && <SettingsProblem>{calendarProblem}</SettingsProblem>}

      {importing && (
        <CalendarTicks
          calendars={calendars}
          ticked={importCalendars}
          onToggle={toggleCalendar}
        />
      )}

      <SettingsAside>
        Declined meetings and all-day blocks are skipped. Deleting a meeting's
        Note keeps it out for good.
      </SettingsAside>
    </SettingsGroup>
  )
}
