/**
 * The journal core: every domain operation and every SQL statement in the app.
 * It depends on exactly two injected collaborators — a clock and a SQL driver —
 * so it can be driven end to end from a test without Tauri, a webview, or a
 * real database. Views render what the core returns and call its operations in
 * response to input; no domain rule, formatting rule or SQL lives outside this
 * file.
 */

/** The instant a Note came into existence, and nothing else. */
export interface Clock {
  now(): Date
}

/** The machine's clock: the one the app runs on, wherever it needs one. */
export const systemClock: Clock = { now: () => new Date() }

/** One statement of the app's storage surface: SQL plus its parameters. */
export interface SqlStatement {
  sql: string
  params: unknown[]
}

/** The whole of the app's storage surface: statements, and a real transaction. */
export interface SqlDriver {
  execute(sql: string, params: unknown[]): Promise<unknown>
  select<Row>(sql: string, params: unknown[]): Promise<Row[]>
  /**
   * Every statement, or none at all. A Recurring Task moves between states by
   * several writes that only make sense together — complete this occurrence
   * *and* open the next one — and the one-Open-occurrence invariant cannot
   * survive an interruption between them; see
   * docs/adr/0020-recurring-task-transitions-are-transactional.md.
   *
   * A list rather than a callback because the whole of a transition is decided
   * before any of it is written: what the next slot is, is calendar arithmetic
   * over rows already read, and the statements that write it carry their own
   * guards so a record that moved underneath them refuses rather than
   * overwrites.
   */
  transaction(statements: SqlStatement[]): Promise<void>
}

/**
 * The two ways a Note comes into existence, and there is no third — see
 * docs/adr/0010-notes-have-two-origins.md. `capture` is the user typing one;
 * `import` is a meeting swept off their calendar without being asked.
 */
export type NoteOrigin = 'capture' | 'import'

export interface Note {
  id: string
  /** A single line, never empty or whitespace-only. */
  body: string
  /**
   * Optional Project the Note is filed under. Null is Unfiled. Identity is
   * case-insensitive and stored lowercase.
   */
  project: string | null
  /** UTC ISO-8601. Provenance, not filing — never changes. */
  capturedAt: string
  /** `YYYY-MM-DD`. Decided at capture and never recomputed. */
  journalDay: string
  /** Null until the Note is changed after capture. */
  editedAt: string | null
  /**
   * Which of the two ways this Note came into existence. Ordinary in every
   * other respect: an Imported Note is edited, refiled and deleted like any
   * other, and only History renders it any differently.
   */
  origin: NoteOrigin
}

/**
 * A work commitment the user intends, or intended, to complete — a record
 * beside a Note rather than a kind of one: Notes recover work that happened,
 * Tasks hold work that remains or preserve that it was done. See
 * docs/adr/0014-tasks-are-first-class-work-commitments.md.
 *
 * A Task has no Project, no category and no relation to a Note. It is Open or
 * Completed, and editable in either state.
 */
export interface Task {
  id: string
  /**
   * The required single line that says what the Task is. Trimmed at the ends,
   * verbatim within — including whatever Unicode the user wrote, and including
   * words that look like a schedule, which nothing here interprets.
   */
  description: string
  /** UTC ISO-8601. The instant it came into existence, and never changes. */
  createdAt: string
  /**
   * When the commitment was completed, or null while it is Open. Reopening
   * clears it: that is the whole of what reopening is.
   */
  completedAt: string | null
  /**
   * `YYYY-MM-DD`, or null when the Task is Unscheduled. A local calendar date
   * rather than an instant — see
   * docs/adr/0021-task-schedules-are-stored-as-civil-time.md.
   */
  scheduledDate: string | null
  /**
   * `HH:mm`, or null for a date-only schedule. Never set without a date: the
   * date is the prerequisite, and a date alone never implies a default time.
   */
  scheduledTime: string | null
  /**
   * The cadence this Task repeats on, or null when it does not repeat — which
   * is every Task until somebody says otherwise. A Recurring Task is one Task
   * following a rule rather than a stream of cloned ones; see
   * docs/adr/0016-recurring-tasks-have-one-open-occurrence.md.
   */
  recurrence: Recurrence | null
  /**
   * `YYYY-MM-DD`: the starting date the series is counted from, or null when
   * the Task does not repeat. Distinct from `scheduledDate`, which is the one
   * Open Task Occurrence and moves with every completion — every-N weeks are
   * counted from the Monday-based week containing this date, and a monthly or
   * yearly cadence keeps this date's day of the month through shorter months
   * rather than drifting after a fallback.
   */
  recurrenceAnchor: string | null
}

/** The calendar units a cadence counts in, and there is no fifth. */
export type RecurrenceUnit = 'day' | 'week' | 'month' | 'year'

/**
 * A fixed civil-time cadence: a unit, how many of them apart, and — weekly
 * only — which days of the week are selected. It says nothing about when the
 * series starts or ends: the start is the Task's recurrence anchor, and there
 * is no end, because a recurrence runs until it is stopped.
 */
export interface Recurrence {
  unit: RecurrenceUnit
  /** Every N units. 1 is every one of them; never 0 and never negative. */
  interval: number
  /**
   * ISO weekdays — 1 is Monday, 7 is Sunday — ascending and without
   * duplicates. Non-empty for a weekly cadence and empty for every other,
   * which takes its day from the starting date.
   */
  weekdays: number[]
}

/**
 * One scheduled commitment within a Recurring Task. Exactly one is Open at any
 * moment; the rest are the Task's own history, which stays attached to it
 * rather than joining the ordinary Completed Tasks.
 */
export interface TaskOccurrence {
  id: string
  taskId: string
  /** The slot: civil time, exactly as a Task's own schedule is stored. */
  scheduledDate: string
  scheduledTime: string | null
  /** When this occurrence was completed, or null while it is the Open one. */
  completedAt: string | null
  createdAt: string
  /**
   * The occurrence whose completion produced this one, and null when nothing
   * did — a series just created, or one an edit reanchored. What makes Undo
   * Completion safe to offer: it is available exactly while the Open
   * occurrence still points back at the completion being undone.
   */
  advancedFrom: string | null
}

/**
 * Scheduled For as anything that sets one hands it over: a local calendar date,
 * and optionally a wall-clock time on it. Null everywhere one of these is
 * accepted means Unscheduled — clearing the date clears the time with it,
 * because a time without a day is not a schedule.
 */
export interface TaskSchedule {
  /** `YYYY-MM-DD`, in the user's own calendar. */
  date: string
  /** `HH:mm`, minute-precise, or null for a date-only schedule. */
  time: string | null
}

/** What a guarded completion did, and what the Task looks like afterwards. */
export type CompletionAtSlot =
  | { outcome: 'completed'; task: Task }
  | { outcome: 'stale'; task: Task | null }

/** Whether a Task is still a commitment, or a record that one was kept. */
export function isOpen(task: Task): boolean {
  return task.completedAt === null
}

/** Scheduled For as one value, or null when the Task is Unscheduled. */
export function scheduleOf(task: Task): TaskSchedule | null {
  return task.scheduledDate === null
    ? null
    : { date: task.scheduledDate, time: task.scheduledTime }
}

/** The slot an occurrence stands for, in the same shape a Task's own is. */
export function slotOf(occurrence: TaskOccurrence): TaskSchedule {
  return {
    date: occurrence.scheduledDate,
    time: occurrence.scheduledTime,
  }
}

/**
 * A slot written out plainly: the day, and the minute when there is one. The
 * one way the app spells a civil-time slot where it is not being read aloud —
 * an export bullet, an occurrence in a history — so a file and a screen never
 * disagree about what the record says.
 */
export function formatSlot(slot: TaskSchedule): string {
  return `${slot.date}${slot.time === null ? '' : ` ${slot.time}`}`
}

/**
 * When a Task is meant to be done and how often that comes round again, as one
 * value. The two travel together everywhere they are chosen or changed: the
 * date is what a cadence is counted from, so clearing it clears the cadence,
 * and a caller handed only one of them would have to work the other out.
 */
export interface TaskTiming {
  schedule: TaskSchedule | null
  recurrence: Recurrence | null
}

/** The one Open Task Occurrence, of however many a Task has had. */
export function openOccurrence(
  occurrences: TaskOccurrence[],
): TaskOccurrence | null {
  return occurrences.find((one) => one.completedAt === null) ?? null
}

/**
 * The Task's own history: the occurrences it has already kept, most recently
 * completed first. Never mixed into the ordinary Completed Tasks — a Recurring
 * Task is still Open, and what it kept belongs under it.
 */
export function completedOccurrences(
  occurrences: TaskOccurrence[],
): TaskOccurrence[] {
  return occurrences
    .filter((one) => one.completedAt !== null)
    .sort((one, other) => (one.completedAt! < other.completedAt! ? 1 : -1))
}

/**
 * Whether the latest completion can still be taken back. Only while the
 * occurrence it advanced to is the Open one and is still the one that
 * completion produced: an edit reanchors the series and replaces that
 * occurrence, and completing it again buries it, and either way undoing would
 * destroy a later decision rather than correct a mistaken tick.
 *
 * Asked of the occurrences rather than worked out again from the calendar,
 * because the record already says it: the Open occurrence points back at the
 * completion that produced it, and nothing else ever sets that.
 */
export function canUndoCompletion(occurrences: TaskOccurrence[]): boolean {
  const open = openOccurrence(occurrences)
  if (open === null || open.advancedFrom === null) return false

  return completedOccurrences(occurrences)[0]?.id === open.advancedFrom
}

/**
 * One event on the user's calendar, as the machine hands it over — see
 * `Desktop.todaysCalendarEvents`. Nothing here is a decision: which of these
 * become Notes is the core's, below.
 */
export interface CalendarEvent {
  /**
   * The event's identifier. Shared by every occurrence of a recurring event,
   * which is why it is not on its own the identity of a meeting.
   */
  id: string
  /** Which calendar it sits on — matched against the ticked ones. */
  calendarId: string
  /** The title, exactly as the calendar holds it. May be empty. */
  title: string
  /** Milliseconds since the epoch: a real instant, not a local label. */
  startsAt: number
  endsAt: number
  /** What the calendar itself says. Not the whole of the all-day rule. */
  isAllDay: boolean
  /** Whether the user's own attendance is Declined. */
  isDeclined: boolean
}

/**
 * The range of Journal Days currently being viewed, inclusive at both ends. A
 * single day is a range whose ends are equal. One of the Filter's two axes,
 * and the only one Presets, Search and Nudges ever move.
 */
export interface DayRange {
  /** `YYYY-MM-DD`, the oldest day in view. */
  from: string
  /** `YYYY-MM-DD`, the newest day in view. */
  to: string
}

/**
 * The Filter's other axis: one named Project, Unfiled, or no constraint at
 * all — see docs/adr/0008-project-narrows-filter.md.
 */
export type ProjectConstraint =
  | { kind: 'any' }
  | { kind: 'unfiled' }
  | { kind: 'named'; name: string }

/** No constraint: every Note in the day range, filed or not. */
export const ANY_PROJECT: ProjectConstraint = { kind: 'any' }

/** Only Notes with no Project — a real value, not the absence of one. */
export const UNFILED: ProjectConstraint = { kind: 'unfiled' }

/**
 * What is currently being viewed: a range of Journal Days and a Project
 * constraint. The two axes are independent and both must match for a Note to
 * appear. The constraint is optional in the type and absent means Any, so a
 * day range on its own is already a Filter.
 */
export interface Filter extends DayRange {
  project?: ProjectConstraint
}

/**
 * The Project axis of a Filter, whether or not it was written down: absent is
 * Any, so a bare day range narrows nothing.
 */
export function constraintOf(filter: Filter): ProjectConstraint {
  return filter.project ?? ANY_PROJECT
}

/**
 * A Filter rendered as Markdown, with the number of Notes that went into it —
 * the journal's only output, and the count the reader is told after copying so
 * they know it worked before they paste.
 */
export interface Digest {
  /** Plain Markdown: no app-specific formatting, nothing to clean up. */
  markdown: string
  /** Exactly the number of bullets in `markdown`. */
  noteCount: number
}

/**
 * The whole journal as one Markdown file, with what went into it. Notes and
 * Tasks are separate top-level sections, and both counts are reported: an
 * export of a journal holding only Tasks has to say so rather than read as an
 * export of nothing.
 */
export interface JournalExport {
  markdown: string
  noteCount: number
  taskCount: number
}

/** What a keystroke during a Capture means. */
export type KeystrokeDecision = 'commit' | 'discard' | 'ignore'

/**
 * What History does about a Note captured while it is on screen.
 * Either the Note belongs in what is on screen, or the day it was filed under
 * is worth mentioning — never a Filter that moved on its own.
 */
export type ArrivalDecision =
  | { kind: 'show' }
  | { kind: 'nudge'; journalDay: string }

export interface Journal {
  /**
   * Commits one Note, or nothing at all — a Capture never ends in a partial or
   * empty Note. A leading Project Marker is consumed into Project + Body.
   * Returns null when there was nothing to commit.
   */
  capture(text: string): Promise<Note | null>
  /**
   * Turns one meeting into a Note, or does nothing because that meeting has
   * been handled before — including by an Import the user has since deleted,
   * which is a refusal and is permanent. Returns null in that case.
   *
   * The Note is Unfiled, its Body is the event's title and its Captured At is
   * the instant the meeting began, so a meeting swept up in the evening still
   * sorts into the morning it happened in. Whether an event should be here at
   * all is `meetingsToImport`'s question, not this one's.
   */
  importMeeting(event: CalendarEvent): Promise<Note | null>
  /**
   * Rewords a Note, so the journal reads correctly later. Captured At is
   * untouched — provenance survives every correction — and the Note is marked
   * as edited, so a reader knows the wording may not be the original. Wording
   * that has not actually changed is not an edit.
   */
  editBody(id: string, body: string): Promise<Note>
  /**
   * Files a Note under a different Journal Day, moving it between Filters.
   * Captured At is untouched: refiling says where a thought belongs, never
   * when it was had.
   */
  refile(id: string, journalDay: string): Promise<Note>
  /**
   * Files a Note under a different Project, or clears it to Unfiled. Captured
   * At, Body and Journal Day are untouched — Project is filing, not wording.
   * Null is Unfiled. A name is stored lowercase; the same Project is not an
   * edit.
   */
  editProject(id: string, project: string | null): Promise<Note>
  /**
   * Changes one Project into another on every Note filed under it, in one
   * operation. Correcting a typo, or renaming a stream of work — the filing of
   * a whole stream is one decision, not one edit per Note. There is no
   * registry to update and no Body text to rewrite: Projects are values on
   * Notes, so the rename is the UPDATE, and the Notes are what carries it.
   *
   * Both names are normalized and validated by the same rules a single filing
   * obeys. A target with Notes of its own is merged into: the streams become
   * one, and no duplicate Project can outlive the operation. A target that is
   * the source after normalization does nothing and marks nothing edited.
   *
   * Every moved Note receives the same Edited At instant — the rename is one
   * decision about the stream, applied at one moment — and Captured At, Body
   * and Journal Day are untouched. A source with no Notes under it is refused:
   * a rename that moved nothing would report a correction the record never
   * made, and with no registry there is nothing left of the name to be true
   * about.
   */
  renameProject(from: string, to: string): Promise<void>
  /**
   * Removes a Note permanently. There is no trash, no archive and no
   * `deleted_at` — the row is gone, and with it every Filter and Digest it
   * appeared in.
   */
  delete(id: string): Promise<void>
  /**
   * The days a reader starts from: the most recent Occupied Day, which is the
   * greatest Journal Day present and not yesterday's date — so a Monday
   * resolves to Friday when the weekend is empty, however long the gap. Null
   * when there are no Notes at all, rather than an arbitrary date. Only the
   * day axis: History opens on Any, which is nothing to decide.
   */
  defaultRange(): Promise<DayRange | null>
  /**
   * The Notes in a Filter, newest first — the order someone reading back at
   * standup wants, and the reverse of a Digest's. Both axes are predicates:
   * a Note has to fall in the day range and satisfy the Project constraint.
   */
  notesForFilter(filter: Filter): Promise<Note[]>
  /**
   * A Search: the Notes anywhere in the journal whose Body contains the term,
   * newest first like a Filter's list. It takes a term rather than a Filter
   * because a Search is a way of moving the Filter and never of narrowing it —
   * see docs/adr/0004-search-moves-the-filter-rather-than-narrowing-it.md.
   *
   * Matching is a case-insensitive substring of the Body and nothing more: the
   * whole term is one substring, and no other column is looked at. The known
   * limit is non-ASCII case folding, which SQLite's `LIKE` does not do —
   * `MIGRAÇÃO` does not match `migração`.
   */
  notesMatching(term: string): Promise<Note[]>
  /**
   * The Filter as Markdown to paste elsewhere. Oldest first — the reverse of
   * what the list shows, because scanning wants recency and narrative wants
   * chronology.
   *
   * Under a single named Project the bullets are Body only: the Project is
   * already what the whole Digest is about. Under Any or Unfiled a Note that
   * has a Project keeps a `#name` prefix, so a mixed paste still says which
   * stream each line came from.
   */
  digest(filter: Filter): Promise<Digest>
  /**
   * The whole journal as Markdown — the way out of the SQLite file, so nothing
   * kept here is locked in. Notes sit under a heading for each day and Tasks
   * under Open and Completed, as two top-level sections: they are separate
   * records, and a file that mixed them would say they are not.
   *
   * The Notes half is rendered exactly as a Digest is, but it is not one: a
   * Digest is bound to the Filter on screen and an export ignores the Filter
   * entirely. It is never about one Project, so a Note with one always keeps
   * its `#name` prefix.
   */
  exportJournal(): Promise<JournalExport>
  /**
   * Commits one Task. The description is trimmed at its ends and otherwise
   * kept verbatim; an empty one is refused rather than stored, because a Task
   * that says nothing is not a commitment. Duplicates are ordinary — two days
   * can owe the same thing — so nothing is checked against what is already
   * there.
   */
  createTask(
    description: string,
    schedule?: TaskSchedule | null,
    recurrence?: Recurrence | null,
  ): Promise<Task>
  /**
   * The commitments that remain: the scheduled ones earliest Scheduled For
   * first, and the Unscheduled ones after them, newest created first. Which of
   * the four groups each one falls in is `groupOpenTasks`, asked of the same
   * list — the order here is already the order inside every group.
   */
  openTasks(): Promise<Task[]>
  /** The commitments that were kept, most recently completed first. */
  completedTasks(): Promise<Task[]>
  /**
   * A Search: the Tasks anywhere in the journal whose Task Description
   * contains the term, newest created first. It spans the Open and Completed
   * lists at once, because not knowing whether a Task is still open is most
   * of the reason for looking — see
   * docs/adr/0036-search-is-one-term-and-its-destination-is-what-changes.md.
   *
   * Matching is a case-insensitive substring of the Task Description and
   * nothing more: the whole term is one substring, and no other column is
   * looked at. The same escaped `LIKE` as `notesMatching`, and the same known
   * limit on non-ASCII case folding — `MIGRAÇÃO` does not match `migração`.
   */
  tasksMatching(term: string): Promise<Task[]>
  /**
   * Every Task Occurrence whose completion falls on a Journal Day in the
   * range, newest completion first, each paired with the Task it belongs to.
   * A Recurring Task is never completed by this — what it kept is its
   * occurrence's record, and the Task carries on asking for the next slot —
   * so a range read here never decides anything about the parent.
   */
  occurrencesKeptIn(range: DayRange): Promise<CompletedOccurrence[]>
  /**
   * Changes a Task: what it says, and when it is meant to be done. One
   * operation and one write, because the Task Editor commits both at once and
   * a save that half landed would leave the user unable to say which half.
   *
   * Task Created At is untouched, and so is the state. `schedule` is null for
   * Unscheduled, and a schedule whose time is null is date-only; a time is
   * never stored without a date, because clearing the date clears the time with
   * it. A date in the past is accepted exactly like any other — it is a real
   * commitment that was missed, and it becomes Overdue rather than being
   * refused or quietly moved.
   *
   * While a Task is Completed only its Task Description may change: a schedule
   * that differs from the one it was completed with is refused rather than
   * written, because reopening is what makes a schedule changeable again — and
   * reopening preserves the former one, which may make the Task Overdue the
   * moment it comes back.
   */
  editTask(
    id: string,
    change: {
      description: string
      schedule: TaskSchedule | null
      /**
       * The cadence the Task is left following. Omitted leaves whatever it
       * already has — clearing the date still stops it, because a cadence
       * with nothing to count from is not one.
       *
       * Changing the starting date, the selected weekdays, the cadence or the
       * time immediately reanchors the continuing series and replaces its
       * Open occurrence without recording a completion: its latest elapsed
       * slot becomes Overdue, or its next future slot becomes Upcoming. There
       * are no per-occurrence exceptions and no this-and-following edits — see
       * docs/adr/0016-recurring-tasks-have-one-open-occurrence.md.
       */
      recurrence?: Recurrence | null
    },
  ): Promise<Task>
  /**
   * Marks the commitment kept, recording when. Never asks first — completing
   * is reversible, and a confirmation on the most ordinary action in the app
   * would be in the way every single time.
   */
  completeTask(id: string): Promise<Task>
  /**
   * Completes a Task only if it still stands at the slot the caller was told
   * about — the guarded twin of `completeTask`, for an actor holding a copy of
   * a schedule that may have moved under it.
   */
  completeTaskAt(id: string, slot: TaskSchedule): Promise<CompletionAtSlot>
  /** Puts the commitment back: Task Completed At is removed, not kept. */
  reopenTask(id: string): Promise<Task>
  /**
   * Takes back the most recent completion of a Recurring Task: the occurrence
   * that completion advanced to is removed and the one before it becomes the
   * single Open occurrence again, atomically, so the invariant holds however
   * the machine is interrupted.
   *
   * Only while that successor is still Open and still the one that completion
   * produced. Older completions, and any whose successor was edited or
   * completed, stay historical: undoing them would either open two occurrences
   * at once or throw away a later decision. `canUndoCompletion` is the same
   * question asked without changing anything, which is what a screen offering
   * the action needs.
   */
  undoCompletion(id: string): Promise<Task>
  /**
   * Removes the recurrence rule while retaining the Task itself, exactly where
   * the series left it, and every completed Task Occurrence under it. There
   * are no one-occurrence exceptions: this is what stopping a series means.
   */
  stopRecurrence(id: string): Promise<Task>
  /**
   * One Recurring Task's Task Occurrences, newest slot first, the Open one
   * among them — the expandable history under the Task, and the record a
   * screen asks whether Undo Completion is still safe.
   */
  occurrencesOf(taskId: string): Promise<TaskOccurrence[]>
  /**
   * The same for a whole list at once, by Task — what a screen showing a list
   * needs, in one read rather than one per row. A Task with none is absent
   * rather than empty, which is most of them.
   *
   * Asked for every Task rather than only the repeating ones: Stop Recurrence
   * keeps the history under a Task that no longer has a cadence, and that
   * history is still the Task's to show.
   */
  occurrencesOfEach(taskIds: string[]): Promise<Record<string, TaskOccurrence[]>>
  /**
   * Removes a Task permanently, and with it every Task Occurrence it ever had.
   * There is no trash, no archive and no undo — which is why this one is the
   * only Task action that is confirmed, and why the confirmation says the
   * history goes too.
   */
  deleteTask(id: string): Promise<void>
  /**
   * Project names currently on Notes, matched by case-insensitive prefix.
   * Distinct and sorted — there is no registry, so a name with no remaining
   * Notes is gone. What Capture offers as Predictions while the user types
   * after `#`.
   */
  projectPredictions(prefix: string): Promise<string[]>
  /**
   * Every Project currently on a Note, sorted. The same absence of a registry
   * as Predictions — a name with nothing left under it is gone — but a
   * different question: what History can narrow the Filter to, asked with no
   * prefix and nobody typing.
   */
  projectsInUse(): Promise<string[]>
  /**
   * How many Captured Notes are filed under one Journal Day — what the tray
   * glyph carries, and the only reminder the app ever gives that a day has
   * nothing said about it.
   *
   * Captured Notes only: a count inflated by meetings would reassure precisely
   * on the days nothing was typed — see
   * docs/adr/0010-notes-have-two-origins.md. Every Note there is today comes
   * from a Capture, so the day is the whole predicate; when Import lands, the
   * origin narrows it here.
   */
  capturedNoteCount(journalDay: string): Promise<number>
}

interface NoteRow {
  id: string
  body: string
  project: string | null
  captured_at: string
  journal_day: string
  edited_at: string | null
  origin: string
}

/**
 * One kept slot of a Recurring Task, together with the Task it belongs to —
 * the Task Description travels with it, because a rendering of what was done
 * has to say what was done without a second read. The Task itself is not
 * marked completed by this pairing: a kept occurrence is the occurrence's
 * record, and the parent carries on.
 */
export interface CompletedOccurrence {
  task: Task
  occurrence: TaskOccurrence
}

interface TaskRow {
  id: string
  description: string
  created_at: string
  completed_at: string | null
  scheduled_date: string | null
  scheduled_time: string | null
  recurrence_unit: string | null
  recurrence_interval: number | null
  recurrence_weekdays: string | null
  recurrence_anchor_date: string | null
}

interface TaskOccurrenceRow {
  id: string
  task_id: string
  scheduled_date: string
  scheduled_time: string | null
  completed_at: string | null
  created_at: string
  advanced_from: string | null
}

/** The recurrence columns, in the order every Task statement writes them. */
const RECURRENCE_COLUMNS =
  'recurrence_unit, recurrence_interval, recurrence_weekdays, recurrence_anchor_date'

/** The same, aliased for the one join that reads a Task beside an occurrence. */
const RECURRENCE_COLUMNS_ALIASED = [
  't.recurrence_unit AS t_recurrence_unit',
  't.recurrence_interval AS t_recurrence_interval',
  't.recurrence_weekdays AS t_recurrence_weekdays',
  't.recurrence_anchor_date AS t_recurrence_anchor_date',
].join(', ')

const INSERT_TASK = `
  INSERT INTO tasks (
    id, description, created_at, completed_at, scheduled_date, scheduled_time,
    ${RECURRENCE_COLUMNS}
  )
  VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
`

/** Every read returns a whole Task; only the predicate and the order differ. */
const SELECT_TASKS = `
  SELECT
    id, description, created_at, completed_at, scheduled_date, scheduled_time,
    ${RECURRENCE_COLUMNS}
  FROM tasks
`

const SELECT_TASK = `
  ${SELECT_TASKS}
  WHERE id = ?
`

/**
 * The scheduled commitments first, earliest Scheduled For first, and the
 * Unscheduled ones after them newest created first. Two orders in one read
 * because they answer two different questions: a schedule is a place in the
 * future, and a Task without one has nothing but when it was written down.
 *
 * A date-only Task sorts before a timed one on the same date: the whole day is
 * as early as that day gets.
 */
const SELECT_OPEN_TASKS = `
  ${SELECT_TASKS}
  WHERE completed_at IS NULL
  ORDER BY
    scheduled_date IS NULL,
    scheduled_date ASC,
    scheduled_time IS NOT NULL,
    scheduled_time ASC,
    created_at DESC,
    id DESC
`

/** Most recently kept first — a different question, and a different order. */
const SELECT_COMPLETED_TASKS = `
  ${SELECT_TASKS}
  WHERE completed_at IS NOT NULL
  ORDER BY completed_at DESC, id DESC
`

/**
 * Both states together, newest created first: a Search spans the Open and
 * Completed lists, which have an order each, so neither survives it. The
 * Task Description is the only column looked at, with the same escaped `LIKE`
 * as `SELECT_NOTES_MATCHING` — see `escapeForLike`.
 */
const SELECT_TASKS_MATCHING = `
  ${SELECT_TASKS}
  WHERE description LIKE ? ESCAPE '\\'
  ORDER BY created_at DESC, id DESC
`

/** Oldest first, both states together: the order an export reads in. */
const SELECT_ALL_TASKS_FOR_EXPORT = `
  ${SELECT_TASKS}
  ORDER BY created_at ASC, id ASC
`

/**
 * What an edit may change, and the whole of it: the wording and both halves of
 * Scheduled For, in one statement. `created_at` is never in an UPDATE anywhere
 * in the app, and `completed_at` moves only through completing and reopening —
 * which are states, not edits.
 *
 * Both halves of the schedule move together, always: a time is never written
 * without a date, and clearing the date clears the time in the same statement
 * rather than leaving an orphan behind.
 */
const UPDATE_TASK = `
  UPDATE tasks
  SET description = ?, scheduled_date = ?, scheduled_time = ?
  WHERE id = ?
`

/**
 * An edit that reanchors a continuing series, or one that stops it: the
 * cadence and the starting date move with the schedule, in one statement,
 * because a rule whose anchor half landed would count from a date nobody
 * chose.
 */
const UPDATE_TASK_WITH_RECURRENCE = `
  UPDATE tasks
  SET
    description = ?,
    scheduled_date = ?,
    scheduled_time = ?,
    recurrence_unit = ?,
    recurrence_interval = ?,
    recurrence_weekdays = ?,
    recurrence_anchor_date = ?
  WHERE id = ?
`

/** Where the series now stands: the slot its one Open occurrence asks for. */
const UPDATE_TASK_SCHEDULE = `
  UPDATE tasks SET scheduled_date = ?, scheduled_time = ? WHERE id = ?
`

/**
 * The same, but only while the occurrence it is meant to follow really is the
 * Open one again. Undo removes a successor and reopens its predecessor, and a
 * head moved without them would point at a slot no occurrence holds.
 */
const UPDATE_TASK_SCHEDULE_IF_OPEN = `
  UPDATE tasks
  SET scheduled_date = ?, scheduled_time = ?
  WHERE id = ?
    AND EXISTS (
      SELECT 1 FROM task_occurrences
      WHERE id = ? AND completed_at IS NULL
    )
`

const UPDATE_TASK_COMPLETED_AT = `
  UPDATE tasks SET completed_at = ? WHERE id = ?
`

const DELETE_TASK = `
  DELETE FROM tasks WHERE id = ?
`

const INSERT_TASK_OCCURRENCE = `
  INSERT INTO task_occurrences (
    id, task_id, scheduled_date, scheduled_time, completed_at, created_at, advanced_from
  )
  VALUES (?, ?, ?, ?, NULL, ?, ?)
`

const SELECT_TASK_OCCURRENCES = `
  SELECT id, task_id, scheduled_date, scheduled_time, completed_at, created_at, advanced_from
  FROM task_occurrences
`

/**
 * Newest slot first, the Open occurrence among them. Ordered by the slot
 * rather than by completion, because that is the order the commitments were
 * made in and the order the history reads in.
 */
const OCCURRENCE_ORDER =
  'ORDER BY scheduled_date DESC, scheduled_time IS NULL, scheduled_time DESC, id DESC'

/** One Recurring Task's whole history. */
const SELECT_OCCURRENCES_OF_TASK = `
  ${SELECT_TASK_OCCURRENCES}
  WHERE task_id = ?
  ${OCCURRENCE_ORDER}
`

/**
 * The same, for a whole list of Tasks at once — the placeholders are built to
 * fit, because a list on screen is asked about in one read rather than one per
 * row. Same order within each Task, so a caller can group by `task_id` and
 * have each history already reading the way the screen shows it.
 */
function selectOccurrencesOfTasks(count: number): string {
  return `
    ${SELECT_TASK_OCCURRENCES}
    WHERE task_id IN (${Array(count).fill('?').join(', ')})
    ${OCCURRENCE_ORDER}
  `
}

/** Every completed occurrence in the journal, oldest first: export order. */
const SELECT_COMPLETED_OCCURRENCES_FOR_EXPORT = `
  ${SELECT_TASK_OCCURRENCES}
  WHERE completed_at IS NOT NULL
  ORDER BY scheduled_date ASC, scheduled_time IS NOT NULL, scheduled_time ASC, id ASC
`

/**
 * The completed occurrences of a day range, newest completion first — the
 * order a reader of what was kept yesterday wants. The predicate is on
 * `completed_at`, the same one `completedTasks()` asks; the range is a range
 * of Journal Days, so the bounds are the UTC instants of the range's own
 * local midnights — bound by the caller, below, because a Journal Day's
 * midnight is the local calendar's, not UTC's. The parent Task rides along
 * on the join: only the Task's columns are aliased, because `id` and the
 * recurrence columns are the ones the two tables name alike, and the
 * occurrence columns read as themselves straight into `toOccurrence`.
 */
const SELECT_COMPLETED_OCCURRENCES_IN_RANGE = `
  SELECT
    o.id,
    o.task_id,
    o.scheduled_date,
    o.scheduled_time,
    o.completed_at,
    o.created_at,
    o.advanced_from,
    t.id AS t_id,
    t.description AS t_description,
    t.created_at AS t_created_at,
    t.completed_at AS t_completed_at,
    t.scheduled_date AS t_scheduled_date,
    t.scheduled_time AS t_scheduled_time,
    ${RECURRENCE_COLUMNS_ALIASED}
  FROM task_occurrences o
  JOIN tasks t ON t.id = o.task_id
  WHERE o.completed_at IS NOT NULL
    AND o.completed_at >= ?
    AND o.completed_at < ?
  ORDER BY o.completed_at DESC, o.id DESC
`

/**
 * The joined row of the read above: the occurrence's own columns, plus the
 * Task's beside them under their aliases. Extends `TaskOccurrenceRow` so the
 * occurrence needs no remap — only the Task is lifted out by hand.
 */
interface CompletedOccurrenceRow extends TaskOccurrenceRow {
  t_id: string
  t_description: string
  t_created_at: string
  t_completed_at: string | null
  t_scheduled_date: string | null
  t_scheduled_time: string | null
  t_recurrence_unit: string | null
  t_recurrence_interval: number | null
  t_recurrence_weekdays: string | null
  t_recurrence_anchor_date: string | null
}

/**
 * Keeps the commitment this occurrence stands for, and only while it is still
 * the Open one: a second window that completed it first leaves this a no-op,
 * and the insert that follows then collides with the one-Open index and takes
 * the whole transaction down rather than opening a second occurrence.
 */
const COMPLETE_TASK_OCCURRENCE = `
  UPDATE task_occurrences
  SET completed_at = ?
  WHERE id = ? AND completed_at IS NULL
`

/**
 * Takes the successor away, and only while the completion being undone is
 * still on file — so a completion that has since been undone elsewhere does
 * not cost the user the occurrence they are looking at.
 */
const DELETE_ADVANCED_OCCURRENCE = `
  DELETE FROM task_occurrences
  WHERE id = ?
    AND completed_at IS NULL
    AND advanced_from = ?
    AND EXISTS (
      SELECT 1 FROM task_occurrences WHERE id = ? AND completed_at IS NOT NULL
    )
`

/**
 * Puts the mistaken tick back, and only into the room the delete above just
 * made: the one-Open invariant is the point of the whole transaction, so it is
 * asked for here as well as enforced by the index.
 */
const REOPEN_TASK_OCCURRENCE = `
  UPDATE task_occurrences
  SET completed_at = NULL
  WHERE id = ?
    AND completed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM task_occurrences WHERE task_id = ? AND completed_at IS NULL
    )
`

/** The Open occurrence of a series that is no longer one. History stays. */
const DELETE_OPEN_OCCURRENCE = `
  DELETE FROM task_occurrences WHERE task_id = ? AND completed_at IS NULL
`

/** Permanent deletion takes the whole history with it, in one transaction. */
const DELETE_OCCURRENCES_OF_TASK = `
  DELETE FROM task_occurrences WHERE task_id = ?
`

const INSERT_NOTE = `
  INSERT INTO notes (id, body, project, captured_at, journal_day, edited_at, origin)
  VALUES (?, ?, ?, ?, ?, NULL, ?)
`

/**
 * A meeting the sweep has handled. Written before the Note it becomes, and
 * never removed: the row outliving the Note is the whole point, since deleting
 * an Imported Note is how the user refuses its meeting for good.
 */
const INSERT_IMPORTED_MEETING = `
  INSERT INTO imported_meetings (event_key, handled_at)
  VALUES (?, ?)
`

/** Whether this occurrence has been swept before, whatever became of the Note. */
const SELECT_IMPORTED_MEETING = `
  SELECT event_key
  FROM imported_meetings
  WHERE event_key = ?
`

/** Every read returns a whole Note; only the predicate and the order differ. */
const SELECT_NOTES = `
  SELECT id, body, project, captured_at, journal_day, edited_at, origin
  FROM notes
`

const SELECT_NOTE = `
  ${SELECT_NOTES}
  WHERE id = ?
`

/**
 * Body, Journal Day and Project are the changeable columns, and each marks the
 * Note as edited; `captured_at` is never in an UPDATE anywhere in the app.
 */
const UPDATE_BODY = `
  UPDATE notes SET body = ?, edited_at = ? WHERE id = ?
`

const UPDATE_JOURNAL_DAY = `
  UPDATE notes SET journal_day = ?, edited_at = ? WHERE id = ?
`

const UPDATE_PROJECT = `
  UPDATE notes SET project = ?, edited_at = ? WHERE id = ?
`

/**
 * The whole of a Project rename: one statement, because the Project is a value
 * on the Note and not a row anywhere else. There is no registry to update and
 * no Body text to rewrite — see docs/adr/0007-project-is-first-class-filing.md
 * — so renaming a stream is this, and merging two streams is this too: every
 * Note under the source is filed under the target, and nothing distinguishes
 * a merged Note from a filed one afterwards.
 */
const UPDATE_PROJECT_EVERYWHERE = `
  UPDATE notes SET project = ?, edited_at = ? WHERE project = ?
`

const DELETE_NOTE = `
  DELETE FROM notes WHERE id = ?
`

const SELECT_MOST_RECENT_OCCUPIED_DAY = `
  SELECT journal_day
  FROM notes
  ORDER BY journal_day DESC
  LIMIT 1
`

/** Reverse chronological: the order a reader scanning back wants. */
const IN_LIST_ORDER = `ORDER BY journal_day DESC, captured_at DESC, id DESC`

/** Chronological: the order Markdown reads in, whatever is being rendered. */
const IN_DIGEST_ORDER = `ORDER BY journal_day ASC, captured_at ASC, id ASC`

/**
 * Both axes of a Filter as one read: the day range, the Project constraint,
 * and whichever order the caller reads in. The list and the Digest are the
 * same rows reversed, so they are the same predicate too.
 */
function selectNotesForFilter(filter: Filter, order: string): Query {
  const project = projectPredicate(filter)
  return {
    sql: `
      ${SELECT_NOTES}
      WHERE journal_day BETWEEN ? AND ?${project.sql}
      ${order}
    `,
    params: [filter.from, filter.to, ...project.params],
  }
}

/** A statement and the parameters that go with it, kept together. */
interface Query {
  sql: string
  params: unknown[]
}

/**
 * The Project axis as SQL. Any adds nothing at all — the Filter is then the
 * day range and nothing else — and the other two are a single predicate, so
 * both axes are one read rather than a list filtered afterwards.
 */
function projectPredicate(filter: Filter): Query {
  const constraint = constraintOf(filter)

  switch (constraint.kind) {
    case 'any':
      return { sql: '', params: [] }
    case 'unfiled':
      return { sql: ' AND project IS NULL', params: [] }
    case 'named':
      // Identity is case-insensitive and every Project is stored lowercase, so
      // a normalized name is an equality test — and a name that is not one at
      // all fails here rather than quietly matching nothing.
      return { sql: ' AND project = ?', params: [projectName(constraint.name)] }
  }
}

/**
 * The same order as a Filter's list, over the whole journal and predicated on
 * the Body instead. `LIKE` is case-insensitive for ASCII in SQLite, which is
 * the whole of the matching rule; the escape character is named so that a term
 * containing `%` or `_` reads as those characters rather than as a pattern.
 */
const SELECT_NOTES_MATCHING = `
  ${SELECT_NOTES}
  WHERE body LIKE ? ESCAPE '\\'
  ${IN_LIST_ORDER}
`

/** The same rows again with no predicate at all: the whole journal. */
const SELECT_ALL_NOTES_FOR_EXPORT = `
  ${SELECT_NOTES}
  ${IN_DIGEST_ORDER}
`

/**
 * The Captured Notes on one Journal Day, counted rather than read: the tray
 * wants a number, and a day's rows are not worth carrying across the seam to
 * take the length of.
 */
const COUNT_CAPTURED_NOTES_ON_DAY = `
  SELECT COUNT(*) AS count
  FROM notes
  WHERE journal_day = ?
    AND origin = 'capture'
`

/** Every Project still on a Note: the Filter's Project axis, enumerated. */
const SELECT_PROJECTS_IN_USE = `
  SELECT DISTINCT project
  FROM notes
  WHERE project IS NOT NULL
  ORDER BY project ASC
`

/**
 * Whether a Project still has Notes under it, counted rather than read: a
 * rename refuses a source that has none, so a caller never reports a rename
 * that moved nothing — and with no registry, the Notes are the only place the
 * answer lives.
 */
const COUNT_NOTES_UNDER_PROJECT = `
  SELECT COUNT(*) AS count
  FROM notes
  WHERE project = ?
`

/**
 * Distinct Projects still on Notes. Prefix is matched case-insensitively;
 * Projects are already stored lowercase, so the LIKE is enough. Sorted so the
 * list is stable for Capture Predictions.
 */
const SELECT_PROJECT_PREDICTIONS = `
  SELECT DISTINCT project
  FROM notes
  WHERE project IS NOT NULL
    AND project LIKE ? ESCAPE '\\'
  ORDER BY project ASC
`

export function createJournal({
  clock,
  driver,
}: {
  clock: Clock
  driver: SqlDriver
}): Journal {
  /**
   * Keeping an Open Task, whichever kind it is — the one place completion is
   * spelled out, so the checkbox in Tasks View and a guarded completion from
   * somewhere the user cannot see both keep the same transactional promises.
   * The caller has already established that the Task is Open.
   */
  async function completeOpen(task: Task): Promise<Task> {
    const now = clock.now()

    if (task.recurrence === null || task.recurrenceAnchor === null) {
      const completedAt = now.toISOString()
      await driver.execute(UPDATE_TASK_COMPLETED_AT, [completedAt, task.id])
      return { ...task, completedAt }
    }

    // A Recurring Task is never itself Completed: the occurrence is kept,
    // stays in the Task's own history, and the Task carries on asking for
    // the next slot that is still ahead.
    const open = await readOpenOccurrence(driver, task.id)
    const next = advancedSlot(
      task.recurrenceAnchor,
      task.recurrence,
      open.scheduledTime,
      open.scheduledDate,
      now,
    )
    const advanced: Task = {
      ...task,
      scheduledDate: next,
      scheduledTime: open.scheduledTime,
    }

    await driver.transaction([
      { sql: COMPLETE_TASK_OCCURRENCE, params: [now.toISOString(), open.id] },
      opensOccurrence(advanced, now, open.id),
      {
        sql: UPDATE_TASK_SCHEDULE,
        params: [next, open.scheduledTime, task.id],
      },
    ])

    return advanced
  }

  return {
    async capture(text) {
      assertOneLine(text)

      const parsed = parseCapture(text)
      if (parsed === null) {
        return null
      }

      const capturedAt = clock.now()
      const note: Note = {
        id: crypto.randomUUID(),
        body: parsed.body,
        project: parsed.project,
        capturedAt: capturedAt.toISOString(),
        // Decided once, at capture, from the local calendar day of Captured At.
        // Never recomputed — see docs/adr/0005-no-day-start.md.
        journalDay: journalDayFor(capturedAt),
        editedAt: null,
        origin: 'capture',
      }

      await driver.execute(INSERT_NOTE, [
        note.id,
        note.body,
        note.project,
        note.capturedAt,
        note.journalDay,
        note.origin,
      ])

      return note
    },

    async importMeeting(event) {
      const key = meetingKey(event)
      const [handled] = await driver.select<{ event_key: string }>(
        SELECT_IMPORTED_MEETING,
        [key],
      )
      if (handled !== undefined) {
        return null
      }

      const began = new Date(event.startsAt)
      const note: Note = {
        id: crypto.randomUUID(),
        body: meetingBody(event.title),
        // Always Unfiled: the calendars carry no Project meaning, so there is
        // nothing to derive — see docs/adr/0010-notes-have-two-origins.md.
        project: null,
        // The instant the meeting began, not the instant it was stored.
        capturedAt: began.toISOString(),
        journalDay: journalDayFor(began),
        editedAt: null,
        origin: 'import',
      }

      // Handled first, and deliberately: an interruption between the two writes
      // loses one meeting, where the other order would resurrect a Note the
      // user may have already deleted. A missed meeting is a gap; a resurrected
      // one is the app overruling the user.
      await driver.execute(INSERT_IMPORTED_MEETING, [
        key,
        clock.now().toISOString(),
      ])
      await driver.execute(INSERT_NOTE, [
        note.id,
        note.body,
        note.project,
        note.capturedAt,
        note.journalDay,
        note.origin,
      ])

      return note
    },

    async editBody(id, body) {
      assertOneLine(body)

      if (isBlank(body)) {
        throw new Error('A Body cannot be empty: delete the Note instead.')
      }

      const note = await read(driver, id)
      const reworded = body.trim()

      if (reworded === note.body) {
        return note
      }

      const editedAt = clock.now().toISOString()
      await driver.execute(UPDATE_BODY, [reworded, editedAt, id])

      return { ...note, body: reworded, editedAt }
    },

    async refile(id, journalDay) {
      if (!isJournalDay(journalDay)) {
        throw new Error(`Not a Journal Day: ${journalDay}.`)
      }

      const note = await read(driver, id)

      if (journalDay === note.journalDay) {
        return note
      }

      const editedAt = clock.now().toISOString()
      await driver.execute(UPDATE_JOURNAL_DAY, [journalDay, editedAt, id])

      return { ...note, journalDay, editedAt }
    },

    async editProject(id, project) {
      const next = normalizeProject(project)
      const note = await read(driver, id)

      if (next === note.project) {
        return note
      }

      const editedAt = clock.now().toISOString()
      await driver.execute(UPDATE_PROJECT, [next, editedAt, id])

      return { ...note, project: next, editedAt }
    },

    async renameProject(from, to) {
      // Both names are asked of the same rule a single filing obeys, and the
      // target first: refusing a nonsense name before reading anything keeps
      // the journal exactly as it was.
      const target = projectName(to)
      const source = projectName(from)

      // The same Project, however it was spelled: a rename to itself moves no
      // Note and marks none edited, like filing a Note under its own Project.
      if (target === source) return

      const [row] = await driver.select<{ count: number }>(
        COUNT_NOTES_UNDER_PROJECT,
        [source],
      )
      if (row === undefined || row.count === 0) {
        throw new Error(`No Notes are filed under ${formatProject(source)}.`)
      }

      const editedAt = clock.now().toISOString()
      await driver.execute(UPDATE_PROJECT_EVERYWHERE, [target, editedAt, source])
    },

    async delete(id) {
      await read(driver, id)
      await driver.execute(DELETE_NOTE, [id])
    },

    async defaultRange() {
      const [row] = await driver.select<{ journal_day: string }>(
        SELECT_MOST_RECENT_OCCUPIED_DAY,
        [],
      )

      if (row === undefined) {
        return null
      }

      return rangeForJournalDay(row.journal_day)
    },

    async notesForFilter(filter) {
      const query = selectNotesForFilter(filter, IN_LIST_ORDER)
      const rows = await driver.select<NoteRow>(query.sql, query.params)
      return rows.map(toNote)
    },

    async notesMatching(term) {
      const rows = await driver.select<NoteRow>(SELECT_NOTES_MATCHING, [
        `%${escapeForLike(term)}%`,
      ])
      return rows.map(toNote)
    },

    async digest(filter) {
      const query = selectNotesForFilter(filter, IN_DIGEST_ORDER)
      const rows = await driver.select<NoteRow>(query.sql, query.params)
      return renderDigest(rows.map(toNote), {
        // A single day is the common case and pastes without ceremony; any
        // wider Filter says which day each bullet belongs to.
        headings: filter.from !== filter.to,
        // Under one named Project every bullet would carry the same prefix,
        // which says nothing the reader does not already know.
        projectPrefixes: constraintOf(filter).kind !== 'named',
      })
    },

    async exportJournal() {
      const [noteRows, taskRows, occurrenceRows] = await Promise.all([
        driver.select<NoteRow>(SELECT_ALL_NOTES_FOR_EXPORT, []),
        driver.select<TaskRow>(SELECT_ALL_TASKS_FOR_EXPORT, []),
        driver.select<TaskOccurrenceRow>(
          SELECT_COMPLETED_OCCURRENCES_FOR_EXPORT,
          [],
        ),
      ])
      // An export always spans whatever the journal holds, so every day is
      // named — a file with unlabelled bullets is not a journal — and it is
      // never about one Project, so filing is written on the bullet.
      const notes = renderDigest(noteRows.map(toNote), {
        headings: true,
        projectPrefixes: true,
      })

      return renderExport(
        notes,
        taskRows.map(toTask),
        occurrenceRows.map(toOccurrence),
      )
    },

    async createTask(description, schedule = null, recurrence = null) {
      const said = taskDescription(description)
      const scheduled = taskSchedule(schedule)
      const cadence = taskRecurrence(recurrence, scheduled)
      const now = clock.now()
      // A cadence is counted from the date the user chose, which is not
      // necessarily the slot the series opens on: one started in the past
      // opens Overdue on its latest elapsed slot rather than on all of them.
      const anchor = cadence === null ? null : scheduled!.date
      const opening =
        cadence === null
          ? scheduled?.date ?? null
          : openingSlot(anchor!, cadence, scheduled!.time, now)

      const task: Task = {
        id: crypto.randomUUID(),
        description: said,
        createdAt: now.toISOString(),
        completedAt: null,
        scheduledDate: opening,
        scheduledTime: scheduled?.time ?? null,
        recurrence: cadence,
        recurrenceAnchor: anchor,
      }

      const stored: SqlStatement = {
        sql: INSERT_TASK,
        params: [
          task.id,
          task.description,
          task.createdAt,
          task.scheduledDate,
          task.scheduledTime,
          ...recurrenceParams(cadence, anchor),
        ],
      }

      if (cadence === null) {
        await driver.execute(stored.sql, stored.params)
        return task
      }

      // The Task and its one Open occurrence come into existence together: a
      // Recurring Task with no occurrence would be a series asking for
      // nothing.
      await driver.transaction([stored, opensOccurrence(task, now, null)])

      return task
    },

    async openTasks() {
      const rows = await driver.select<TaskRow>(SELECT_OPEN_TASKS, [])
      return rows.map(toTask)
    },

    async completedTasks() {
      const rows = await driver.select<TaskRow>(SELECT_COMPLETED_TASKS, [])
      return rows.map(toTask)
    },

    async tasksMatching(term) {
      const rows = await driver.select<TaskRow>(SELECT_TASKS_MATCHING, [
        `%${escapeForLike(term)}%`,
      ])
      return rows.map(toTask)
    },

    async occurrencesKeptIn(range) {
      // The range's ends are Journal Days — local calendar days — so the
      // bounds must be the UTC instants of their local midnights. A string
      // bound would be a UTC midnight, and west of UTC every evening
      // completion would fall on the next UTC day and out of "yesterday"
      // entirely — while an ordinary Task completed at the same instant,
      // narrowed locally, stayed in it. The start of a day is the instant a
      // date-only Scheduled For stands for, so `scheduledInstant` is the one
      // place the awkward midnights are decided in.
      const from = scheduledInstant({
        date: range.from,
        time: null,
      }).toISOString()
      const to = scheduledInstant({
        date: shiftDay(range.to, 1),
        time: null,
      }).toISOString()
      const rows = await driver.select<CompletedOccurrenceRow>(
        SELECT_COMPLETED_OCCURRENCES_IN_RANGE,
        [from, to],
      )

      return rows.map((row) => ({
        task: toTask({
          id: row.t_id,
          description: row.t_description,
          created_at: row.t_created_at,
          completed_at: row.t_completed_at,
          scheduled_date: row.t_scheduled_date,
          scheduled_time: row.t_scheduled_time,
          recurrence_unit: row.t_recurrence_unit,
          recurrence_interval: row.t_recurrence_interval,
          recurrence_weekdays: row.t_recurrence_weekdays,
          recurrence_anchor_date: row.t_recurrence_anchor_date,
        }),
        occurrence: toOccurrence(row),
      }))
    },

    async editTask(id, { description, schedule, recurrence }) {
      const said = taskDescription(description)
      const scheduled = taskSchedule(schedule)
      const task = await readTask(driver, id)

      const date = scheduled?.date ?? null
      const time = scheduled?.time ?? null

      // A Completed Task keeps the schedule it was completed with. Reopening
      // is the way back to changing it, and it is a decision the user makes
      // rather than one an edit makes quietly on their behalf.
      if (
        !isOpen(task) &&
        (date !== task.scheduledDate || time !== task.scheduledTime)
      ) {
        throw new Error(
          'A Completed Task keeps its Scheduled For: reopen it to change one.',
        )
      }

      // The cadence this edit leaves behind: the one it was handed, the one
      // the Task already had when it was not asked about, and none at all
      // once the date it would be counted from is gone.
      const asked = recurrence === undefined ? task.recurrence : recurrence
      const cadence = scheduled === null ? null : taskRecurrence(asked, scheduled)

      if (!isOpen(task) && !sameRecurrence(task.recurrence, cadence)) {
        throw new Error(
          'A Completed Task keeps its recurrence: reopen it to change one.',
        )
      }

      if (cadence === null) {
        // Nothing to stop, so this is the ordinary edit it has always been.
        if (task.recurrence === null) {
          await driver.execute(UPDATE_TASK, [said, date, time, id])
          return {
            ...task,
            description: said,
            scheduledDate: date,
            scheduledTime: time,
          }
        }

        return stopRecurring(driver, task, {
          description: said,
          date,
          time,
        })
      }

      // What this edit actually changed about when the Task comes round. The
      // three are asked once and answered twice below, because whether the
      // series moves and what it is counted from afterwards are the same
      // question read two ways.
      const ruleChanged = !sameRecurrence(task.recurrence, cadence)
      const dateChanged = date !== task.scheduledDate
      const timeChanged = time !== task.scheduledTime

      // Rewording alone leaves the series exactly where it stands, because
      // what a Task says is not part of when it repeats.
      if (!ruleChanged && !dateChanged && !timeChanged) {
        await driver.execute(UPDATE_TASK, [said, date, time, id])
        return { ...task, description: said }
      }

      const now = clock.now()
      // Changing only the time keeps the date the series is counted from,
      // rather than adopting whatever slot it currently stands on: a monthly
      // Task started on the 31st has to come back to the 31st after February,
      // and re-anchoring it onto that fallback would silently lose the day the
      // user actually chose. Any change to the date or the cadence itself is
      // counted from the date on screen, which is what the user is looking at
      // while they make it.
      const anchor =
        !ruleChanged && !dateChanged && task.recurrenceAnchor !== null
          ? task.recurrenceAnchor
          : scheduled!.date
      // An edit never reopens a slot the series has kept: the head is floored
      // at the first slot strictly after the newest kept occurrence, for every
      // schedule edit rather than only a change of time — see
      // docs/adr/0037-an-edit-never-reopens-a-slot-the-series-has-kept.md. The
      // head is the later of that floor and `resumedSlot`, which prefers
      // today's slot whenever the time just typed is still ahead: retiming to
      // an earlier time that has already passed today keeps today Overdue
      // rather than skipping it, while a long-overdue series still collapses
      // forward to today. The floor is against kept occurrences only, never
      // against the current Open one, so an overdue series with nothing
      // completed may still collapse forward.
      const occurrences = await readOccurrences(driver, id)
      let newestKept: string | null = null
      for (const occurrence of occurrences) {
        if (
          occurrence.completedAt !== null &&
          (newestKept === null || occurrence.scheduledDate > newestKept)
        ) {
          newestKept = occurrence.scheduledDate
        }
      }
      const resumed = resumedSlot(anchor, cadence, time, now)
      let opening = resumed
      if (newestKept !== null) {
        const floor = slotDate(
          anchor,
          cadence,
          (slotIndexOnOrBefore(anchor, cadence, newestKept) ?? -1) + 1,
        )
        if (floor > opening) opening = floor
      }
      const reanchored: Task = {
        ...task,
        description: said,
        scheduledDate: opening,
        scheduledTime: time,
        recurrence: cadence,
        recurrenceAnchor: anchor,
      }

      // Replaced rather than completed: an edit is not a commitment kept, so
      // nothing goes into the history and the rule and its one Open
      // occurrence move together or not at all.
      await driver.transaction([
        {
          sql: UPDATE_TASK_WITH_RECURRENCE,
          params: [
            said,
            opening,
            time,
            ...recurrenceParams(cadence, anchor),
            id,
          ],
        },
        { sql: DELETE_OPEN_OCCURRENCE, params: [id] },
        opensOccurrence(reanchored, now, null),
      ])

      return reanchored
    },

    async completeTask(id) {
      const task = await readTask(driver, id)

      // Completing what is already completed must not move the instant it was
      // completed at: the Completed list is ordered by it.
      if (!isOpen(task)) {
        return task
      }

      return completeOpen(task)
    },


    async completeTaskAt(id, slot) {
      // A deleted Task is stale rather than a failure: the caller is holding a
      // copy of something the user was entitled to throw away.
      const task = await findTask(driver, id)

      if (task === null) {
        return { outcome: 'stale', task: null }
      }

      const held = scheduleOf(task)

      if (
        !isOpen(task) ||
        held === null ||
        held.date !== slot.date ||
        held.time !== slot.time
      ) {
        return { outcome: 'stale', task }
      }

      return { outcome: 'completed', task: await completeOpen(task) }
    },

    async reopenTask(id) {
      const task = await readTask(driver, id)

      if (isOpen(task)) {
        return task
      }

      await driver.execute(UPDATE_TASK_COMPLETED_AT, [null, id])

      return { ...task, completedAt: null }
    },

    async undoCompletion(id) {
      const task = await readTask(driver, id)
      const occurrences = await readOccurrences(driver, id)

      if (!canUndoCompletion(occurrences)) {
        throw new Error(
          'Only the latest completion can be undone, and only while what it advanced to is untouched.',
        )
      }

      const successor = openOccurrence(occurrences)!
      const restored = completedOccurrences(occurrences)[0]

      // Removed before reopened, and never the other way round: the one-Open
      // index would refuse the moment in between, and a transaction that
      // cannot hold its own middle is not one.
      await driver.transaction([
        {
          sql: DELETE_ADVANCED_OCCURRENCE,
          params: [successor.id, restored.id, restored.id],
        },
        { sql: REOPEN_TASK_OCCURRENCE, params: [restored.id, id] },
        {
          sql: UPDATE_TASK_SCHEDULE_IF_OPEN,
          params: [
            restored.scheduledDate,
            restored.scheduledTime,
            id,
            restored.id,
          ],
        },
      ])

      // The statements guard themselves against a record that moved while
      // this was being decided, which means they can all decline. Saying so is
      // better than reporting an undo that did not happen.
      const after = await readOccurrences(driver, id)
      if (openOccurrence(after)?.id !== restored.id) {
        throw new Error('That completion could no longer be undone.')
      }

      return {
        ...task,
        scheduledDate: restored.scheduledDate,
        scheduledTime: restored.scheduledTime,
      }
    },

    async stopRecurrence(id) {
      const task = await readTask(driver, id)

      if (task.recurrence === null) {
        return task
      }

      return stopRecurring(driver, task, {
        description: task.description,
        date: task.scheduledDate,
        time: task.scheduledTime,
      })
    },

    async occurrencesOf(taskId) {
      return readOccurrences(driver, taskId)
    },

    async occurrencesOfEach(taskIds) {
      // No Tasks is no read at all: an `IN ()` is not a query.
      if (taskIds.length === 0) return {}

      const rows = await driver.select<TaskOccurrenceRow>(
        selectOccurrencesOfTasks(taskIds.length),
        taskIds,
      )

      return Object.fromEntries(byTask(rows.map(toOccurrence)))
    },

    async deleteTask(id) {
      await readTask(driver, id)
      // The history goes with the Task, in one transaction: an occurrence left
      // behind would belong to nothing.
      await driver.transaction([
        { sql: DELETE_OCCURRENCES_OF_TASK, params: [id] },
        { sql: DELETE_TASK, params: [id] },
      ])
    },

    async projectPredictions(prefix) {
      const rows = await driver.select<{ project: string }>(
        SELECT_PROJECT_PREDICTIONS,
        [`${escapeForLike(prefix.toLowerCase())}%`],
      )
      return rows.map((row) => row.project)
    },

    async projectsInUse() {
      const rows = await driver.select<{ project: string }>(
        SELECT_PROJECTS_IN_USE,
        [],
      )
      return rows.map((row) => row.project)
    },

    async capturedNoteCount(journalDay) {
      const [row] = await driver.select<{ count: number }>(
        COUNT_CAPTURED_NOTES_ON_DAY,
        [journalDay],
      )
      return row?.count ?? 0
    },
  }
}

/**
 * Notes as Markdown, oldest first, one bullet each and no timestamps — a
 * Digest is meant to paste into a standup thread or an LLM prompt with no
 * cleanup, so it carries nothing the app knows and the reader does not need.
 *
 * Headings and Project prefixes are the caller's decision rather than the
 * Notes': what is being rendered decides whether a bullet needs to say which
 * day it belongs to, and whether the reader already knows which Project it
 * came from. Days with no Notes are simply absent either way.
 *
 * `notes` must already be in Digest order, which is what the core's read does.
 */
function renderDigest(
  notes: Note[],
  { headings, projectPrefixes }: { headings: boolean; projectPrefixes: boolean },
): Digest {
  const days = groupByJournalDay(notes)

  const markdown = days
    .map((day) => {
      const bullets = day.notes
        .map((note) => `- ${bulletPrefix(note, projectPrefixes)}${note.body}`)
        .join('\n')
      return headings
        ? `## ${formatDigestDay(day.journalDay)}\n${bullets}`
        : bullets
    })
    .join('\n\n')

  return { markdown, noteCount: notes.length }
}

/**
 * The whole journal as one file: the Notes already rendered, and the Tasks
 * under Open and Completed beside them. Two top-level sections, because a Note
 * and a Task are separate records and a file that ran them together would say
 * they are not.
 *
 * A section with nothing in it is left out entirely rather than written as an
 * empty heading, so a journal of Tasks alone exports as Tasks rather than as
 * Notes that are not there — and an empty journal exports as nothing at all.
 *
 * `tasks` must be in export order: oldest first, both states together.
 */
function renderExport(
  notes: Digest,
  tasks: Task[],
  occurrences: TaskOccurrence[],
): JournalExport {
  const open = tasks.filter(isOpen)
  const completed = tasks.filter((task) => !isOpen(task))
  const history = byTask(occurrences)
  const bullet = (task: Task) => taskBullet(task, history.get(task.id) ?? [])

  const sections: string[] = []

  if (notes.noteCount > 0) {
    sections.push(`# Notes\n\n${notes.markdown}`)
  }

  if (tasks.length > 0) {
    const parts: string[] = ['# Tasks']
    if (open.length > 0) {
      parts.push(`## Open\n${open.map(bullet).join('\n')}`)
    }
    if (completed.length > 0) {
      parts.push(`## Completed\n${completed.map(bullet).join('\n')}`)
    }
    sections.push(parts.join('\n\n'))
  }

  return {
    markdown: sections.join('\n\n'),
    noteCount: notes.noteCount,
    taskCount: tasks.length,
  }
}

/**
 * One Task as Markdown reads a commitment: a checkbox saying which state it is
 * in, the description as written, and whatever else the journal knows about it
 * — when it is meant to be done, and when it was. Absent metadata is omitted
 * rather than written as a blank, so a line says nothing the journal does not
 * know, and an Unscheduled Task exports exactly as it always did.
 *
 * Scheduled For is written as the civil time it is stored as rather than as an
 * instant: it is a day and a minute in the user's own calendar, and an export
 * that resolved it to a moment would say something the record does not.
 */
function taskBullet(task: Task, history: TaskOccurrence[]): string {
  const metadata: string[] = []
  const schedule = scheduleOf(task)

  if (schedule !== null) {
    metadata.push(`scheduled ${formatSlot(schedule)}`)
  }
  if (task.recurrence !== null) {
    metadata.push(`repeats ${formatRecurrence(task.recurrence)}`)
  }
  if (task.completedAt !== null) {
    metadata.push(`completed ${formatExportInstant(task.completedAt)}`)
  }

  const said = metadata.length > 0 ? ` (${metadata.join('; ')})` : ''
  const bullet = `- [${task.completedAt === null ? ' ' : 'x'}] ${task.description}${said}`

  if (history.length === 0) return bullet

  // Nested under the Task rather than beside it: a Task Occurrence is one
  // commitment within a Recurring Task, and a file that gave it a bullet of
  // its own would read as a second Task the user never wrote.
  return [bullet, ...history.map(occurrenceBullet)].join('\n')
}

/** One kept occurrence: the slot it stood for, and when it was kept. */
function occurrenceBullet(occurrence: TaskOccurrence): string {
  return `  - occurrence ${formatSlot(slotOf(occurrence))} (completed ${formatExportInstant(occurrence.completedAt!)})`
}

/**
 * Occurrences gathered under the Task each belongs to, keeping whatever order
 * they arrived in. A Task with none is absent rather than empty.
 */
function byTask(
  occurrences: TaskOccurrence[],
): Map<string, TaskOccurrence[]> {
  const history = new Map<string, TaskOccurrence[]>()

  for (const occurrence of occurrences) {
    const kept = history.get(occurrence.taskId)
    if (kept === undefined) {
      history.set(occurrence.taskId, [occurrence])
    } else {
      kept.push(occurrence)
    }
  }

  return history
}

/**
 * An instant as an export writes it: the day the way a Digest heading spells
 * one, and the local time of day after it. Both, because Task Completed At is
 * an instant rather than a day — an export that kept only the date would be
 * lossier than the record it is a copy of. Pinned to `en-GB` and to 24 hours
 * for the same reason `formatDigestDay` is: a file whose shape depends on the
 * machine that produced it is worse than one that is merely British.
 */
function formatExportInstant(instant: string): string {
  const at = new Date(instant)
  const time = [
    String(at.getHours()).padStart(2, '0'),
    String(at.getMinutes()).padStart(2, '0'),
  ].join(':')

  return `${formatDigestDay(journalDayFor(at))}, ${time}`
}

/**
 * What a bullet says before the Body: `#name ` when the Note has a Project and
 * the rendering is not already about one, and nothing otherwise. An Unfiled
 * Note is never labelled — a bullet with no marker is one nobody filed.
 */
function bulletPrefix(note: Note, projectPrefixes: boolean): string {
  return projectPrefixes && note.project !== null ? `#${note.project} ` : ''
}

/**
 * What a copied Digest is worth saying back: how many Notes went to the
 * clipboard, so the reader knows it worked before they paste. An empty Filter
 * says so rather than claiming a copy that carried nothing.
 */
export function describeCopiedDigest(digest: Digest): string {
  if (digest.noteCount === 0) {
    return 'No notes to copy.'
  }
  return `Copied ${plural(digest.noteCount, 'note')}.`
}

/**
 * What an export is worth saying back: both counts and where the file went. A
 * journal holding only Tasks says so, rather than reporting no Notes and
 * reading as an export that carried nothing.
 */
export function describeExport(
  exported: JournalExport,
  path: string,
): string {
  const { noteCount, taskCount } = exported

  if (noteCount === 0 && taskCount === 0) {
    return `Exported an empty journal to ${path}.`
  }

  const counted = [
    noteCount > 0 ? plural(noteCount, 'Note') : null,
    taskCount > 0 ? plural(taskCount, 'Task') : null,
  ].filter((part) => part !== null)

  return `Exported ${counted.join(' and ')} to ${path}.`
}

export function plural(count: number, thing: string): string {
  return `${count} ${thing}${count === 1 ? '' : 's'}`
}

/**
 * A Journal Day as a Digest heading: short enough to read as a date in a
 * standup thread. In UTC for the same reason as `formatJournalDay`.
 *
 * Pinned to `en-GB` on purpose, unlike the on-screen formatters. A Digest is
 * output — pasted into a thread or a prompt — and a heading whose shape depends
 * on the machine that produced it is worse than one that is merely British.
 */
export function formatDigestDay(journalDay: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(journalDay))
}

/**
 * The Journal Day an instant falls under: the local calendar day of Captured
 * At, midnight boundary. Pure, and built from local calendar parts so a day
 * containing a DST transition still resolves to exactly one day.
 */
export function journalDayFor(instant: Date): string {
  return [
    String(instant.getFullYear()).padStart(4, '0'),
    String(instant.getMonth() + 1).padStart(2, '0'),
    String(instant.getDate()).padStart(2, '0'),
  ].join('-')
}

/**
 * A Journal Day as a calendar's own kind of value. A `YYYY-MM-DD` label is a
 * civil day rather than an instant, and `journalDayFor` reads a local one back
 * out, so it is built as the local midnight of the day it names.
 */
export function dayAsDate(journalDay: string): Date {
  const [year, month, day] = journalDay.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/**
 * Which of today's events are to become Notes on this sweep. Everything Import
 * decides is here, so a sweep is this list and nothing else:
 *
 * - a calendar the user has not ticked is ignored entirely;
 * - a meeting becomes a Note as it *ends*, never while it is still running;
 * - only meetings that *ran during today* are swept, and only back as far as
 *   yesterday's midnight: Import covers the current day and nothing else, so
 *   nothing is ever backfilled — see
 *   docs/adr/0011-imported-meetings-are-today-only.md. The one meeting that
 *   began before today and is still swept is the one that was running as today
 *   began: it ends today, and anchoring on its start alone would mean no sweep
 *   could ever reach it — before midnight it has not ended, and after midnight
 *   it no longer began today;
 * - a declined event never becomes one — the user was not there;
 * - nor does an event covering the whole local day, whether or not the calendar
 *   marks it all-day: an out-of-office block running local midnight to midnight
 *   reports `isAllDay: false` and would otherwise arrive as a meeting that
 *   began at 00:00.
 *
 * There is no duration floor. A missed meeting is worse than an extra one,
 * because an extra one is deleted in a second and an absence is never noticed.
 *
 * Already-handled meetings are not filtered here: that is a fact about the
 * journal rather than about the calendar, and `importMeeting` holds it.
 */
export function meetingsToImport({
  events,
  calendarIds,
  now,
}: {
  events: CalendarEvent[]
  /** The ticked calendars. Empty means nothing is swept at all. */
  calendarIds: string[]
  now: Date
}): CalendarEvent[] {
  const ticked = new Set(calendarIds)
  const instant = now.getTime()
  const today = localMidnight(now)
  const yesterday = localMidnight(now, -1)

  return events.filter(
    (event) =>
      ticked.has(event.calendarId) &&
      !event.isDeclined &&
      event.endsAt <= instant &&
      event.endsAt > today &&
      event.startsAt >= yesterday &&
      !coversWholeLocalDay(event),
  )
}

/**
 * The instant a local calendar day began, `offsetInDays` from the one the given
 * instant falls under. Built from local calendar parts rather than by
 * subtracting hours, so the day either side of a DST transition still starts at
 * its own midnight.
 */
function localMidnight(instant: Date, offsetInDays = 0): number {
  return new Date(
    instant.getFullYear(),
    instant.getMonth(),
    instant.getDate() + offsetInDays,
  ).getTime()
}

/**
 * Whether an event blankets the local day its Journal Day would fall under:
 * starting at or before that midnight and ending at or after the next. True of
 * a genuine all-day event, of a multi-day one, and of the midnight-to-midnight
 * block a calendar does not mark as all-day. An event that merely runs long —
 * 00:00 to 23:00 — is a real thing that happened, and is not one of these.
 */
function coversWholeLocalDay(event: CalendarEvent): boolean {
  if (event.isAllDay) {
    return true
  }

  const began = new Date(event.startsAt)

  return (
    event.startsAt <= localMidnight(began) &&
    event.endsAt >= localMidnight(began, 1)
  )
}

/**
 * One occurrence of one event, as the journal remembers having handled it. A
 * recurring meeting shares its identifier across every occurrence, so the
 * instant it began is part of the identity — otherwise a daily standup would be
 * imported once and silently skipped for the rest of time.
 */
export function meetingKey(event: CalendarEvent): string {
  return `${event.id}@${new Date(event.startsAt).toISOString()}`
}

/** What an untitled meeting reads as, since a Body is never empty. */
export const UNTITLED_MEETING = '(untitled meeting)'

/**
 * A meeting's title as a Body: verbatim, but a Body is one line, so any run of
 * whitespace — including the line breaks a calendar allows in a title —
 * collapses to a single space.
 */
export function meetingBody(title: string): string {
  const body = title.replace(/\s+/g, ' ').trim()
  return body === '' ? UNTITLED_MEETING : body
}

/** An en dash: a rule wide enough to notice, and narrower than a digit. */
const EMPTY_DAY = '–'

/**
 * Today's Captured Note count as the menu bar reads it, beside the glyph.
 *
 * Zero is a dash rather than a `0`, because the two say different things in a
 * place this small: a `0` is a total, and a total reads as a day that has been
 * accounted for. A dash reads as a blank still waiting to be filled — which is
 * the whole reason the count is up there, since the app never asks for a Note
 * any other way.
 */
export function formatTrayCount(count: number): string {
  return count === 0 ? EMPTY_DAY : String(count)
}

/**
 * How long until the Journal Day changes — what the tray count waits out
 * before it starts the next day at nothing.
 *
 * Counted to the next local midnight rather than by adding a day's worth of
 * milliseconds: a day either side of a DST transition is 23 or 25 hours long,
 * and a fixed 24 would roll the count over at the wrong hour twice a year.
 */
export function msUntilNextJournalDay(now: Date): number {
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  )
  return midnight.getTime() - now.getTime()
}

/**
 * What an export is called: the journal, and the day it was taken. Dated so a
 * second export sits beside the first as a later snapshot rather than as an
 * anonymous copy.
 */
export function exportFileName(taken: Date): string {
  const day = [
    String(taken.getFullYear()).padStart(4, '0'),
    String(taken.getMonth() + 1).padStart(2, '0'),
    String(taken.getDate()).padStart(2, '0'),
  ].join('-')

  return `work-journal-${day}.md`
}

/** The Notes of one Journal Day, under the day they are filed under. */
export interface JournalDayGroup {
  journalDay: string
  notes: Note[]
}

/**
 * Notes under day headings, in the order they arrive. A Filter is a range, so
 * a result can span several days and each day says which one it is.
 */
export function groupByJournalDay(notes: Note[]): JournalDayGroup[] {
  const groups: JournalDayGroup[] = []

  for (const note of notes) {
    const open = groups.at(-1)
    if (open?.journalDay === note.journalDay) {
      open.notes.push(note)
    } else {
      groups.push({ journalDay: note.journalDay, notes: [note] })
    }
  }

  return groups
}

/**
 * A Journal Day as a heading. In the reader's own locale, so the date reads the
 * way the rest of their machine does. Formatted in UTC because a Journal Day is
 * a label rather than an instant: `YYYY-MM-DD` parses as UTC midnight, which is
 * the previous evening in a negative offset.
 */
export function formatJournalDay(journalDay: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(journalDay))
}

/**
 * A day range in words, for the one control that carries the Filter's day
 * axis — and for the headings of the renderings built from that axis.
 *
 * A range reads as a range rather than as two dates side by side: the reader's
 * own locale decides how the ends join, and everything the two ends share —
 * the month, the year — is said once. In UTC for the same reason
 * `formatJournalDay` is: a Journal Day is a `YYYY-MM-DD` label, which parses
 * as UTC midnight and would otherwise read as the previous evening.
 */
const RANGE_DAYS = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

export function formatDayRange(from: string, to: string): string {
  // A range whose ends are equal is one day, and says so once.
  if (from === to) return RANGE_DAYS.format(new Date(from))

  return RANGE_DAYS.formatRange(new Date(from), new Date(to))
}

/**
 * Captured At as the local time of day it happened at, in the reader's own
 * locale — including whether that locale writes a 12- or 24-hour clock.
 */
export function formatTimeOfDay(capturedAt: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(capturedAt))
}

/**
 * Task Completed At as Tasks View reads it: the day and the time of day, in the
 * reader's own locale. The day is part of it because the Completed list spans
 * the whole journal — a bare clock time would read as today's on a Task
 * completed a month ago.
 */
export function formatTaskCompletedAt(completedAt: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(completedAt))
}

/**
 * The timezone the machine is in right now — asked every time rather than
 * remembered, because the user travels and Scheduled For follows them.
 */
function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** One day, as a fixed span of milliseconds. Only ever used to step over one. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How far ahead of UTC a timezone is at one instant, in minutes. Read from the
 * OS's own timezone database through `Intl` rather than from a table of rules
 * kept here: the rules change, and the machine's copy is the one macOS will
 * deliver a Task Alert by.
 */
function zoneOffsetMinutes(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant))

  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0')

  const wall = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    // `en-US` with `hour12: false` writes midnight as 24 in some engines.
    read('hour') % 24,
    read('minute'),
    read('second'),
  )

  return Math.round((wall - instant) / 60_000)
}

/** The local calendar date one instant falls on, `YYYY-MM-DD`. */
function civilDateIn(instant: Date, timeZone: string): string {
  const offset = zoneOffsetMinutes(instant.getTime(), timeZone)
  return new Date(instant.getTime() + offset * 60_000)
    .toISOString()
    .slice(0, 10)
}

/**
 * The instant a Scheduled For actually falls at, worked out from its civil
 * components and the timezone the user is in now — never stored, because the
 * civil time is the source of truth and the instant follows the traveller; see
 * docs/adr/0021-task-schedules-are-stored-as-civil-time.md.
 *
 * A date-only schedule resolves to the start of its day: what a whole day
 * becomes when a single moment is needed for ordering. It never becomes a Task
 * Alert, which is a different question entirely.
 *
 * The two awkward days of the year are decided here rather than left to
 * whatever `new Date` does with them. A wall-clock time that does not exist —
 * the hour a spring transition skips — resolves to the first instant that does,
 * which is the transition itself. A wall-clock time that happens twice —
 * autumn — resolves to the first of the two.
 */
export function scheduledInstant(
  schedule: TaskSchedule,
  timeZone: string = localTimeZone(),
): Date {
  const [year, month, day] = schedule.date.split('-').map(Number)
  const [hour, minute] = (schedule.time ?? '00:00').split(':').map(Number)
  const wall = Date.UTC(year, month - 1, day, hour, minute)

  // The offsets in force either side of any transition near this wall time.
  // A day is wider than any transition, and no zone has two in one day.
  const offsets = [
    zoneOffsetMinutes(wall - DAY_MS, timeZone),
    zoneOffsetMinutes(wall + DAY_MS, timeZone),
  ]

  const candidates = offsets.map((offset) => wall - offset * 60_000)
  // A candidate is real only if reading it back in that zone gives the wall
  // clock the user actually wrote. Both being real is the repeated hour.
  const real = candidates.filter(
    (instant) =>
      zoneOffsetMinutes(instant, timeZone) ===
      Math.round((wall - instant) / 60_000),
  )

  if (real.length > 0) {
    return new Date(Math.min(...real))
  }

  // Neither is real: the user wrote a time the clocks skipped over. The first
  // valid instant afterwards is the transition itself, found between the two.
  return new Date(
    transitionBetween(
      Math.min(...candidates),
      Math.max(...candidates),
      timeZone,
    ),
  )
}

/**
 * The instant a timezone's offset changes, somewhere between two instants that
 * straddle it, to the minute — which is as fine as any transition is and as
 * fine as Scheduled For goes.
 */
function transitionBetween(
  before: number,
  after: number,
  timeZone: string,
): number {
  const offsetBefore = zoneOffsetMinutes(before, timeZone)
  let low = before
  let high = after

  while (high - low > 60_000) {
    const middle = low + Math.floor((high - low) / 2)
    if (zoneOffsetMinutes(middle, timeZone) === offsetBefore) {
      low = middle
    } else {
      high = middle
    }
  }

  return high
}

/**
 * The four groups Tasks View opens on. Overdue first because it is the one
 * that is already costing the user something, and Unscheduled last because it
 * is the only one that is not about time at all.
 */
export type TaskGroupName = 'overdue' | 'today' | 'upcoming' | 'unscheduled'

export interface TaskGroup {
  name: TaskGroupName
  tasks: Task[]
}

/** In the order Tasks View shows them, empty ones included. */
export const TASK_GROUPS: readonly TaskGroupName[] = [
  'overdue',
  'today',
  'upcoming',
  'unscheduled',
]

/**
 * Which group each Open Task falls in, right now. A pure reading of the same
 * list `openTasks` returns, so a window that has been open since yesterday
 * re-groups by asking again rather than by re-reading the database — which is
 * what local midnight, a wake and a regained focus each do.
 *
 * A Task whose moment has passed is Overdue, whether it was scheduled for last
 * year or for an hour ago; a date-only Task is Overdue only once its whole day
 * is behind the user. Order inside each group is the order given, which is
 * already the order Tasks View wants.
 */
export function groupOpenTasks(
  tasks: Task[],
  now: Date,
  timeZone: string = localTimeZone(),
): TaskGroup[] {
  const today = civilDateIn(now, timeZone)

  return TASK_GROUPS.map((name) => ({
    name,
    tasks: tasks.filter(
      (task) => groupOf(task, now, today, timeZone) === name,
    ),
  }))
}

function groupOf(
  task: Task,
  now: Date,
  today: string,
  timeZone: string,
): TaskGroupName {
  const schedule = scheduleOf(task)

  if (schedule === null) return 'unscheduled'
  if (schedule.date < today) return 'overdue'
  if (schedule.date > today) return 'upcoming'
  // Today, and the only question left is whether its minute has been and gone.
  if (schedule.time === null) return 'today'

  return scheduledInstant(schedule, timeZone).getTime() <= now.getTime()
    ? 'overdue'
    : 'today'
}

/**
 * Scheduled For as Tasks View reads it: the day in the reader's own locale, and
 * the time of day after it when there is one. Nothing at all when the Task is
 * Unscheduled — a blank says it better than the word would.
 */
export function formatScheduledFor(task: Task): string | null {
  const schedule = scheduleOf(task)
  if (schedule === null) return null

  const at = scheduledInstant(schedule)
  const day = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(at)

  if (schedule.time === null) return day

  return `${day}, ${new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(at)}`
}

/**
 * One Task Alert as the OS is asked to hold it: the civil components macOS
 * matches its own clock against, and the whole Task Description to show. Must
 * match `TaskAlert` in `src-tauri/src/alerts.rs`.
 */
export interface TaskAlert {
  /**
   * The pending request's identifier, derived from the Task so that the same
   * Task always claims the same one — which is what makes registering again
   * replace rather than duplicate, and cancelling possible from the id alone.
   */
  id: string
  /** Shown in full: a truncated commitment is not the commitment. */
  description: string
  /** The local calendar date and minute macOS is asked to match. */
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

/** The one identifier a Task's pending request ever has. */
export function taskAlertId(taskId: string): string {
  return `task:${taskId}`
}

/** And back: which Task an Alert the user clicked belongs to. */
export function taskIdOfAlert(alertId: string): string | null {
  return alertId.startsWith('task:') ? alertId.slice('task:'.length) : null
}

/**
 * Every Task Alert that should be pending with macOS right now, derived from
 * the journal's own Open Tasks — the database is authoritative and the OS's
 * pending requests are a copy of this answer.
 *
 * Only a future Open Task with both a date and a time has one. A date-only
 * Task never does: it would have to invent a time nobody chose. A Task whose
 * moment has already passed never does either — it is Overdue on screen, which
 * is the whole of what the journal has to say about it, and an Alert fired
 * after the fact would be a reminder to do something at a time that is gone.
 */
export function taskAlerts(
  tasks: Task[],
  now: Date,
  timeZone: string = localTimeZone(),
): TaskAlert[] {
  return tasks.flatMap((task) => {
    const schedule = scheduleOf(task)

    if (!isOpen(task) || schedule === null || schedule.time === null) {
      return []
    }

    if (scheduledInstant(schedule, timeZone).getTime() <= now.getTime()) {
      return []
    }

    const [year, month, day] = schedule.date.split('-').map(Number)
    const [hour, minute] = schedule.time.split(':').map(Number)

    return [
      {
        id: taskAlertId(task.id),
        description: task.description,
        year,
        month,
        day,
        hour,
        minute,
      },
    ]
  })
}

/**
 * A Note's Project as it reads on screen: `#name`, or Unfiled when there is
 * none. The filing label History shows next to every Body.
 */
export function formatProject(project: string | null): string {
  return project === null ? 'Unfiled' : `#${project}`
}

/**
 * A Project constraint as the value of a picker, and back. `#` cannot occur in
 * a Project name, so a Project called `any` or `unfiled` is still its own
 * choice rather than one of the two constants.
 */
export function projectChoice(constraint: ProjectConstraint): string {
  return constraint.kind === 'named' ? `#${constraint.name}` : constraint.kind
}

/** And back: the value a picker reports, as the constraint it stands for. */
export function projectConstraintFor(choice: string): ProjectConstraint {
  if (choice === 'unfiled') return UNFILED
  if (choice.startsWith('#')) {
    return { kind: 'named', name: projectName(choice.slice(1)) }
  }
  return ANY_PROJECT
}

/** One Journal Day as a day range: a range whose ends are equal. */
export function rangeForJournalDay(journalDay: string): DayRange {
  return { from: journalDay, to: journalDay }
}

/**
 * A range of Journal Days, whichever end the reader picked first. A range
 * always reads oldest end first, so the two ends of a picker cannot put the
 * core in a state that selects nothing.
 */
export function rangeForDays(oneEnd: string, otherEnd: string): DayRange {
  return oneEnd <= otherEnd
    ? { from: oneEnd, to: otherEnd }
    : { from: otherEnd, to: oneEnd }
}

/**
 * Whether one Journal Day falls in an inclusive day range. Day labels compare
 * as strings, so both ends are included and no instant is built.
 */
export function dayInRange(day: string, from: string, to: string): boolean {
  return day >= from && day <= to
}

/**
 * A named civil-time range relative to today. One-shot: the clock is read when
 * the Preset is chosen, and the result is an ordinary day range — nothing
 * sticky, nothing rolling, and nothing about the Project axis, which a Preset
 * never touches. Week starts Monday. "This" units run from the unit start
 * through today; "last" units are the full prior calendar unit.
 */
export type FilterPreset =
  | 'today'
  | 'yesterday'
  | 'this-week'
  | 'last-week'
  | 'this-month'
  | 'last-month'

export function rangeForPreset(preset: FilterPreset, today: string): DayRange {
  switch (preset) {
    case 'today':
      return rangeForJournalDay(today)
    case 'yesterday':
      return rangeForJournalDay(shiftDay(today, -1))
    case 'this-week':
      return { from: startOfWeek(today), to: today }
    case 'last-week': {
      const thisMonday = startOfWeek(today)
      const lastMonday = shiftDay(thisMonday, -7)
      return { from: lastMonday, to: shiftDay(lastMonday, 6) }
    }
    case 'this-month':
      return { from: startOfMonth(today), to: today }
    case 'last-month': {
      const [year, month] = parts(today)
      const prior = month === 1 ? [year - 1, 12] : [year, month - 1]
      const from = dayLabel(prior[0], prior[1], 1)
      const to = dayLabel(prior[0], prior[1], daysInMonth(prior[0], prior[1]))
      return { from, to }
    }
  }
}

/** Calendar arithmetic on a `YYYY-MM-DD` label, not an instant. */
function parts(journalDay: string): [number, number, number] {
  const [year, month, day] = journalDay.split('-').map(Number)
  return [year, month, day]
}

function dayLabel(year: number, month: number, day: number): string {
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-')
}

function shiftDay(journalDay: string, days: number): string {
  const [year, month, day] = parts(journalDay)
  // Local Date so month overflow and leap days land on the civil calendar.
  return journalDayFor(new Date(year, month - 1, day + days))
}

function startOfWeek(journalDay: string): string {
  return shiftDay(journalDay, -daysSinceMonday(journalDay))
}

/**
 * The ISO weekday a `YYYY-MM-DD` falls on: 1 is Monday, 7 is Sunday. A week
 * begins on Monday everywhere in the app, and this is the one place that says
 * so — a Preset's week, a weekly cadence's, and the weekday a control
 * preselects are all the same week.
 */
export function weekdayOf(journalDay: string): number {
  return daysSinceMonday(journalDay) + 1
}

/** JavaScript counts Sunday as 0; a week here begins on Monday. */
function daysSinceMonday(journalDay: string): number {
  const [year, month, day] = parts(journalDay)
  return (new Date(year, month - 1, day).getDay() + 6) % 7
}

function startOfMonth(journalDay: string): string {
  const [year, month] = parts(journalDay)
  return dayLabel(year, month, 1)
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(year, month, 0).getDate()
}

/**
 * How many calendar days apart two `YYYY-MM-DD` labels are. Counted in UTC,
 * where every day is the same length, because these are labels rather than
 * instants.
 */
function daysBetween(from: string, to: string): number {
  const [fromYear, fromMonth, fromDay] = parts(from)
  const [toYear, toMonth, toDay] = parts(to)

  return Math.round(
    (Date.UTC(toYear, toMonth - 1, toDay) -
      Date.UTC(fromYear, fromMonth - 1, fromDay)) /
      DAY_MS,
  )
}

/**
 * The slot at one index of a cadence counted from a starting date, before the
 * ones that fall before that date are dropped. Every rule of how a cadence
 * lands on the calendar is here, and there is nowhere else it is decided:
 *
 * - a daily cadence steps whole days from the starting date;
 * - a weekly one is counted in Monday-based weeks from the week containing the
 *   starting date, and walks its selected weekdays in order inside each active
 *   week — which is why an index is a week block plus a weekday rather than a
 *   number of days;
 * - a monthly one keeps the starting date's day of the month, falling back to
 *   the last day of a month too short for it and returning to its own day the
 *   month after: January 31 becomes February 28 and then March 31, rather than
 *   drifting to the 28th for good;
 * - a yearly one keeps the starting date's month and day the same way, so
 *   February 29 becomes February 28 in an ordinary year and is February 29
 *   again in the next leap year.
 */
function rawSlot(anchor: string, recurrence: Recurrence, index: number): string {
  const [year, month, day] = parts(anchor)

  switch (recurrence.unit) {
    case 'day':
      return shiftDay(anchor, index * recurrence.interval)
    case 'week': {
      const chosen = recurrence.weekdays
      const block = Math.floor(index / chosen.length)
      const weekday = chosen[index % chosen.length]
      return shiftDay(
        startOfWeek(anchor),
        block * recurrence.interval * 7 + weekday - 1,
      )
    }
    case 'month': {
      const months = month - 1 + index * recurrence.interval
      const inYear = year + Math.floor(months / 12)
      const inMonth = (months % 12) + 1
      return dayLabel(inYear, inMonth, Math.min(day, daysInMonth(inYear, inMonth)))
    }
    case 'year': {
      const inYear = year + index * recurrence.interval
      return dayLabel(inYear, month, Math.min(day, daysInMonth(inYear, month)))
    }
  }
}

/**
 * Which raw index the series actually begins at. Zero for every cadence but
 * the weekly one, whose first active week may hold selected weekdays before
 * the starting date — those are ignored, because a series does not begin
 * before it was asked to.
 */
function startIndex(anchor: string, recurrence: Recurrence): number {
  if (recurrence.unit !== 'week') return 0

  // One full week block is enough: if no selected weekday in the starting
  // week is on or after the starting date, the first one of the next active
  // week is.
  for (let index = 0; index <= recurrence.weekdays.length; index += 1) {
    if (rawSlot(anchor, recurrence, index) >= anchor) return index
  }

  return 0
}

/** The slot at one index of a series: `0` is the one it opens on. */
function slotDate(anchor: string, recurrence: Recurrence, index: number): string {
  return rawSlot(anchor, recurrence, index + startIndex(anchor, recurrence))
}

/**
 * Roughly which raw index a date falls at — close enough that the exact one is
 * a step or two away, which is what keeps finding a slot from being a walk
 * from the starting date however long ago that was.
 */
function estimateRawIndex(
  anchor: string,
  recurrence: Recurrence,
  date: string,
): number {
  const [anchorYear, anchorMonth] = parts(anchor)
  const [year, month] = parts(date)

  switch (recurrence.unit) {
    case 'day':
      return Math.floor(daysBetween(anchor, date) / recurrence.interval)
    case 'week': {
      const weeks = Math.floor(
        daysBetween(startOfWeek(anchor), startOfWeek(date)) / 7,
      )
      return (
        Math.floor(weeks / recurrence.interval) * recurrence.weekdays.length
      )
    }
    case 'month':
      return Math.floor(
        ((year - anchorYear) * 12 + (month - anchorMonth)) / recurrence.interval,
      )
    case 'year':
      return Math.floor((year - anchorYear) / recurrence.interval)
  }
}

/**
 * The latest slot of a series that is on or before a date, as its index, or
 * null when the series has not started by then.
 */
function slotIndexOnOrBefore(
  anchor: string,
  recurrence: Recurrence,
  date: string,
): number | null {
  const start = startIndex(anchor, recurrence)
  let index = Math.max(estimateRawIndex(anchor, recurrence, date), start - 1)

  // Slots are strictly increasing in the index, so this converges from either
  // side of the estimate and only one of the two loops ever runs.
  while (rawSlot(anchor, recurrence, index + 1) <= date) index += 1
  while (index >= start && rawSlot(anchor, recurrence, index) > date) index -= 1

  return index < start ? null : index - start
}

/**
 * Whether a slot's moment has been and gone — the same reading of a schedule
 * that makes an Open Task Overdue, so a series never opens on, or advances to,
 * something the user could not still act on. A date-only slot is elapsed only
 * once its whole day is behind them.
 */
function slotHasPassed(
  slot: TaskSchedule,
  now: Date,
  timeZone: string,
): boolean {
  const today = civilDateIn(now, timeZone)

  if (slot.date < today) return true
  if (slot.date > today) return false
  if (slot.time === null) return false

  return scheduledInstant(slot, timeZone).getTime() <= now.getTime()
}

/**
 * The slot a series opens on when it is created: its first, unless that has
 * already elapsed, in which case its latest elapsed one — which is Overdue on
 * screen.
 *
 * A series started in the past therefore opens on one occurrence rather than
 * on every slot it missed: a backlog of cloned commitments after time away is
 * the thing this design exists to avoid; see
 * docs/adr/0016-recurring-tasks-have-one-open-occurrence.md.
 */
export function openingSlot(
  anchor: string,
  recurrence: Recurrence,
  time: string | null,
  now: Date,
  timeZone: string = localTimeZone(),
): string {
  const first = slotDate(anchor, recurrence, 0)
  if (!slotHasPassed({ date: first, time }, now, timeZone)) return first

  const index = slotIndexOnOrBefore(anchor, recurrence, civilDateIn(now, timeZone)) ?? 0
  const latest = slotDate(anchor, recurrence, index)

  // Today's slot may still be ahead of its own minute, in which case the
  // latest one that has actually elapsed is the slot before it.
  return slotHasPassed({ date: latest, time }, now, timeZone)
    ? latest
    : slotDate(anchor, recurrence, Math.max(index - 1, 0))
}

/**
 * The slot an edited series resumes on: like `openingSlot` but preferring
 * today's slot whenever the time just typed is still ahead, rather than
 * stepping back onto the latest elapsed one. Without the split, retiming a
 * reminder to 23:00 at 14:00 would open yesterday at 23:00 — see
 * docs/adr/0037-an-edit-never-reopens-a-slot-the-series-has-kept.md.
 */
export function resumedSlot(
  anchor: string,
  recurrence: Recurrence,
  time: string | null,
  now: Date,
  timeZone: string = localTimeZone(),
): string {
  const first = slotDate(anchor, recurrence, 0)
  if (!slotHasPassed({ date: first, time }, now, timeZone)) return first

  const index = slotIndexOnOrBefore(anchor, recurrence, civilDateIn(now, timeZone)) ?? 0
  return slotDate(anchor, recurrence, index)
}

/**
 * The slot a completion advances to: the first one after the occurrence just
 * kept whose moment is still ahead. Slots that were missed while the user was
 * away are stepped over rather than materialized, which is what makes coming
 * back to a Recurring Task one commitment rather than a fortnight of them.
 */
export function advancedSlot(
  anchor: string,
  recurrence: Recurrence,
  time: string | null,
  from: string,
  now: Date,
  timeZone: string = localTimeZone(),
): string {
  let index = (slotIndexOnOrBefore(anchor, recurrence, from) ?? -1) + 1

  // Jump the missed ones rather than walking them: a daily Task left for a
  // year is a year of slots nobody is going to be asked about.
  const elapsed = slotIndexOnOrBefore(
    anchor,
    recurrence,
    civilDateIn(now, timeZone),
  )
  if (elapsed !== null && elapsed > index) index = elapsed

  while (
    slotHasPassed({ date: slotDate(anchor, recurrence, index), time }, now, timeZone)
  ) {
    index += 1
  }

  return slotDate(anchor, recurrence, index)
}

/** Whether two cadences say the same thing, so an edit knows it changed one. */
export function sameRecurrence(
  one: Recurrence | null,
  other: Recurrence | null,
): boolean {
  if (one === null || other === null) return one === other

  return (
    one.unit === other.unit &&
    one.interval === other.interval &&
    one.weekdays.length === other.weekdays.length &&
    one.weekdays.every((weekday, at) => weekday === other.weekdays[at])
  )
}

/** Monday first, because a week here begins on Monday wherever it is read. */
const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]

/** One ISO weekday as it reads: 1 is Monday, 7 is Sunday. */
export function formatWeekday(weekday: number): string {
  return WEEKDAY_NAMES[weekday - 1] ?? String(weekday)
}

/**
 * A cadence as one line of English, used wherever one is shown or written
 * down: under a Task in Tasks View, and under one in an export. Deliberately
 * the same words in both, so a file reads as the app does.
 */
export function formatRecurrence(recurrence: Recurrence): string {
  const { unit, interval, weekdays } = recurrence
  const every = interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`

  if (unit !== 'week') return every

  return `${every} on ${listOfWeekdays(weekdays)}`
}

/** The selected weekdays, read out: "Monday, Wednesday and Friday". */
function listOfWeekdays(weekdays: number[]): string {
  const names = weekdays.map(formatWeekday)
  if (names.length <= 1) return names.join('')

  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * A newly captured Note against the days on screen. A Note filed under a day
 * in view belongs in the list; one filed outside it must not move the list
 * under a reader, so it becomes a nudge naming the day that gained content —
 * moving the Filter there stays the reader's decision.
 *
 * The day axis and nothing else: a Note the Project constraint excludes is
 * simply not in the list, because a mismatch there is too ordinary to announce
 * — see docs/adr/0008-project-narrows-filter.md.
 *
 * `YYYY-MM-DD` compares as a string in calendar order, which is why a range is
 * a pair of them.
 */
export function decideArrival(
  range: DayRange,
  journalDay: string,
): ArrivalDecision {
  if (journalDay >= range.from && journalDay <= range.to) {
    return { kind: 'show' }
  }
  return { kind: 'nudge', journalDay }
}

/**
 * A keystroke plus the current field text, as a decision. The app's most
 * repeated interaction, kept out of the view so it is testable without
 * rendering anything.
 */
export function decideKeystroke(key: string, text: string): KeystrokeDecision {
  if (key === 'Escape') {
    return 'discard'
  }
  if (key === 'Enter') {
    // A bare Project Marker is nothing to commit, same as blank input.
    return parseCapture(text) === null ? 'ignore' : 'commit'
  }
  return 'ignore'
}

/**
 * The prefix of an open Project Marker being typed at the start of Capture.
 * Null once a Body has begun or there is no leading marker — Predictions only
 * surface while the marker itself is still being written.
 */
export function markerPrefix(text: string): string | null {
  const open = /^#([A-Za-z0-9_-]*)$/.exec(text)
  return open === null ? null : open[1]
}

/**
 * Choosing a Prediction: fill the open marker with `#name` and a trailing
 * space so the Body can follow. The user can still edit before commit.
 */
export function applyPrediction(name: string): string {
  return `#${name} `
}

/**
 * The Note an operation was asked to change. Every correction starts here, so
 * changing a Note that is no longer there fails loudly rather than silently
 * updating nothing.
 */
async function read(driver: SqlDriver, id: string): Promise<Note> {
  const [row] = await driver.select<NoteRow>(SELECT_NOTE, [id])

  if (row === undefined) {
    throw new Error(`No such Note: ${id}.`)
  }

  return toNote(row)
}

/**
 * The Task an operation was asked to change. Every Task correction starts
 * here, so changing one that is no longer there fails loudly rather than
 * silently updating nothing.
 */
/** The Task, or null when there is none — for callers a gap is an answer to. */
async function findTask(driver: SqlDriver, id: string): Promise<Task | null> {
  const [row] = await driver.select<TaskRow>(SELECT_TASK, [id])

  return row === undefined ? null : toTask(row)
}

async function readTask(driver: SqlDriver, id: string): Promise<Task> {
  const [row] = await driver.select<TaskRow>(SELECT_TASK, [id])

  if (row === undefined) {
    throw new Error(`No such Task: ${id}.`)
  }

  return toTask(row)
}

/**
 * Every Task Occurrence of one Task, newest slot first, the Open one among
 * them. A Task that does not repeat has none, which is not a failure.
 */
async function readOccurrences(
  driver: SqlDriver,
  taskId: string,
): Promise<TaskOccurrence[]> {
  const rows = await driver.select<TaskOccurrenceRow>(
    SELECT_OCCURRENCES_OF_TASK,
    [taskId],
  )
  return rows.map(toOccurrence)
}

/**
 * The one Open Task Occurrence a Recurring Task always has. Its absence is a
 * broken invariant rather than an empty result, so it fails loudly instead of
 * quietly opening a second one.
 */
async function readOpenOccurrence(
  driver: SqlDriver,
  taskId: string,
): Promise<TaskOccurrence> {
  const open = openOccurrence(await readOccurrences(driver, taskId))

  if (open === null) {
    throw new Error(`That Recurring Task has no Open Task Occurrence: ${taskId}.`)
  }

  return open
}

/**
 * The statement that opens an occurrence at wherever the Task now stands.
 * `advancedFrom` is the occurrence whose completion produced it, and null when
 * nothing did — which is the whole of what makes Undo Completion safe to
 * offer later.
 */
function opensOccurrence(
  task: Task,
  createdAt: Date,
  advancedFrom: string | null,
): SqlStatement {
  return {
    sql: INSERT_TASK_OCCURRENCE,
    params: [
      crypto.randomUUID(),
      task.id,
      task.scheduledDate,
      task.scheduledTime,
      createdAt.toISOString(),
      advancedFrom,
    ],
  }
}

/**
 * Stopping a series: the rule goes and the Open occurrence with it, while the
 * Task stays exactly where it stands and every completed occurrence stays
 * under it. One transaction, because a Task that kept its rule and lost its
 * occurrence would be a series asking for nothing.
 */
async function stopRecurring(
  driver: SqlDriver,
  task: Task,
  left: { description: string; date: string | null; time: string | null },
): Promise<Task> {
  await driver.transaction([
    {
      sql: UPDATE_TASK_WITH_RECURRENCE,
      params: [
        left.description,
        left.date,
        left.time,
        ...recurrenceParams(null, null),
        task.id,
      ],
    },
    { sql: DELETE_OPEN_OCCURRENCE, params: [task.id] },
  ])

  return {
    ...task,
    description: left.description,
    scheduledDate: left.date,
    scheduledTime: left.time,
    recurrence: null,
    recurrenceAnchor: null,
  }
}

/**
 * A Task Description as the journal stores it: trimmed at its ends, and
 * otherwise exactly what was written — internal whitespace and every kind of
 * Unicode survive verbatim, and nothing in it is read for meaning. There is no
 * length limit; the only rule is that it says something, on one line.
 */
function taskDescription(description: string): string {
  if (/[\n\r]/.test(description)) {
    throw new Error(
      'A Task Description is one line: it cannot contain a line break.',
    )
  }

  const said = description.trim()
  if (said === '') {
    throw new Error('A Task Description cannot be empty.')
  }

  return said
}

/**
 * Scheduled For as the journal stores it: a real calendar date, and a real
 * minute of the day on it. Null passes through as Unscheduled, and a schedule
 * whose time is null is date-only — the two are different answers, and neither
 * is a default for the other.
 *
 * A past date is not checked for: a commitment that was missed is still a
 * commitment, and refusing it here would lose the one thing the user is
 * telling the journal.
 */
function taskSchedule(schedule: TaskSchedule | null): TaskSchedule | null {
  if (schedule === null) {
    return null
  }

  if (!isCalendarDate(schedule.date)) {
    throw new Error(
      `Scheduled For is a calendar date: ${schedule.date} is not one.`,
    )
  }

  if (schedule.time !== null && !isWallClockTime(schedule.time)) {
    throw new Error(
      `Scheduled For is a minute of the day: ${schedule.time} is not one.`,
    )
  }

  return { date: schedule.date, time: schedule.time }
}

/**
 * `YYYY-MM-DD`, and a day that actually exists: the shape alone would accept
 * the 31st of February. The year is bounded like a Journal Day's, so a
 * half-typed year on the way to `2026` never reaches the database.
 */
function isCalendarDate(date: string): boolean {
  if (!/^[2-9]\d{3}-\d{2}-\d{2}$/.test(date)) {
    return false
  }

  // Round-tripped through UTC, where no day is 23 or 25 hours long: a date
  // that survives is one the calendar has. A month beyond 12 never becomes a
  // Date at all, so it is refused rather than thrown.
  const instant = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(instant.getTime())) {
    return false
  }

  return instant.toISOString().slice(0, 10) === date
}

/** `HH:mm` on a 24-hour clock, minute-precise and nothing finer. */
function isWallClockTime(time: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time)
}

function toTask(row: TaskRow): Task {
  const recurrence = toRecurrence(row)

  return {
    id: row.id,
    description: row.description,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    scheduledDate: row.scheduled_date,
    // A time without a date is not a schedule; a row that somehow holds one is
    // read as the date-only schedule it actually is.
    scheduledTime: row.scheduled_date === null ? null : row.scheduled_time,
    recurrence,
    // A cadence with no starting date could not be counted, so the two only
    // ever exist together — a row written before recurrence did has neither.
    recurrenceAnchor: recurrence === null ? null : row.recurrence_anchor_date,
  }
}

/**
 * The cadence a row holds, or null for the Tasks that do not repeat — which is
 * every Task written before recurrence existed, and every ordinary one since.
 * A rule missing any of the parts it is counted from is read as no rule at
 * all rather than as a cadence nobody can work out.
 */
function toRecurrence(row: TaskRow): Recurrence | null {
  const unit = row.recurrence_unit
  if (
    unit !== 'day' &&
    unit !== 'week' &&
    unit !== 'month' &&
    unit !== 'year'
  ) {
    return null
  }

  const interval = Number(row.recurrence_interval)
  if (!Number.isInteger(interval) || interval < 1) return null
  if (row.recurrence_anchor_date === null) return null

  const weekdays = toWeekdays(row.recurrence_weekdays)
  if (unit === 'week' && weekdays.length === 0) return null

  return { unit, interval, weekdays: unit === 'week' ? weekdays : [] }
}

/** The selected weekdays as the column spells them: `1,3,5`. */
function toWeekdays(column: string | null): number[] {
  if (column === null || column === '') return []

  return column
    .split(',')
    .map(Number)
    .filter((weekday) => Number.isInteger(weekday) && weekday >= 1 && weekday <= 7)
    .sort((one, other) => one - other)
}

/** And back, for the one statement that writes a cadence down. */
function weekdaysColumn(recurrence: Recurrence | null): string | null {
  if (recurrence === null || recurrence.unit !== 'week') return null
  return recurrence.weekdays.join(',')
}

/** The four recurrence parameters, in the order every statement writes them. */
function recurrenceParams(
  recurrence: Recurrence | null,
  anchor: string | null,
): unknown[] {
  return [
    recurrence?.unit ?? null,
    recurrence?.interval ?? null,
    weekdaysColumn(recurrence),
    recurrence === null ? null : anchor,
  ]
}

function toOccurrence(row: TaskOccurrenceRow): TaskOccurrence {
  return {
    id: row.id,
    taskId: row.task_id,
    scheduledDate: row.scheduled_date,
    scheduledTime: row.scheduled_time,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    advancedFrom: row.advanced_from,
  }
}

/**
 * A cadence as the journal stores it: a real unit, a whole interval of at
 * least one, and — weekly only — at least one selected weekday, ascending and
 * without duplicates. Null passes through as a Task that does not repeat.
 *
 * Recurrence requires a date, and the check is here rather than in a view
 * because it is the rule and not the control: a cadence with nothing to count
 * from is not a cadence.
 */
function taskRecurrence(
  recurrence: Recurrence | null,
  schedule: TaskSchedule | null,
): Recurrence | null {
  if (recurrence === null) return null

  if (schedule === null) {
    throw new Error(
      'A Recurring Task needs a Scheduled For date to be counted from.',
    )
  }

  if (!Number.isInteger(recurrence.interval) || recurrence.interval < 1) {
    throw new Error(
      `A cadence repeats every whole unit or more: ${recurrence.interval} is not one.`,
    )
  }

  if (recurrence.unit !== 'week') {
    return { unit: recurrence.unit, interval: recurrence.interval, weekdays: [] }
  }

  const weekdays = [...new Set(recurrence.weekdays)].sort(
    (one, other) => one - other,
  )

  if (
    weekdays.length === 0 ||
    weekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 1 || weekday > 7)
  ) {
    throw new Error('A weekly cadence repeats on at least one weekday.')
  }

  return { unit: 'week', interval: recurrence.interval, weekdays }
}

/**
 * A Journal Day is a `YYYY-MM-DD` label, not a date to be parsed — but the
 * shape alone is not the rule. It is a day that actually exists, under the
 * same rule `isCalendarDate` enforces, so `2026-13-99` never reaches the
 * database to throw in the formatters. A journal of work notes files nothing
 * in the third century, so the year is bounded: it keeps a half-typed year
 * out of the database, since a date input hands over `0002-07-31` on the way
 * to `2026`.
 */
function isJournalDay(journalDay: string): boolean {
  return isCalendarDate(journalDay)
}

/**
 * A Project name as the journal stores it, or Unfiled. Null is Unfiled. A
 * string is trimmed and lowercased; only letters, digits, `_` and `-` are
 * allowed, and it must not be empty — the same rule Capture's marker uses, so
 * a name typed in History is one Capture could have written.
 */
function normalizeProject(project: string | null): string | null {
  return project === null ? null : projectName(project)
}

/**
 * Whether the journal would accept this as a Project name. The same rule
 * `projectName` enforces, asked rather than thrown — a picker offering a name
 * the record is going to refuse is offering a choice that is not one.
 */
export function isProjectName(project: string): boolean {
  try {
    projectName(project)
    return true
  } catch {
    return false
  }
}

/**
 * The same rule for a name that is definitely one: a Project, or an error.
 * Exported because a caller can hold a Project by name — a Filter narrowed to
 * one — and has to compare it with a name the way the record stores it, which
 * is a rule of the record's and not of the caller's.
 */
export function projectName(project: string): string {
  const name = project.trim().toLowerCase()
  if (name === '' || !/^[a-z0-9_-]+$/.test(name)) {
    throw new Error(`Not a Project: ${project}.`)
  }

  return name
}

/**
 * A term as the literal text it is. What a reader types is a substring of a
 * Body, so `LIKE`'s own wildcards have to be spelled out: `50%` finds the Note
 * about the queue rather than every Note in the journal.
 */
function escapeForLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`)
}

/** Nothing to commit: a Capture ends in one Note or in nothing at all. */
function isBlank(body: string): boolean {
  return body.trim() === ''
}

/**
 * A Capture as Project + Body. A leading `#name` Project Marker is consumed:
 * Project is set lowercase, Body is whatever follows. A bare marker, or blank
 * input, is nothing to commit. Mid-line or malformed `#` stays plain Body.
 */
function parseCapture(
  text: string,
): { project: string | null; body: string } | null {
  const trimmed = text.trim()
  if (trimmed === '') {
    return null
  }

  const marker = /^#([A-Za-z0-9_-]+)(?:\s+(.*))?$/.exec(trimmed)
  if (marker === null) {
    return { project: null, body: trimmed }
  }

  const body = (marker[2] ?? '').trim()
  if (body === '') {
    return null
  }

  return { project: marker[1].toLowerCase(), body }
}

/** The Body invariant, held in one place: a Note is a remark, not a document. */
function assertOneLine(body: string): void {
  if (/[\n\r]/.test(body)) {
    throw new Error('A Body is one line: it cannot contain a line break.')
  }
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    body: row.body,
    project: row.project,
    capturedAt: row.captured_at,
    journalDay: row.journal_day,
    editedAt: row.edited_at,
    // A row written before Import existed has no origin of its own; the column
    // defaults for those, and anything else at all is read as typed rather than
    // silently rendering a Note the user wrote as one they did not.
    origin: row.origin === 'import' ? 'import' : 'capture',
  }
}
