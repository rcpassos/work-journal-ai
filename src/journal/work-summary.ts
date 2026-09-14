/**
 * The records a Work Summary is written from, and the one thing a model call
 * is sent.
 *
 * This is deliberately separate from the Journal core: the core already knows
 * how to read Notes and Tasks, while this cross-cuts its retrospective and
 * prospective axes. It is selection, not another SQL query — see
 * `CONTEXT.md` and docs/adr/0041-work-summary-combines-a-selected-period-with-current-commitments.md.
 */

import {
  formatDayRange,
  type CompletedOccurrence,
  type DayRange,
  type Digest,
  type Journal,
  type Task,
} from './journal'
import {
  completionsInRange,
  mergeCompletions,
  renderCompletedSection,
  taskBullet,
} from './completions'

export interface WorkSummarySelection {
  /** The first Journal Day of the selected range, inclusive. */
  from: string
  /** The last Journal Day of the selected range, inclusive. */
  to: string
  /**
   * The range's canonical Digest — the Notes half of the material, read with
   * the selection and carried in it. Counts, refusal, generation, and copy
   * all describe this same Digest, so Notes added or removed after the
   * selection was captured cannot mix with older Task data.
   */
  digest: Digest
  /**
   * Ordinary Tasks completed in the range, as the journal returns them. The
   * material renders them oldest completion first.
   */
  completedTasks: Task[]
  /**
   * Task Occurrences completed in the range, as the journal returns them,
   * each with the Recurring Task it belongs to. The parent is never completed
   * by this — it continues, and appears among the current Open Tasks. The
   * material renders them oldest completion first.
   */
  completedOccurrences: CompletedOccurrence[]
  /**
   * Every currently Open Task — overdue, today, future, and Unscheduled —
   * independently of the selected range. Current commitments, not history:
   * nothing here claims they were open during the range.
   */
  openTasks: Task[]
}

/**
 * Selects the complete input for a Work Summary: the chosen range's Notes
 * and completions, plus every currently Open Task. The range arrives chosen
 * — initially the This-week preset, Monday through today, and afterwards
 * whatever the view's own date-range control holds — so a window left open
 * over midnight keeps describing the range it opened in until the user moves
 * it. Selection never touches History's Filter and needs no Occupied Day: a
 * range of Tasks alone selects fine.
 */
export async function selectWorkSummary({
  journal,
  range: { from, to },
}: {
  journal: Journal
  range: DayRange
}): Promise<WorkSummarySelection> {
  const [digest, completedTasks, completedOccurrences, openTasks] =
    await Promise.all([
      journal.digest({ from, to }),
      journal.completedTasks(),
      journal.occurrencesKeptIn({ from, to }),
      journal.openTasks(),
    ])

  return {
    from,
    to,
    digest,
    ...completionsInRange({ completedTasks, completedOccurrences, from, to }),
    openTasks,
  }
}

/**
 * Whether a Generate would refuse without spending a call. The two halves are
 * the selected period — Notes, Tasks completed in it, and Task Occurrences
 * kept in it — and the current Open Tasks that stand on their own; only a
 * period with neither half is nothing to say. A kept recurring commitment is
 * real work, so a period whose only accomplishment is a completed occurrence
 * is not refused.
 */
export function workSummaryRefuses(selection: WorkSummarySelection): boolean {
  return (
    selection.digest.noteCount === 0 &&
    selection.completedTasks.length === 0 &&
    selection.completedOccurrences.length === 0 &&
    selection.openTasks.length === 0
  )
}

/**
 * Work Summary Material: the complete, lossless Markdown of the selected
 * range — the selection's own Digest verbatim, `#project` prefixes and all,
 * plus the work completed in it oldest-first — followed by every currently
 * Open Task explicitly identified as current. It is what a Work Summary is
 * written from, and what the user pastes instead when there is no Model
 * Access, the endpoint is down, or the prose came back wrong. See `CONTEXT.md`
 * and
 * docs/adr/0041-work-summary-combines-a-selected-period-with-current-commitments.md.
 *
 * Synchronous over the selection it is handed: everything it renders was read
 * together, so it always describes one selection and never a mix of an old
 * Task read with newer Notes. No second serialisation: a second format would
 * eventually describe a journal the user does not have.
 *
 * A section with nothing in it is left out entirely, so a period of
 * commitments alone carries no empty accomplishments heading, and vice versa.
 * A period with neither half reads as the clear empty result the section
 * refuses to send or copy.
 */
export function buildWorkSummaryMaterial(
  selection: WorkSummarySelection,
): string {
  const completions = mergeCompletions({
    completedTasks: selection.completedTasks,
    completedOccurrences: selection.completedOccurrences,
    order: 'oldest-first',
  })

  if (
    selection.digest.markdown === '' &&
    completions.length === 0 &&
    selection.openTasks.length === 0
  ) {
    return ''
  }

  const parts: string[] = [`# ${formatDayRange(selection.from, selection.to)}`]
  if (selection.digest.markdown !== '') parts.push(selection.digest.markdown)
  if (completions.length > 0) {
    parts.push(renderCompletedSection(completions, selection.from !== selection.to))
  }
  if (selection.openTasks.length > 0) {
    parts.push(
      `## Currently open\n${selection.openTasks
        .map((task) => taskBullet(task))
        .join('\n')}`,
    )
  }

  return parts.join('\n\n')
}
