import { useEffect, useId, useRef, useState } from 'react'
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  ListTodoIcon,
  FileTextIcon,
  PlusIcon,
  RepeatIcon,
  RotateCcwIcon,
  SearchIcon,
  Trash2Icon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react'
import WindowTitleBar from '@/components/WindowTitleBar'
import SearchField from '@/components/SearchField'
import { useOffScreen } from '@/components/on-screen-context'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
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
import {
  createTasksSession,
  openingTasksSnapshot,
  type TasksSnapshot,
} from '@/journal/tasks-session'
import {
  canUndoCompletion,
  completedOccurrences,
  formatRecurrence,
  formatScheduledFor,
  formatSlot,
  formatTaskCompletedAt,
  isOpen,
  msUntilNextJournalDay,
  scheduleOf,
  slotOf,
  taskIdOfAlert,
  type Clock,
  type Journal,
  type Recurrence,
  type Task,
  type TaskGroupName,
  type TaskOccurrence,
  type TaskSchedule,
  type TaskTiming,
} from '@/journal/journal'
import type { Desktop } from '@/platform/desktop'
import { keysOfHotkey, type HotkeyStatuses } from '@/settings/hotkey'
import TaskDetailsField from './TaskDetailsField'
import ScheduleFields from './ScheduleFields'

/**
 * What each group is called on screen. Overdue first because it is the one
 * already costing the user something; Unscheduled last because it is the only
 * one that is not about time at all.
 */
const GROUP_HEADINGS: Record<TaskGroupName, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
  unscheduled: 'Unscheduled',
}

/**
 * Managing what you owe. Every rule of the two lists — which one opens, what a
 * change re-reads, which group a Task falls in, what a refusal says — belongs
 * to the Tasks session; this view renders its snapshot and calls its verbs.
 *
 * A section of the Main Window, beside History and never on screen with it —
 * see docs/adr/0022-one-main-window-for-reading-and-settings.md. Tasks are
 * organized prospectively and Notes retrospectively, which is why the two are
 * separate sections rather than one list. That window is created on demand and
 * genuinely closed on dismiss, so the session is built once with the section
 * and needs no reset.
 */
export default function TasksView({
  desktop,
  journal,
  clock,
}: {
  desktop: Desktop
  journal: Promise<Journal>
  /**
   * Which day it is, and so which group each Task falls in. Handed down from
   * the composition root like every other collaborator — see
   * docs/adr/0003-one-composition-root-one-desktop-module.md.
   */
  clock: Clock
}) {
  const [snapshot, setSnapshot] = useState<TasksSnapshot>(openingTasksSnapshot)
  const [session] = useState(() =>
    createTasksSession({
      journal,
      // A Task Creation window, a second Tasks View and the reconciliation
      // that keeps macOS's pending Alerts true all learn of a change here only
      // by being told.
      desktop,
      clock,
      onChange: setSnapshot,
    }),
  )
  const { showing, tasks, term, searching, problem, alertRefusal, alertProblem } =
    snapshot

  // The one Task being changed in the Editor, and the one waiting on a
  // confirmed deletion. Both are single, and both are about this screen rather
  // than the session: a list only ever has one change in progress.
  const [editing, setEditing] = useState<Task | null>(null)
  const [deleting, setDeleting] = useState<Task | null>(null)
  // The Task a clicked Task Alert was about. Null until one is clicked: the
  // window opens on the whole list, not on one row.
  const [focused, setFocused] = useState<string | null>(null)
  // Only the empty state reads this, and only to teach the fastest way in.
  // Null until the OS has been asked, and after a question it refused.
  const [hotkeys, setHotkeys] = useState<HotkeyStatuses | null>(null)
  const page = useRef<HTMLDivElement>(null)

  // A confirmation is portalled to the end of the document, so hiding this
  // section leaves it standing over whatever is showing instead — see
  // docs/adr/0024-a-view-is-told-whether-it-is-on-screen.md. It goes with the
  // section, and going is dismissing: a question the user was taken away from
  // is not one they still have open, and nothing has been done to the Task.
  // The Editor stays exactly as it was; it is drawn inside this section, and
  // a half-typed change survives the trip like everything else here.
  useOffScreen(() => setDeleting(null))

  useEffect(() => {
    // A Dock-less app does not reliably hand focus to a new window, and Escape
    // has to reach this view for the window to close. Switching back to this
    // section is the Main Window's to hand over, for the same reason.
    page.current?.focus()

    void session.open()
  }, [session])

  useEffect(() => {
    desktop.hotkeyStatus().then(setHotkeys, (error: unknown) => {
      // The Hotkey is not what this window is for: a status that cannot be read
      // leaves the empty state on the Tray Menu wording.
      console.error('could not read the hotkeys', error)
    })
  }, [desktop])

  useEffect(() => {
    // A Task created in the Task Creation window, or changed in another Tasks
    // View. This window's own changes are heard here too, and cost one extra
    // read that finds the list exactly as it left it.
    const changed = desktop.onTasksChanged(() => {
      void session.refresh()
    })

    // The window is being looked at again, or the machine woke up. Neither
    // changed a Task; both may have changed which group one belongs in, and a
    // window left open overnight would otherwise still say Today.
    const refocused = desktop.onWindowFocused(() => session.regroup())
    const woke = desktop.onSystemWoke(() => session.regroup())

    return () => {
      void changed.then((stop) => stop())
      void refocused.then((stop) => stop())
      void woke.then((stop) => stop())
    }
  }, [desktop, session])

  // Local midnight, when Today stops being today. Re-armed each time rather
  // than left on an interval, so it lands on the boundary itself however long
  // the day turned out to be.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>

    function armForMidnight() {
      timer = setTimeout(() => {
        session.regroup()
        armForMidnight()
      }, msUntilNextJournalDay(clock.now()))
    }

    armForMidnight()

    return () => clearTimeout(timer)
  }, [clock, session])

  useEffect(() => {
    /** Which Task the Alert named — the journal's to say, not this window's. */
    function single(alertId: string) {
      const taskId = taskIdOfAlert(alertId)
      if (taskId === null) return
      setFocused(taskId)
      void session.show('open')
    }

    // The Alert that opened this window, if a click on one did. Asked for
    // rather than waited on: a window built by that very click has no webview
    // yet when the announcement goes out, which is exactly the case an Alert
    // delivered while the app was closed lands in.
    void desktop.openedTaskAlert().then((alertId) => {
      if (alertId !== null) single(alertId)
    }, (error: unknown) => {
      console.error('could not read the Task Alert that opened this', error)
    })

    // And the announcement, for a window that was already on screen. The Rust
    // side writes every click down as well as announcing it, because it cannot
    // know whether a window is listening — so the window that hears one claims
    // what was written down too. Otherwise a click handled here would be left
    // sitting there for the next Tasks View to open, which would single out a
    // Task nobody asked about.
    const opened = desktop.onTaskAlertOpened((alertId) => {
      void desktop.openedTaskAlert().catch((error: unknown) => {
        console.error('could not claim the Task Alert that was announced', error)
      })
      single(alertId)
    })

    // How the reconciliation went. It runs in the capture window, which has no
    // screen, so this is where a failure becomes something the user can see —
    // and where it stops being seen once one succeeds.
    const reconciled = desktop.onTaskAlertsReconciled((held) => {
      session.reconciled(held)
    })

    return () => {
      void opened.then((stop) => stop())
      void reconciled.then((stop) => stop())
    }
  }, [desktop, session])

  // Escape belongs to whatever has taken the screen over: the Editor first,
  // then the deletion, then a Search, and the Main Window when none has.
  // Dismissing that window closes it — it is not kept resident.
  function onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape') return

    if (editing !== null) {
      // Closing the Editor discards, exactly as Cancel does.
      setEditing(null)
      return
    }
    if (deleting !== null) return

    if (searching) {
      // Clears the results and empties the field; the window stays open.
      void session.search('')
      return
    }

    void desktop.closeWindow()
  }

  async function commitEdit(
    task: Task,
    description: string,
    schedule: TaskSchedule | null,
    recurrence: Recurrence | null,
    details: string,
  ) {
    const saved = await session.save(task.id, {
      description,
      details,
      schedule,
      recurrence,
    })
    if (!saved) return
    setEditing((current) => current === task ? null : current)
    // The Task has been dealt with: singling it out has served its purpose.
    setFocused(null)
  }

  /** The one irreversible operation, and the only one that is confirmed. */
  function confirmDelete(task: Task) {
    setDeleting(null)
    void session.delete(task.id)
  }

  /**
   * Answering a Search result focuses the Task where it already sits,
   * switching to the Completed list first if that is where it lives — the
   * same singling-out a clicked Task Alert performs.
   */
  function answerResult(task: Task) {
    setFocused(task.id)
    void session.show(isOpen(task) ? 'open' : 'completed')
  }

  const list = tasks.state === 'tasks' ? tasks.tasks : []
  const groups =
    tasks.state === 'tasks'
      ? tasks.groups.filter((group) => group.tasks.length > 0)
      : []
  const occurrences = tasks.state === 'tasks' ? tasks.occurrences : {}

  function line(task: Task) {
    return (
      <TaskLine
        key={task.id}
        task={task}
        occurrences={occurrences[task.id] ?? []}
        focused={task.id === focused}
        onToggle={(done) =>
          void (done ? session.complete(task.id) : session.reopen(task.id))
        }
        onEdit={() => setEditing(task)}
        onUndoCompletion={() => void session.undoCompletion(task.id)}
        onStopRecurrence={() => void session.stopRecurrence(task.id)}
        onDelete={() => setDeleting(task)}
      />
    )
  }

  return (
    <div
      ref={page}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="relative flex h-screen flex-col bg-background outline-none"
    >
      <WindowTitleBar />

      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-6 py-4 type-meta text-muted-foreground">
        <ToggleGroup
          aria-label="Which Tasks to show"
          spacing={0}
          className="gap-0 rounded-md bg-muted p-0.5"
          value={[showing]}
          onValueChange={(next) => {
            // Pressing the list already showing deselects it, which is not a
            // list at all — one of the two is always on screen.
            const chosen = next[0]
            if (chosen === 'open' || chosen === 'completed') {
              // Whatever an Alert singled out, the user has moved on from it.
              setFocused(null)
              void session.show(chosen)
            }
          }}
        >
          <ToggleGroupItem
            value="open"
            className="rounded-sm! px-2.5 hover:bg-transparent data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-sm"
          >
            Open
          </ToggleGroupItem>
          <ToggleGroupItem
            value="completed"
            className="rounded-sm! px-2.5 hover:bg-transparent data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-sm"
          >
            Completed
          </ToggleGroupItem>
        </ToggleGroup>

        <SearchField
          term={term}
          onType={(typed) => void session.search(typed)}
        />

        {/* One of the Task Entry Points, and it reaches the very same resident
            window the Hotkey and the Tray Menu do — never a second creation
            surface inside this one. */}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => void desktop.beginTaskCreation()}
        >
          <PlusIcon />
          New Task
        </Button>
      </header>

      {problem !== null && editing === null && (
        <p role="alert" className="shrink-0 px-6 pb-3 type-meta text-destructive">
          {problem}
        </p>
      )}

      {/* The Task is saved either way; this says only that macOS will not say
          so out loud. Not an error, and never in the destructive voice. */}
      {alertRefusal !== null && (
        <p role="status" className="shrink-0 px-6 pb-3 type-meta text-muted-foreground">
          {alertRefusal}
        </p>
      )}

      {/* The Tasks and their schedules are untouched; what failed is only the
          OS's copy of them, which the next reconciliation asks for again. */}
      {alertProblem !== null && (
        <p role="status" className="shrink-0 px-6 pb-3 type-meta text-muted-foreground">
          {alertProblem}
        </p>
      )}

      <main className="flex-1 overflow-y-auto px-6 pb-5">
        {tasks.state === 'unreadable' && (
          <EmptyState
            icon={TriangleAlertIcon}
            heading="The Tasks could not be read."
          />
        )}
        {tasks.state === 'tasks' && list.length === 0 && showing === 'open' && (
          <NoOpenTasks hotkeys={hotkeys} />
        )}
        {tasks.state === 'tasks' &&
          list.length === 0 &&
          showing === 'completed' && (
            <EmptyState
              icon={CheckCircle2Icon}
              heading="No Completed Tasks yet"
            />
          )}
        {tasks.state === 'results' && tasks.tasks.length === 0 && (
          <EmptyState
            icon={SearchIcon}
            heading={`No Tasks say “${tasks.term}”.`}
          />
        )}

        {/* A Search replaces the list outright: exactly one of them is on
            screen, and the groups do not survive it. */}
        {tasks.state === 'results' && tasks.tasks.length > 0 && (
          <ol className="flex flex-col gap-1">
            {tasks.tasks.map((task) => (
              <TaskResultLine
                key={task.id}
                task={task}
                onShow={() => answerResult(task)}
              />
            ))}
          </ol>
        )}

        {/* Open Tasks are grouped by where they sit relative to today;
            Completed Tasks are one list, newest kept first, because a
            commitment already kept has no schedule left to be in front of. */}
        {showing === 'open' && groups.length > 0 && (
          <div className="flex flex-col gap-5">
            {groups.map((group) => (
              <TaskGroupSection key={group.name} name={group.name}>
                {group.tasks.map(line)}
              </TaskGroupSection>
            ))}
          </div>
        )}
        {showing === 'completed' && list.length > 0 && (
          <ol className="flex flex-col gap-1">{list.map(line)}</ol>
        )}
      </main>

      {editing !== null && (
        <TaskEditor
          task={editing}
          problem={problem}
          onSave={(description, schedule, recurrence, details) =>
            commitEdit(editing, description, schedule, recurrence, details)
          }
          onCancel={() => setEditing(null)}
        />
      )}

      <ConfirmDelete
        task={deleting}
        history={
          deleting === null
            ? []
            : completedOccurrences(occurrences[deleting.id] ?? [])
        }
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  )
}

/** One group of Open Tasks, under the heading that says what it is. */
function TaskGroupSection({
  name,
  children,
}: {
  name: TaskGroupName
  children: React.ReactNode
}) {
  const headingId = useId()

  return (
    <section aria-labelledby={headingId}>
      <h2
        id={headingId}
        className={`px-2 pb-1.5 type-meta ${
          name === 'overdue' ? 'text-destructive' : 'text-muted-foreground'
        }`}
      >
        {GROUP_HEADINGS[name]}
      </h2>
      <ol className="flex flex-col gap-1">{children}</ol>
    </section>
  )
}

/**
 * One Search result: what the Task says, and the state it is in. The whole
 * row is the way in, because answering a result has exactly one meaning —
 * focus the Task where it already sits. The Tasks are not changeable here: a
 * result is a signpost to a list, and the list is where the Task lives.
 */
function TaskResultLine({ task, onShow }: { task: Task; onShow: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onShow}
        className="flex w-full gap-3 rounded-md px-2 py-1 text-left type-body outline-none hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        <span className="flex-1">{task.description}</span>
        <TaskDetailsIndicator task={task} />
        <span className="shrink-0 pt-px type-meta text-muted-foreground">
          {isOpen(task) ? 'Open' : 'Completed'}
        </span>
      </button>
    </li>
  )
}

/**
 * One Task as it reads now: the checkbox that completes it, what it says, when
 * it is meant to be done, how often it comes round again, and the ways to
 * change or remove it. The description is the primary line; its schedule is
 * supporting metadata beneath it. Pressing the description opens the Editor —
 * a Task is one line, and changing it is a decision rather than a place to put
 * a cursor.
 *
 * The checkbox completes immediately and asks nothing: completing is reversible
 * from the row beside it, and a confirmation on the most ordinary action in the
 * app would be in the way every single time. Completing a Recurring Task
 * advances it to its next slot, and offers Undo Completion for exactly as long
 * as taking that back is safe.
 */
function TaskLine({
  task,
  occurrences,
  focused,
  onToggle,
  onEdit,
  onUndoCompletion,
  onStopRecurrence,
  onDelete,
}: {
  task: Task
  /** Every Task Occurrence of a Recurring Task, and none for any other. */
  occurrences: TaskOccurrence[]
  /** The one a clicked Task Alert was about, if this is it. */
  focused: boolean
  onToggle: (completed: boolean) => void
  onEdit: () => void
  onUndoCompletion: () => void
  onStopRecurrence: () => void
  onDelete: () => void
}) {
  const done = task.completedAt !== null
  const scheduled = formatScheduledFor(task)
  const row = useRef<HTMLLIElement>(null)
  const history = completedOccurrences(occurrences)
  // The record's own answer, not this view's: undoing is safe exactly while
  // the Open occurrence still points back at the completion being undone.
  const undoable = canUndoCompletion(occurrences)

  useEffect(() => {
    // Guarded because not every environment the view runs in implements it,
    // and a row that did not scroll is still the row that is singled out.
    if (focused) row.current?.scrollIntoView?.({ block: 'center' })
  }, [focused])

  return (
    <li
      ref={row}
      aria-current={focused ? 'true' : undefined}
      className={`group rounded-md py-2 pl-2 pr-1 hover:bg-muted/40 focus-within:bg-muted/40 ${
        focused ? 'bg-muted/60 ring-2 ring-ring/40' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="pt-1">
          <Checkbox
            checked={done}
            onCheckedChange={onToggle}
            aria-label={
              done
                ? `Reopen \u201C${task.description}\u201D`
                : `Complete \u201C${task.description}\u201D`
            }
          />
        </span>

        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onEdit}
            className={`block w-full min-w-0 cursor-text rounded-sm py-0.5 text-left type-title outline-none focus-visible:ring-2 focus-visible:ring-ring/30 ${
              done ? 'text-muted-foreground line-through' : ''
            }`}
          >
            {task.description}
            <TaskDetailsIndicator task={task} />
          </button>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 type-meta text-muted-foreground">
            {/* What the Task repeats on, in the same words an export writes. */}
            {task.recurrence !== null && (
              <span className="flex items-center gap-1">
                <RepeatIcon className="size-3" aria-hidden />
                {formatRecurrence(task.recurrence)}
              </span>
            )}

            {/* Only while the commitment is still open: a Task that was kept
                is about when it was kept, not about when it was meant to be. */}
            {!done && scheduled !== null && (
              <span className="tabular-nums">{scheduled}</span>
            )}

            {task.completedAt !== null && (
              <time dateTime={task.completedAt} className="tabular-nums">
                {formatTaskCompletedAt(task.completedAt)}
              </time>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
          {/* Offered only while it is safe. A completion whose successor was
              edited or completed stays historical, because undoing it would
              either open two occurrences at once or throw away a later
              decision. */}
          {undoable && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onUndoCompletion}
              aria-label={`Undo the last completion of \u201C${task.description}\u201D`}
              className="text-muted-foreground"
            >
              <RotateCcwIcon />
            </Button>
          )}
          {task.recurrence !== null && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onStopRecurrence}
              aria-label={`Stop repeating \u201C${task.description}\u201D`}
              className="text-muted-foreground"
            >
              Stop repeating
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            aria-label={`Delete \u201C${task.description}\u201D`}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>

      <OccurrenceHistory task={task} history={history} />
    </li>
  )
}

/**
 * What a Recurring Task has already kept, attached to the Task rather than
 * mixed into the ordinary Completed Tasks: a Recurring Task is still Open, and
 * what it kept belongs under it.
 *
 * Collapsed until it is asked for — a Task is one line, and a fortnight of kept
 * occurrences under every one would bury the list — and absent entirely for the
 * Tasks with nothing kept, which is most of them.
 */
function OccurrenceHistory({
  task,
  history,
}: {
  task: Task
  /** The kept occurrences, most recently completed first. */
  history: TaskOccurrence[]
}) {
  const [showing, setShowing] = useState(false)

  if (history.length === 0) return null

  return (
    <div className="pl-8">
      <button
        type="button"
        aria-expanded={showing}
        aria-label={`Completed occurrences of \u201C${task.description}\u201D`}
        onClick={() => setShowing((open) => !open)}
        className="flex items-center gap-1 rounded-sm py-0.5 type-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        <ChevronRightIcon
          aria-hidden
          className={`size-3 transition-transform ${showing ? 'rotate-90' : ''}`}
        />
        {history.length === 1
          ? '1 completed occurrence'
          : `${history.length} completed occurrences`}
      </button>

      {showing && (
        <ol className="flex flex-col gap-0.5 pb-1 pl-4">
          {history.map((occurrence) => (
            <li
              key={occurrence.id}
              className="flex items-baseline gap-2 tabular-nums type-meta text-muted-foreground"
            >
              <span>{formatSlot(slotOf(occurrence))}</span>
              <time dateTime={occurrence.completedAt!}>
                {`kept ${formatTaskCompletedAt(occurrence.completedAt!)}`}
              </time>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/**
 * The sheet that changes an existing Task: the wording, when it is meant to be
 * done, and how often it comes round again. Save commits all of it; Cancel,
 * Escape and closing all discard. It is inside this window rather than the
 * resident Task Creation one on purpose: reusing that window would throw away
 * an unfinished new Task to edit an old one.
 *
 * Changing the starting date, the selected weekdays, the cadence or the time
 * reanchors a continuing series and replaces its Open occurrence — which is a
 * change to the series rather than an exception on one occurrence, so nothing
 * here offers a this-and-following choice.
 *
 * Clearing the date on a Recurring Task asks first, because it also stops the
 * recurrence: the date is what the cadence is counted from.
 *
 * Schedule words in the description are never read for meaning — the date, the
 * time and the cadence are chosen with their own controls, and the description
 * stays exactly as written. See CONTEXT.md.
 */
function TaskEditor({
  task,
  problem,
  onSave,
  onCancel,
}: {
  task: Task
  problem: string | null
  onSave: (
    description: string,
    schedule: TaskSchedule | null,
    recurrence: Recurrence | null,
    details: string,
  ) => Promise<void>
  onCancel: () => void
}) {
  const [description, setDescription] = useState(task.description)
  const [details, setDetails] = useState(task.details ?? '')
  const [saving, setSaving] = useState(false)
  const [schedule, setSchedule] = useState(scheduleOf(task))
  const headingId = useId()
  const [recurrence, setRecurrence] = useState(task.recurrence)
  // A change to the schedule that would stop an existing recurrence, waiting
  // to be confirmed. Null until one is asked for.
  const [stopping, setStopping] = useState<TaskTiming | null>(null)
  // The question goes with the section, though the Editor underneath it does
  // not: it is a dialog portalled out of the document, and the answer changes
  // nothing until it is given. What was typed here is untouched.
  useOffScreen(() => setStopping(null))
  const said = description.trim()
  // Task Description and Details stay editable while Completed: reopening
  // is what makes a schedule changeable again, and it is a decision the user
  // makes rather than one a save makes quietly on their behalf.
  const completed = task.completedAt !== null

  async function save() {
    if (saving) return
    setSaving(true)
    try {
      await onSave(description, schedule, recurrence, details)
    } finally {
      setSaving(false)
    }
  }

  /**
   * A change to the schedule row. Losing the date takes the cadence with it,
   * which is Stop Recurrence the user did not ask for by name — so a Task that
   * actually has one is asked about before the control changes under them.
   *
   * Only the date. Choosing "Does not repeat" is the user saying it outright,
   * and a dialog confirming what they just picked would be in the way.
   */
  function changeSchedule(next: TaskTiming) {
    if (next.schedule === null && schedule !== null && recurrence !== null) {
      setStopping(next)
      return
    }

    setSchedule(next.schedule)
    setRecurrence(next.recurrence)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && said !== '') {
      event.preventDefault()
      void save()
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      className="absolute inset-x-0 bottom-0 z-20 flex max-h-full flex-col gap-3 overflow-y-auto border-t border-border bg-popover px-6 py-4 shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.4)]"
    >
      <h2 id={headingId} className="type-section">
        Edit Task
      </h2>
      <input
        autoFocus
        type="text"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Task Description"
        autoComplete="off"
        spellCheck={false}
        className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 type-body text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      />

      <TaskDetailsField value={details} onChange={setDetails} />

      {completed ? (
        <p className="type-meta text-muted-foreground">
          A Completed Task keeps its schedule. Reopen it to change when it is
          meant to be done.
        </p>
      ) : (
        <ScheduleFields
          schedule={schedule}
          recurrence={recurrence}
          onChange={changeSchedule}
        />
      )}

      {problem !== null && (
        <p role="alert" className="type-meta text-destructive">{problem}</p>
      )}

      <div className="flex shrink-0 justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={said === '' || saving} onClick={() => void save()}>
          Save
        </Button>
      </div>

      <ConfirmStopRecurrence
        open={stopping !== null}
        onConfirm={() => {
          if (stopping === null) return
          setSchedule(stopping.schedule)
          setRecurrence(null)
          setStopping(null)
        }}
        onCancel={() => setStopping(null)}
      />
    </div>
  )
}

/**
 * The guard on clearing the date a cadence is counted from, which stops the
 * recurrence as a side effect. Only that: Stop repeating and Does not repeat
 * are the user saying it outright, and confirming what somebody just chose
 * would be in the way. Nothing is destroyed either way — the Task stays where
 * it stands and every completed occurrence stays under it.
 */
function ConfirmStopRecurrence({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(showing) => {
        if (!showing) onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop repeating this Task?</AlertDialogTitle>
          <AlertDialogDescription>
            A cadence is counted from its date, so clearing the date also stops
            the recurrence. The Task stays exactly where it is, and so does
            everything it has already completed. It simply stops coming round
            again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            Stop repeating
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * The guard on the one irreversible operation. There is no trash and no undo,
 * so the confirmation says plainly that this is permanent.
 */
function ConfirmDelete({
  task,
  history,
  onConfirm,
  onCancel,
}: {
  task: Task | null
  /**
   * What the Task has already kept, which goes with it. Asked of the
   * occurrences rather than of the cadence: a Task whose recurrence was
   * stopped still has a history to lose.
   */
  history: TaskOccurrence[]
  onConfirm: (task: Task) => void
  onCancel: () => void
}) {
  return (
    <AlertDialog
      open={task !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this Task?</AlertDialogTitle>
          <AlertDialogDescription>
            “{task?.description}” will be gone for good
            {history.length === 0
              ? ''
              : ', and every occurrence it has completed with it'}
            . There is no trash and no undo.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => task !== null && onConfirm(task)}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Nothing owed yet, and the fastest way to owe something. The Tray Menu is the
 * fallback, and is all this says when the Task Hotkey is unavailable or
 * unknown: an empty state that taught a combination doing nothing would be
 * worse than the slow way in.
 */
function NoOpenTasks({ hotkeys }: { hotkeys: HotkeyStatuses | null }) {
  const task = hotkeys?.task

  return (
    <EmptyState icon={ListTodoIcon} heading="No Open Tasks">
      {task?.state === 'registered' ? (
        <>
          Press{' '}
          <KbdGroup className="align-baseline">
            {keysOfHotkey(task.hotkey).map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </KbdGroup>
          , type one line about what you need to do, and press Enter. New Task in
          the Work Journal menu does the same thing.
        </>
      ) : (
        <>
          Choose New Task from the Work Journal menu, type one line about what
          you need to do, and press Enter.
        </>
      )}
    </EmptyState>
  )
}

/**
 * A list that is not there, and why. The icon and the heading are what make it
 * read as an answer rather than as a page still loading.
 */
function EmptyState({
  icon: Icon,
  heading,
  children,
}: {
  icon: LucideIcon
  heading: string
  children?: React.ReactNode
}) {
  const headingId = useId()

  return (
    <section
      aria-labelledby={headingId}
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center type-body"
    >
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <Icon className="size-5" />
      </span>
      <h2 id={headingId} className="type-section text-foreground">
        {heading}
      </h2>
      {children !== undefined && (
        <p className="max-w-sm text-muted-foreground">{children}</p>
      )}
    </section>
  )
}

function TaskDetailsIndicator({ task }: { task: Task }) {
  if (task.details === null) return null
  return (
    <FileTextIcon
      role="img"
      aria-label="Has Task Details"
      className="ml-2 inline size-3 text-muted-foreground"
    />
  )
}
