/**
 * Reading back what you did, as a session rather than a screen: one Filter, the
 * list it resolves to, the Nudge a Note outside it leaves, and the Digest kept
 * ready for the clipboard. Every sequencing rule of reading back lives here —
 * what an arrival does, what a correction re-reads, which of two overlapping
 * reads may reach the view — so History is JSX over a snapshot.
 *
 * Headless on purpose: it is built from a Journal, a clipboard and one
 * announcement, and nothing else, so the rules can be driven end to end from a
 * test with real SQL and no DOM. It holds no domain rule of its own — those stay in the core, which this
 * module asks.
 *
 * A session is built per Main Window and is never reset: the window is
 * created on demand and genuinely closed on dismiss — see
 * docs/adr/0002-capture-window-is-hidden-never-closed.md.
 */

import {
  ANY_PROJECT,
  constraintOf,
  decideArrival,
  describeCopiedDigest,
  groupByJournalDay,
  projectName,
  rangeForJournalDay,
  type DayRange,
  type Digest,
  type Filter,
  type Journal,
  type JournalDayGroup,
  type Note,
  type ProjectConstraint,
} from './journal'
import {
  buildReviewMaterial,
  describeCopiedReviewMaterial,
  NOTHING_TO_REVIEW,
  REVIEW_PROJECT_RULE,
  reviewRefuses,
  selectReviewCompletions,
} from './review'
import { createSearch } from './search'

/**
 * What History has to show, once the core has been asked. One arm at a time,
 * which is what makes the screen either the Filter's list or a Search's
 * results and never both — see
 * docs/adr/0004-search-moves-the-filter-rather-than-narrowing-it.md.
 */
export type HistoryState =
  | { state: 'loading' }
  | { state: 'empty' }
  | { state: 'notes'; days: JournalDayGroup[] }
  | { state: 'results'; term: string; notes: Note[] }
  | { state: 'unreadable' }

/** Everything History renders, and the only thing it renders. */
export interface HistorySnapshot {
  /**
   * Both axes of what is being viewed. Null until the first read lands, and
   * whenever there are no Notes at all — the Project constraint outlives it
   * either way, so narrowing an empty journal still holds.
   */
  filter: Filter | null
  /**
   * Every Project currently on a Note, for the constraint picker to offer.
   * Journal-wide rather than Filter-wide: a picker that only listed what is
   * already in view would be a picker that cannot be used to leave it.
   */
  projects: string[]
  history: HistoryState
  /** What the reader has typed into the search field, and what it shows. */
  term: string
  /**
   * Whether a Search has taken the screen over — true from the keystroke that
   * reaches two characters until the term is cleared or the Filter moves, and
   * true whether or not the term matched anything. What Escape belongs to, and
   * why the copy control is not on screen: the Digest is bound to the Filter, so it
   * must not be offered beside something that is not one.
   */
  searching: boolean
  /** The day a Nudge is about; null when there is nothing to nudge about. */
  nudgedDay: string | null
  /**
   * How many Notes the held Digest holds — what `copy()` would write, so the
   * copy control's preview never describes anything else. Null until the
   * first read lands; a failed read leaves the held Digest, and its count,
   * exactly as they were.
   */
  noteCount: number | null
  /**
   * What the last copy did, said back to the reader so they know it worked
   * before they paste. Nothing until they copy, and until they move the Filter.
   */
  confirmation: string | null
  /**
   * A correction the record refused, said in the app's voice rather than the
   * error's. Nothing until one fails, and gone again the moment one succeeds or
   * the Filter moves — a list that reads as the reader asked claims nothing.
   */
  problem: string | null
}

/** Where every session starts: nothing asked yet, so nothing to show. */
export const openingSnapshot: HistorySnapshot = {
  filter: null,
  projects: [],
  history: { state: 'loading' },
  term: '',
  searching: false,
  nudgedDay: null,
  noteCount: null,
  confirmation: null,
  problem: null,
}

export interface HistorySession {
  /** What a view would render right now. */
  snapshot(): HistorySnapshot
  /** The first read: the most recent Occupied Day, or nothing to open on. */
  open(): Promise<void>
  /**
   * Every move of the Filter's day axis, and one of the two ways a Nudge is
   * cleared. Also how a Search ends: answering a result and answering a Nudge
   * are both this, so both inherit everything a move already does. The Project
   * constraint is not a day and is left exactly as the reader set it.
   */
  moveTo(range: DayRange): Promise<void>
  /**
   * The other axis, on its own: the same days, narrowed to one Project, to
   * Unfiled, or to nothing at all. Sticks for the session — the reader moves
   * it, and so does revealing a practice Note (which always shows Any) — and
   * takes the screen back to the Filter, since that is what it is about.
   */
  narrowTo(project: ProjectConstraint): Promise<void>
  /**
   * Shows one Journal Day with no Project constraint: the practice Note's day
   * as Onboarding reveals it, whatever the Filter said before. Both axes move
   * as one operation with a single read, so a day the reader picks while the
   * read is in flight still wins by the session's newest-read rule — two
   * separate moves would let the reveal's second half overwrite the reader's
   * newer choice.
   */
  reveal(journalDay: string): Promise<void>
  /**
   * The term as it now reads, after every keystroke. Nothing is asked of the
   * journal until it has stood still for `SEARCH_DEBOUNCE_MS` and is at least
   * `SEARCH_MIN_TERM_LENGTH` long; a shorter term takes the results off the
   * screen and gives the Filter's list back. Resolves once the term it was
   * given has either landed or been overtaken, so a test can await it.
   */
  search(term: string): Promise<void>
  /** A Note was captured, in this window or another one. */
  noteArrived(journalDay: string): Promise<void>
  /**
   * The Notes are no longer what they were, and not because the user typed
   * one: a sweep imported meetings or observed source events, or another
   * window corrected something. Re-reads what is on screen and never nudges —
   * a Nudge means "you wrote something on another day", which is a fact about
   * the user, and
   * an Import or Observe sweep is not the user; see
   * docs/adr/0010-notes-have-two-origins.md.
   */
  refresh(): Promise<void>
  /** The other way: the day gained content and the reader does not care. */
  dismissNudge(): void
  editBody(id: string, body: string): Promise<void>
  refile(id: string, journalDay: string): Promise<void>
  editProject(id: string, project: string | null): Promise<void>
  delete(id: string): Promise<void>
  /**
   * One Project into another, on every Note, wherever they are filed — then
   * the list, the Digest and the picker's options as they now read.
   *
   * The correction is the core's and the sequencing is here, as with every
   * other correction, with one rule of its own: a Filter narrowed to the
   * source Project must move to the target before the read, so the same
   * logical stream stays on screen under its new name rather than vanishing
   * into an empty list. The constraint is the session's, so the move is too —
   * no view has to know that a rename touched what it is reading.
   */
  renameProject(from: string, to: string): Promise<void>
  /**
   * The whole Filter on the clipboard. Deliberately not async: the Digest is
   * held from the read that drew the list, so what is copied is what the reader
   * is looking at rather than whatever the journal says a moment later — not,
   * any longer, because a clipboard write had to outrun an await; see
   * docs/adr/0012-the-os-writes-the-clipboard.md.
   */
  copy(): void
  /**
   * The Filter's Notes and the work completed in its days on the clipboard, as
   * one lossless document — see `review.ts`. Async because completions are
   * read when asked for rather than held: the ticket check below is what keeps
   * a read that lands after the Filter moved from copying the wrong days.
   *
   * Refuses under a named Project or Unfiled — completed work has no Project —
   * and refuses an empty range, in both cases writing nothing. Each
   * confirmation names which of the two copies landed, so the two actions
   * cannot be confused.
   */
  copyReviewMaterial(): Promise<void>
}

export function createHistorySession({
  journal,
  clipboard,
  announceChange,
  onChange,
}: {
  /**
   * Handed in rather than imported, so a test can drive a real one. Awaited
   * rather than held: the app's journal opens a database before it exists, and
   * a session is built while that is still in flight.
   */
  journal: Promise<Journal>
  clipboard: (text: string) => Promise<void>
  /**
   * Said after every correction that landed, so anything counting Notes
   * elsewhere in the app — the tray, in another window entirely — is not left
   * on a number that stopped being true. A correction the record refused says
   * nothing: nothing changed.
   */
  announceChange: () => void
  onChange: (snapshot: HistorySnapshot) => void
}): HistorySession {
  let snapshot = openingSnapshot
  // Reads can overlap — a Nudge acted on while a range change is still in
  // flight — and only the newest one may reach the view.
  let latestRead = 0
  // The Project axis, held for the session. History opens on Any, and only the
  // reader ever moves it — a Preset, a Search or an arrival moves days.
  let project: ProjectConstraint = ANY_PROJECT
  // The Filter as Markdown, kept ready for a copy. Read from the core with the
  // list, so what gets copied is never the list on screen.
  let digest: Digest | null = null
  // The Filter that Digest was read for. A move names the new Filter at once
  // while the read that draws it is still in flight, so the held Digest can
  // belong to the Filter the reader just left — a copy is of what was drawn,
  // and this is how it knows what that was.
  let digestFilter: Filter | null = null

  // The half of a Search History shares with Tasks View — the thresholds, the
  // debounce, which read may land — held in common rather than copied, so the
  // two cannot drift apart. What a settled term lands on stays here. See
  // `src/journal/search.ts`.
  const { search, abandonWaitingTerm } = createSearch({
    showTerm: (term, searching) => show({ term, searching }),
    run,
    stop: stopShowingResults,
  })

  function show(change: Partial<HistorySnapshot>): void {
    snapshot = { ...snapshot, ...change }
    onChange(snapshot)
  }

  /** Better than a window that never stops loading, and never a stale read. */
  function giveUp(error: unknown, ticket: number): void {
    console.error('could not read the journal', error)
    if (latestRead === ticket) show({ history: { state: 'unreadable' } })
  }

  async function read(filter: Filter): Promise<void> {
    const ticket = ++latestRead
    try {
      const core = await journal
      // The list and the Digest are the same Notes in opposite orders, and both
      // are asked of the core; the Projects on offer come with them, so the
      // picker names a stream the moment its first Note exists.
      const [notes, rendered, projects] = await Promise.all([
        core.notesForFilter(filter),
        core.digest(filter),
        core.projectsInUse(),
      ])
      if (latestRead !== ticket) return
      digest = rendered
      digestFilter = filter
      show({
        projects,
        history: { state: 'notes', days: groupByJournalDay(notes) },
        noteCount: rendered.noteCount,
      })
    } catch (error) {
      giveUp(error, ticket)
    }
  }

  /** Where History opens, and where it returns once the first Note exists. */
  async function open(): Promise<void> {
    const ticket = ++latestRead
    let opening: Filter | null
    try {
      const core = await journal
      // The Filter opens on the most recent Occupied Day, whenever that was;
      // with no Notes at all there is no day to open on.
      opening = await core.defaultRange()
      if (latestRead !== ticket) return
    } catch (error) {
      giveUp(error, ticket)
      return
    }

    if (opening === null) {
      show({ history: { state: 'empty' } })
      return
    }
    await moveTo(opening)
  }

  async function moveTo(range: DayRange): Promise<void> {
    // Answering a result or a Nudge ends the Search: the day it named is what
    // the reader asked to see. The term stays in the field, so asking again
    // costs no retyping.
    abandonWaitingTerm()
    const filter: Filter = { ...range, project }
    show({
      filter,
      searching: false,
      nudgedDay: null,
      // A confirmation is about the Filter that was copied, not this one; a
      // problem is about a Note in the list being left behind.
      confirmation: null,
      problem: null,
    })
    await read(filter)
  }

  /**
   * The Project axis moved, and only it. The days hold still, so a Nudge about
   * one of them is still unanswered and stays up; the Search ends, because what
   * this asks for is the Filter and a Search is not one.
   */
  async function narrowTo(constraint: ProjectConstraint): Promise<void> {
    project = constraint
    abandonWaitingTerm()

    // No Filter yet — an empty journal — so there is no list to narrow. The
    // constraint is held all the same, and the Filter that eventually opens
    // is already narrowed by it.
    if (snapshot.filter === null) return

    const filter: Filter = { ...snapshot.filter, project }
    show({ filter, searching: false, confirmation: null, problem: null })
    await read(filter)
  }

  /**
   * One Journal Day with no Project constraint, as a single move: what
   * revealing a practice Note asks for. The constraint is set before the one
   * read that draws the list, so there is no moment where the screen shows a
   * half-moved Filter — and a day the reader picks while that read is in
   * flight stays the newest read, so it wins.
   */
  async function reveal(journalDay: string): Promise<void> {
    project = ANY_PROJECT
    abandonWaitingTerm()
    const filter: Filter = {
      ...rangeForJournalDay(journalDay),
      project,
    }
    show({
      filter,
      searching: false,
      nudgedDay: null,
      confirmation: null,
      problem: null,
    })
    await read(filter)
  }

  /** One settled term, asked of the whole journal. */
  async function run(term: string): Promise<void> {
    const ticket = ++latestRead
    try {
      const core = await journal
      const notes = await core.notesMatching(term)
      // Newest read wins as everywhere else, and a result may only land while
      // it is still the term in the field: the reader typed on, or the Filter
      // moved, and either way this answers a question nobody is asking.
      if (latestRead !== ticket || !isStillAsking(term)) return
      show({ history: { state: 'results', term, notes } })
    } catch (error) {
      giveUp(error, ticket)
    }
  }

  /**
   * Whether the question a read went to answer is still the one on screen: the
   * reader has neither typed on nor moved the Filter since it was asked.
   */
  function isStillAsking(term: string): boolean {
    return snapshot.searching && snapshot.term === term
  }

  /**
   * The screen back to the Filter it never stopped having. A Search still in
   * flight needs nothing done to it: the term has already changed, which is
   * what keeps it from landing.
   */
  function stopShowingResults(): Promise<void> {
    if (snapshot.history.state !== 'results') return Promise.resolve()
    // Searched before the first read landed, so there is no Filter to go back
    // to yet: ask for the opening one rather than claiming an empty journal.
    if (snapshot.filter === null) return open()
    return read(snapshot.filter)
  }

  /**
   * One correction to the record, then the list as it now reads. A refiled Note
   * can leave the Filter and a deleted one is gone, so the list is re-read from
   * the core rather than patched in place.
   *
   * A refused correction leaves a list that looks exactly as it would if the
   * reader had never asked, so it has to say so: `refusal` is what did not
   * happen, in the app's voice rather than the error's.
   */
  async function correct(
    refusal: string,
    change: (core: Journal) => Promise<unknown>,
  ): Promise<void> {
    let problem: string | null = null
    try {
      const core = await journal
      await change(core)
      announceChange()
    } catch (error) {
      console.error('could not change the Note', error)
      problem = refusal
    }
    // Said whether or not it changed: a correction that worked clears the one
    // before it, so no problem outlives the list it was about.
    show({ problem })
    if (snapshot.filter !== null) await read(snapshot.filter)
  }

  return {
    snapshot: () => snapshot,
    open,
    moveTo,
    narrowTo,
    reveal,
    search,

    async noteArrived(journalDay) {
      // While a Search is showing there is no Filter on screen for a Note to
      // belong to, so it always nudges and the results hold still — the
      // reader's question is answered as it was asked.
      if (snapshot.searching) {
        show({ nudgedDay: journalDay })
        return
      }

      // No Notes at all until now: there is no Filter to hold still, and the
      // empty state has just stopped being true.
      if (snapshot.filter === null) {
        await open()
        return
      }

      const arrival = decideArrival(snapshot.filter, journalDay)
      if (arrival.kind === 'show') {
        await read(snapshot.filter)
      } else {
        show({ nudgedDay: arrival.journalDay })
      }
    },

    async refresh() {
      // A Search is the reader's question, and it is answered as it was asked:
      // results hold still whatever arrives underneath them.
      if (snapshot.searching) return

      // Nothing at all until now — the empty state has just stopped being true.
      if (snapshot.filter === null) {
        await open()
        return
      }

      await read(snapshot.filter)
    },

    dismissNudge() {
      show({ nudgedDay: null })
    },

    editBody: (id, body) =>
      correct('That Note could not be reworded.', (core) =>
        core.editBody(id, body),
      ),
    refile: (id, journalDay) =>
      correct('That Note could not be refiled.', (core) =>
        core.refile(id, journalDay),
      ),
    editProject: (id, project) =>
      correct("That Note's Project could not be changed.", (core) =>
        core.editProject(id, project),
      ),
    delete: (id) =>
      correct('That Note could not be deleted.', (core) => core.delete(id)),

    async renameProject(from, to) {
      // The constraint this call starts under, held so a refusal can put it
      // back — but only what this call itself moved, never a constraint the
      // reader has narrowed to while the core was still answering.
      const before = project
      // What this call moved the constraint to, if it has; the guard on
      // putting it back.
      let movedTo: ProjectConstraint | null = null
      let problem: string | null = null
      try {
        // Both names are normalized by the core's own rule — a constraint is
        // held as the core stores names, so comparing against anything else
        // would miss the stream it is narrowed to. Normalizing can itself
        // refuse, so it happens inside the try like everything else that can.
        const fromName = projectName(from)
        const toName = projectName(to)
        const same = fromName === toName
        // A Filter narrowed to the source moves to the target before the
        // read, so the same logical stream stays on screen under its new name
        // rather than vanishing into an empty list. The constraint is the
        // session's, so the move is too — no view has to know that a rename
        // touched what it is reading.
        if (project.kind === 'named' && project.name === fromName) {
          project = movedTo = { kind: 'named', name: toName }
        }
        if (!same) {
          const core = await journal
          await core.renameProject(from, to)
          announceChange()
        }
      } catch (error) {
        console.error('could not rename the Project', error)
        problem = 'That Project could not be renamed.'
        // A refused rename leaves the constraint it was refused under —
        // unless the reader has moved it meanwhile, which is theirs to move.
        if (movedTo !== null && project === movedTo) project = before
      }

      // A refusal leaves the screen exactly as it was — a Search included —
      // and says so; the problem goes the moment a rename works or the Filter
      // moves.
      if (problem !== null) {
        show({ problem })
        return
      }

      // The constraint may just have been moved to the target, and no list is
      // on screen when the journal has yet to hold a Note; either way this is
      // the ordinary act of narrowing, and everything it re-reads and ends.
      await narrowTo(project)
    },

    copy() {
      const copied = digest
      if (copied === null) return

      if (copied.noteCount === 0) {
        show({ confirmation: describeCopiedDigest(copied) })
        return
      }

      clipboard(copied.markdown).then(
        () => show({ confirmation: describeCopiedDigest(copied) }),
        (error: unknown) => {
          console.error('could not copy the Digest', error)
          show({ confirmation: 'Could not copy notes.' })
        },
      )
    },

    async copyReviewMaterial() {
      // The copy is of what was drawn: the held Digest, and the Filter it
      // was read for — the same Digest `copy()` would write, so the two can
      // never disagree about the Filter's Notes. Completions are the only
      // fresh read, taken for those same days.
      const held = digest
      const filter = digestFilter
      if (held === null || filter === null) return

      // Completed work has no Project: the action is disabled in the view,
      // and refused here for anything that asks regardless.
      if (constraintOf(filter).kind !== 'any') {
        show({ confirmation: REVIEW_PROJECT_RULE })
        return
      }

      const ticket = latestRead
      let completions
      try {
        const core = await journal
        completions = await selectReviewCompletions({ journal: core, filter })
      } catch (error) {
        console.error('could not read Review Material', error)
        if (latestRead === ticket && digest === held) {
          show({ confirmation: 'Could not copy notes + completed work.' })
        }
        return
      }
      // A read that lands after the Filter moved must not copy the wrong
      // days: the move's own read holds the newer ticket, and a landed read
      // replaces the held Digest — either way what was drawn is gone.
      if (latestRead !== ticket || digest !== held) return

      const selection = { filter, digest: held, ...completions }
      if (reviewRefuses(selection)) {
        show({ confirmation: NOTHING_TO_REVIEW })
        return
      }

      const material = buildReviewMaterial(selection)
      try {
        await clipboard(material.markdown)
        show({ confirmation: describeCopiedReviewMaterial(material) })
      } catch (error) {
        console.error('could not copy Review Material', error)
        show({ confirmation: 'Could not copy notes + completed work.' })
      }
    },
  }
}
