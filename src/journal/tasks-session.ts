/**
 * Managing what you owe, as a session rather than a screen: which of the two
 * lists is showing — or the Search that has taken the screen over —, the Tasks
 * it resolves to, which of the four groups each one falls in, and what a
 * change to any of them re-reads. Every sequencing rule of Tasks View lives
 * here — which of two overlapping reads may reach the view,
 * what a refused change says, when the OS is asked to allow Task Alerts — so
 * Tasks View is JSX over a snapshot.
 *
 * Headless on purpose: it is built from a Journal, a Desktop and a clock, and
 * nothing else, so the rules can be driven end to end from a test with real SQL
 * and no DOM. It holds no domain rule of its own — grouping, ordering and which
 * Tasks have an Alert all stay in the core, which this module asks.
 *
 * A session is built per Tasks View and is never reset: its Main Window section
 * is created with the window and genuinely closed on dismiss.
 */

import type { Desktop } from '@/platform/desktop'
import {
  ALERT_REFUSED,
  ALERTS_NOT_HELD,
  askAboutTaskAlerts,
} from './task-alerts'
import { createSearch } from './search'
import {
  groupOpenTasks,
  isOpen,
  type Clock,
  type Journal,
  type Recurrence,
  type Task,
  type TaskGroup,
  type TaskOccurrence,
  type TaskSchedule,
} from './journal'

/**
 * Which list is showing. Open is where Tasks View opens, because a Task is
 * about what remains; Completed is a separate view rather than a filter over
 * the same one, and there is nothing else to choose between.
 */
export type TasksTab = 'open' | 'completed'

/**
 * What Tasks View has to show, once the core has been asked. One arm at a
 * time, which is what makes the screen either a list or a Search's results
 * and never both — see
 * docs/adr/0036-search-is-one-term-and-its-destination-is-what-changes.md.
 * The Open list carries its groups with it — the same Tasks, in the same
 * order, said in the four groups the window opens on. The Completed list has
 * none: it is one list, newest kept first. A Search's results have none
 * either: the groups are a shape for the whole of the Open list, not for an
 * arbitrary subset of it.
 */
export type TasksState =
  | { state: 'loading' }
  | {
      state: 'tasks'
      tasks: Task[]
      groups: TaskGroup[]
      /**
       * The Task Occurrences of every Task in the list that has any, by Task —
       * its expandable history, and the record that says whether Undo
       * Completion is still safe. Read with the list rather than when a
       * history is opened, so a row can offer the action without asking
       * again, and kept for a Task whose recurrence was stopped, because
       * stopping keeps what the Task already completed.
       */
      occurrences: Record<string, TaskOccurrence[]>
    }
  | { state: 'results'; term: string; tasks: Task[] }
  | { state: 'unreadable' }

/** Everything Tasks View renders, and the only thing it renders. */
export interface TasksSnapshot {
  showing: TasksTab
  tasks: TasksState
  /** What the reader has typed into the search field, and what it shows. */
  term: string
  /**
   * Whether a Search has taken the screen over — true from the keystroke that
   * reaches two characters until the term is cleared or the list moves, and
   * true whether or not the term matched anything. What Escape belongs to.
   */
  searching: boolean
  /**
   * A change the record refused, said in the app's voice rather than the
   * error's. Nothing until one fails, and gone again the moment one succeeds —
   * a list that reads as the user asked claims nothing.
   */
  problem: string | null
  /**
   * What macOS said about Task Alerts the last time it was asked in context —
   * nothing until a Task with a time has been saved. A denial is worth saying
   * once, where the user just asked for the Alert; Settings is where it stays
   * sayable afterwards.
   */
  alertRefusal: string | null
  /**
   * That the OS is not holding what the journal says it should — the last
   * reconciliation failed, and this window is the one with a screen to say so
   * on. Nothing until one fails, and gone again the moment one succeeds.
   */
  alertProblem: string | null
}

/** Where every session starts: nothing asked yet, so nothing to show. */
export const openingTasksSnapshot: TasksSnapshot = {
  showing: 'open',
  tasks: { state: 'loading' },
  term: '',
  searching: false,
  problem: null,
  alertRefusal: null,
  alertProblem: null,
}

export interface TasksSession {
  /** What a view would render right now. */
  snapshot(): TasksSnapshot
  /** The first read: the Open Tasks, which is where Tasks View opens. */
  open(): Promise<void>
  /**
   * The other list, or back again. Nothing else narrows either one. Also how
   * a Search ends: answering a result is this with the Task singled out, so
   * it inherits everything a move already does. The term stays in the field,
   * so asking again costs no retyping.
   */
  show(tab: TasksTab): Promise<void>
  /**
   * The Tasks are no longer what they were, and not because of anything this
   * window did: one was created in the Task Creation window, or changed in
   * another Tasks View. Re-reads whichever list is showing — unless a Search
   * is up, which holds still whatever arrives underneath it.
   */
  refresh(): Promise<void>
  /**
   * The term as it now reads, after every keystroke. Nothing is asked of the
   * journal until it has stood still for `SEARCH_DEBOUNCE_MS` and is at least
   * `SEARCH_MIN_TERM_LENGTH` long; a shorter term takes the results off the
   * screen and gives the list back. Resolves once the term it was given has
   * either landed or been overtaken, so a test can await it.
   */
  search(term: string): Promise<void>
  /**
   * How the reconciliation the capture window runs went. It is headless, so it
   * says it here: a failure never rolls a Task back, but the user is the only
   * one who can tell an Alert that is coming from one that is not.
   */
  reconciled(held: boolean): void
  /**
   * The Tasks are what they were, but the day has moved: local midnight, a
   * wake, or the window being looked at again. Re-groups what is already here,
   * without asking the database a question whose answer has not changed.
   */
  regroup(): void
  /**
   * One save from the Task Editor: the wording and the schedule together,
   * because the Editor commits both at once and a save that half landed would
   * leave the user unable to say which half.
   *
   * Saving a Task with a time is where the OS is asked to allow Task Alerts,
   * and only the first time — in context, never at launch. Whatever the answer,
   * the Task is saved: the record is authoritative and the Alert is derived
   * from it.
   */
  save(
    id: string,
    change: {
      description: string
      details?: string | null
      schedule: TaskSchedule | null
      recurrence?: Recurrence | null
    },
  ): Promise<boolean>
  complete(id: string): Promise<void>
  reopen(id: string): Promise<void>
  /**
   * Takes back the most recent completion of a Recurring Task, while that is
   * still safe. Refused rather than hidden when it is not: a list that moved
   * under the user between the offer and the click has to say so.
   */
  undoCompletion(id: string): Promise<void>
  /**
   * Removes the cadence and keeps the Task and its history. Confirmed by the
   * view rather than here — a session says what happened, not what to ask.
   */
  stopRecurrence(id: string): Promise<void>
  delete(id: string): Promise<void>
}

export function createTasksSession({
  journal,
  desktop,
  clock,
  onChange,
}: {
  /**
   * Handed in rather than imported, so a test can drive a real one. Awaited
   * rather than held: the app's journal opens a database before it exists, and
   * a session is built while that is still in flight.
   */
  journal: Promise<Journal>
  /**
   * Every change that lands is announced through it, so that no other Task
   * surface in the app — a second window, the Task Creation window, the
   * reconciliation that keeps macOS's pending Alerts true — is left on a list
   * that stopped being true. A change the record refused announces nothing:
   * nothing changed.
   */
  desktop: Desktop
  clock: Clock
  onChange: (snapshot: TasksSnapshot) => void
}): TasksSession {
  let snapshot = openingTasksSnapshot
  // Reads can overlap — a completion while a tab change is still in flight —
  // and only the newest one may reach the view.
  let latestRead = 0

  // The half of a Search Tasks View shares with History — the thresholds, the
  // debounce, which read may land — held in common rather than copied, so the
  // two cannot drift apart. What a settled term lands on stays here. See
  // `src/journal/search.ts`.
  const { search, abandonWaitingTerm } = createSearch({
    showTerm: (term, searching) => show({ term, searching }),
    run,
    stop: stopShowingResults,
  })

  function show(change: Partial<TasksSnapshot>): void {
    snapshot = { ...snapshot, ...change }
    onChange(snapshot)
  }

  /** Better than a window that never stops loading, and never a stale read. */
  function giveUp(error: unknown, ticket: number): void {
    console.error('could not read the Tasks', error)
    if (latestRead === ticket) show({ tasks: { state: 'unreadable' } })
  }

  /**
   * One list, asked of the core. The list on screen is never patched in place:
   * completing a Task moves it out of the Open list entirely, so what a change
   * leaves behind is a question for the record rather than for the array.
   */
  async function read(tab: TasksTab): Promise<void> {
    const ticket = ++latestRead
    try {
      const core = await journal
      const tasks =
        tab === 'open' ? await core.openTasks() : await core.completedTasks()
      // One read for the whole list rather than one per row: the histories
      // are wanted together, and a list that grew a query per Task would get
      // slower for the reason it got longer.
      const occurrences = await core.occurrencesOfEach(
        tasks.map((task) => task.id),
      )
      if (latestRead !== ticket) return
      show({
        tasks: {
          state: 'tasks',
          tasks,
          groups: tab === 'open' ? groupOpenTasks(tasks, clock.now()) : [],
          occurrences,
        },
      })
    } catch (error) {
      giveUp(error, ticket)
    }
  }

  /** One settled term, asked of the whole journal — both lists at once. */
  async function run(term: string): Promise<void> {
    const ticket = ++latestRead
    try {
      const core = await journal
      const tasks = await core.tasksMatching(term)
      // Newest read wins as everywhere else, and a result may only land while
      // it is still the term in the field: the reader typed on, or the list
      // moved, and either way this answers a question nobody is asking.
      if (latestRead !== ticket || !isStillAsking(term)) return
      show({ tasks: { state: 'results', term, tasks } })
    } catch (error) {
      giveUp(error, ticket)
    }
  }

  /**
   * Whether the question a read went to answer is still the one on screen: the
   * reader has neither typed on nor moved lists since it was asked.
   */
  function isStillAsking(term: string): boolean {
    return snapshot.searching && snapshot.term === term
  }

  /**
   * The screen back to the list it never stopped having. A Search still in
   * flight needs nothing done to it: the term has already changed, which is
   * what keeps it from landing.
   */
  function stopShowingResults(): Promise<void> {
    if (snapshot.tasks.state !== 'results') return Promise.resolve()
    return read(snapshot.showing)
  }

  /**
   * One change to the record, then the list as it now reads. A refused change
   * leaves a list that looks exactly as it would if the user had never asked,
   * so it has to say so: `refusal` is what did not happen, in the app's voice
   * rather than the error's.
   */
  async function change(
    refusal: string,
    make: (core: Journal) => Promise<unknown>,
  ): Promise<boolean> {
    let problem: string | null = null
    try {
      const core = await journal
      await make(core)
      await announce()
    } catch (error) {
      console.error('could not change the Task', error)
      problem = refusal
    }
    // Said whether or not it changed: a change that worked clears the one
    // before it, so no problem outlives the list it was about.
    show({ problem })
    // A change made here ends a Search the way moving lists does — and takes
    // its waiting term with it. The list is still on screen while a term waits
    // out its debounce, so a change in that window would otherwise have its
    // re-read invalidated by the timer firing: the timer takes a newer ticket
    // and then bails, and neither read lands. The term stays in the field.
    if (snapshot.searching) {
      abandonWaitingTerm()
      show({ searching: false })
    }
    await read(snapshot.showing)

    return problem === null
  }

  /**
   * A change that landed, said to every other Task surface. Never worth
   * failing a change over: the Task is already stored, and a window that did
   * not hear is a window one refresh behind.
   */
  async function announce(): Promise<void> {
    try {
      await desktop.announceTasksChanged()
    } catch (error) {
      console.error('could not announce the Task', error)
    }
  }

  /**
   * Asks the OS about Task Alerts, in context, and says so where the user just
   * asked for one. The rule about when to ask is shared with the Task Creation
   * window; all that belongs here is what the answer puts on screen.
   */
  async function askAboutAlerts(): Promise<void> {
    const answer = await askAboutTaskAlerts(desktop)
    // An OS that would not say what it allows is not something to accuse of
    // refusing: nothing is said, and Settings still reports the truth.
    if (answer !== 'unknown') {
      show({ alertRefusal: answer === 'refused' ? ALERT_REFUSED : null })
    }
  }

  return {
    snapshot: () => snapshot,

    open: () => read('open'),

    async show(tab) {
      // A problem is about the list it was raised over, and this is a
      // different one. Answering a result and moving lists are both this, so
      // both end the Search; the term stays in the field either way.
      abandonWaitingTerm()
      show({ showing: tab, searching: false, problem: null })
      await read(tab)
    },

    async refresh() {
      // A Search is the reader's question, and it is answered as it was asked:
      // results hold still whatever arrives underneath them.
      if (snapshot.searching) return

      await read(snapshot.showing)
    },

    /**
     * The term as it now reads, after every keystroke. Nothing is asked of the
     * journal until it has stood still for `SEARCH_DEBOUNCE_MS` and is at least
     * `SEARCH_MIN_TERM_LENGTH` long; a shorter term takes the results off the
     * screen and gives the list back. Resolves once the term it was given has
     * either landed or been overtaken, so a test can await it.
     */
    search,

    reconciled(held) {
      show({ alertProblem: held ? null : ALERTS_NOT_HELD })
    },

    regroup() {
      const { tasks } = snapshot
      if (tasks.state !== 'tasks' || snapshot.showing !== 'open') return

      show({
        tasks: {
          ...tasks,
          groups: groupOpenTasks(tasks.tasks, clock.now()),
        },
      })
    },

    async save(id, { description, details, schedule, recurrence }) {
      let timed = false

      const saved = await change(
        'That Task could not be saved.',
        async (core) => {
          const task = await core.editTask(id, {
            description,
            details,
            schedule,
            recurrence,
          })
          // Only an Open Task can have gained a time: a Completed one keeps
          // the schedule it was completed with, and asking macOS about an
          // Alert for a commitment already kept would make no sense.
          timed = isOpen(task) && schedule !== null && schedule.time !== null
        },
      )

      if (saved && timed) await askAboutAlerts()
      return saved
    },

    async complete(id) {
      await change('That Task could not be completed.', (core) =>
        core.completeTask(id),
      )
    },
    async reopen(id) {
      await change('That Task could not be reopened.', (core) =>
        core.reopenTask(id),
      )
    },
    async undoCompletion(id) {
      await change(
        'That completion could not be undone: only the latest one can be, and only while what it advanced to is untouched.',
        (core) => core.undoCompletion(id),
      )
    },
    async stopRecurrence(id) {
      await change('That recurrence could not be stopped.', (core) =>
        core.stopRecurrence(id),
      )
    },
    async delete(id) {
      await change('That Task could not be deleted.', (core) =>
        core.deleteTask(id),
      )
    },
  }
}
