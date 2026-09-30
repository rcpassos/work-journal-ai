import { useCallback, useEffect, useRef, useState } from 'react'
import KeyHint from '@/components/KeyHint'
import type { Journal, Recurrence, TaskSchedule } from '@/journal/journal'
import { askAboutTaskAlerts } from '@/journal/task-alerts'
import {
  CAPTURE_FIELD_HEIGHT,
  CAPTURE_HAIRLINE,
  CAPTURE_PANEL_BORDER,
  CAPTURE_REFUSAL_HEIGHT,
  CAPTURE_SHADOW_GUTTER,
  TASK_CREATION_RECURRENCE_ROW,
  TASK_CREATION_SCHEDULE_ROW,
  type Desktop,
} from '@/platform/desktop'
import ScheduleFields from './ScheduleFields'
import TaskDetailsField from './TaskDetailsField'

/**
 * One line, one keystroke — a Task rather than a Note — and, if the user wants
 * them, the day it is meant to be done on and how often it comes round again.
 * The window behind this view is
 * created at startup and only ever shown and hidden, and it is its own window
 * rather than a mode of the capture one so that an unfinished Capture and an
 * unfinished Task Creation can both be sitting there at once; see
 * docs/adr/0019-task-creation-has-its-own-resident-window.md.
 *
 * Scheduled For and the cadence are optional and explicit, and the date is the
 * prerequisite for both. The description is committed verbatim whatever it
 * says — a line reading "every Tuesday at 9" schedules and repeats nothing,
 * because nothing here reads it for meaning.
 *
 * The field is reset when a Task Creation *ends* rather than when one begins:
 * an Entry Point reached while the window is already up focuses it and changes
 * nothing, so what was typed survives being asked for again, and Escape or a
 * commit is what leaves the next one empty.
 *
 * Nothing here is rendered into a portal, and nothing here may be: the window
 * is transparent, undecorated and only as tall as this view asks for, so
 * anything drawn outside the panel is clipped by the window's own edge.
 */
export default function TaskCreationView({
  desktop,
  journal,
}: {
  desktop: Desktop
  journal: Promise<Journal>
}) {
  const [description, setDescription] = useState('')
  const [details, setDetails] = useState('')
  // Scheduled For as the row under the field has it. Null is Unscheduled,
  // which is where every Task Creation starts: a Task without a date is a
  // complete Task, not a draft waiting for one.
  const [schedule, setSchedule] = useState<TaskSchedule | null>(null)
  // And how often it comes round again. Null is a Task that does not repeat,
  // which is where every Task Creation starts — and clearing the date clears
  // this with it, because a cadence has nothing to be counted from without one.
  const [recurrence, setRecurrence] = useState<Recurrence | null>(null)
  // How many times this Task Creation has been refused. Counted rather than
  // flagged so a second refusal is a second thing on screen: the message
  // invites another Enter, and one that changed nothing would read as the
  // silence it replaced.
  const [refusals, setRefusals] = useState(0)
  const field = useRef<HTMLInputElement>(null)

  const dismiss = useCallback(async () => {
    // The next Task Creation starts empty, whether this one committed or not —
    // and empty means Unscheduled too, not the last date that happened to be
    // chosen.
    setDescription('')
    setDetails('')
    setSchedule(null)
    setRecurrence(null)
    setRefusals(0)
    await desktop.dismissTaskCreation()
  }, [desktop])

  const commit = useCallback(
    async (
      said: string,
      scheduledFor: TaskSchedule | null,
      repeats: Recurrence | null,
    ) => {
      // Nothing to commit is not a refusal: it is a keystroke that means
      // nothing yet, exactly as it is during a Capture.
      if (said.trim() === '') return

      try {
        await (await journal).createTask(said, scheduledFor, repeats, details)
      } catch (error) {
        // A Task that could not be stored must not vanish: leave the window
        // open with the description still in it, and say so, since a window
        // that merely stayed open reads as a missed keystroke.
        console.error('could not commit the Task', error)
        setRefusals((refused) => refused + 1)
        return
      }

      // A Tasks View already on screen has no other way to learn of it, and the
      // announcement has to leave before the window goes — dismissing hides the
      // whole app. It is not the Task Creation's problem either way: the Task
      // is stored regardless.
      try {
        await desktop.announceTasksChanged()
      } catch (error) {
        console.error('could not announce the Task', error)
      }

      await dismiss()

      // Asked after the window has gone, and never waited on: the prompt is
      // the system's and belongs in front of whatever the user is doing, not
      // behind a panel held open for it. The Task is stored either way — see
      // docs/adr/0017-the-os-schedules-task-alerts.md.
      //
      // The answer is deliberately not shown here: by the time it arrives this
      // window is gone, and there is nowhere honest to put it. A refusal is
      // the user's own answer to a prompt they just saw, and Settings › Task
      // Alerts is where it stays sayable afterwards. A grant announces, so the
      // window that registers the Alerts hears it — and if that registration
      // fails, an open Tasks View says so.
      if (scheduledFor !== null && scheduledFor.time !== null) {
        void askAboutTaskAlerts(desktop).then((answer) => {
          if (answer !== 'granted') {
            console.warn('the first timed Task got no Task Alert:', answer)
          }
        })
      }
    },
    [desktop, journal, dismiss, details],
  )

  useEffect(() => {
    // The page behind the window has to give way to the rounded corners drawn
    // below; only this window's document is marked, since the bundle is shared.
    document.body.classList.add('capture-window')

    field.current?.focus()

    // Shown again after having been hidden: take focus, and change nothing
    // else. A window is put away either by a dismiss, which has already
    // cleared it, or by the other Entry Point being invoked, which must leave
    // the half-typed description exactly where the user left it.
    const shown = desktop.onTaskCreationShown(() => field.current?.focus())
    // Clicking away is an abandon, not a Task Creation left floating over the
    // screen. Unless the window is already gone: another Work Journal window
    // was invoked — the other resident panel, or the Main Window — the Rust
    // side put this one away, and the description waiting here has to survive
    // that rather than being thrown away behind the user's back.
    const blurred = desktop.onWindowBlurred(() => {
      void desktop.isWindowVisible().then((visible) => {
        if (visible) void dismiss()
      })
    })

    return () => {
      document.body.classList.remove('capture-window')
      void shown.then((stop) => stop())
      void blurred.then((stop) => stop())
    }
  }, [desktop, dismiss])

  // The refusal grows the window rather than sharing the field's room, so the
  // description the user is being told about stays in sight and stays editable.
  // A window of the wrong size is worth logging and nothing more: the Task is
  // unaffected either way.
  useEffect(() => {
    desktop.fitTaskCreation(refusals > 0).catch((error: unknown) => {
      console.error('could not fit the Task Creation window', error)
    })
  }, [desktop, refusals])

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      void commit(description, schedule, recurrence)
    }
  }

  return (
    <div
      className="flex h-screen flex-col"
      style={{ padding: CAPTURE_SHADOW_GUTTER }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') void dismiss()
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void dismiss()
      }}
    >
      <div
        style={{ borderWidth: CAPTURE_PANEL_BORDER }}
        className="flex shrink-0 flex-col overflow-hidden rounded-2xl border-border bg-background shadow-[0_12px_24px_-4px_rgb(0_0_0/0.28),0_2px_8px_-2px_rgb(0_0_0/0.16)] dark:shadow-[0_12px_24px_-4px_rgb(0_0_0/0.6),0_2px_8px_-2px_rgb(0_0_0/0.45)]"
      >
        <div className="relative shrink-0">
          <input
            ref={field}
            type="text"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label="What do you need to do?"
            placeholder="What do you need to do?"
            aria-describedby={
              refusals > 0 ? `${BARGAIN_ID} ${PROBLEM_ID}` : BARGAIN_ID
            }
            autoComplete="off"
            spellCheck={false}
            style={{ height: CAPTURE_FIELD_HEIGHT }}
            className="w-full rounded-2xl bg-transparent pl-5 pr-52 type-field outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
          />
          <div
            id={BARGAIN_ID}
            className="pointer-events-none absolute inset-y-0 right-5 flex select-none items-center gap-3 type-micro text-muted-foreground/70"
          >
            <KeyHint
              glyph="↵"
              reading="Return creates the Task."
              what="creates"
              action="Create Task"
              onPress={() => void commit(description, schedule, recurrence)}
            />
            <KeyHint glyph="esc" reading="Escape abandons." what="abandons" />
          </div>
        </div>
        <div className="shrink-0 px-5 pb-3">
          <TaskDetailsField value={details} onChange={setDetails} />
        </div>
        {/* Under the field rather than beside it: the description is what a
            Task is, and the day it is meant to be done on is a second thought
            the user may never have. Its height is part of the window's resting
            size, so choosing a date never resizes anything. */}
        <div
          style={{
            height: TASK_CREATION_SCHEDULE_ROW + TASK_CREATION_RECURRENCE_ROW,
            borderTopWidth: CAPTURE_HAIRLINE,
          }}
          className="flex shrink-0 items-center border-border px-4"
        >
          <ScheduleFields
            schedule={schedule}
            recurrence={recurrence}
            onChange={(next) => {
              setSchedule(next.schedule)
              setRecurrence(next.recurrence)
            }}
          />
        </div>

        {refusals > 0 && (
          <p
            key={refusals}
            id={PROBLEM_ID}
            role="alert"
            style={{ height: CAPTURE_REFUSAL_HEIGHT }}
            className="flex shrink-0 items-center px-5 type-meta text-destructive"
          >
            {TASK_REFUSED}
          </p>
        )}
      </div>
    </div>
  )
}

const PROBLEM_ID = 'task-creation-problem'
const BARGAIN_ID = 'task-creation-bargain'

/** What a refused Task Creation says, in the app's voice rather than the error's. */
const TASK_REFUSED = 'That Task could not be stored. Press Enter to retry.'
