/**
 * Review Material: the Filter's Notes and the work completed in the Filter's
 * days as one lossless Markdown document — the third lossless rendering,
 * beside the Digest and Work Summary Material. It embeds the Filter's Digest
 * verbatim and adds a Completed section, so the two can never disagree about
 * the Filter's Notes. See `CONTEXT.md` and
 * docs/adr/0034-review-material-is-a-third-lossless-rendering.md.
 *
 * Retrospective only: completed Tasks and completed Task Occurrences, never
 * Open Tasks — that axis belongs to Work Summary Material. No model call, no
 * network, no waiting; the prose written from this document is #162's Review
 * Brief.
 *
 * Selection is explicit and deterministic: Notes stay in Digest order, and
 * completions — both record types as one set — run oldest-first with a stable
 * ID tie-break, via the shared `mergeCompletions`.
 */

import {
  formatDayRange,
  plural,
  type CompletedOccurrence,
  type Digest,
  type Filter,
  type Journal,
  type Task,
} from './journal'
import {
  completionsInRange,
  mergeCompletions,
  renderCompletedSection,
} from './completions'

/** Everything Review Material is built from, read from the journal at once. */
export interface ReviewSelection {
  /** The Filter this material is about. Only offered under Any (see below). */
  filter: Filter
  /** The Filter's Notes, in the journal's canonical rendering. */
  digest: Digest
  /** Ordinary Tasks completed in the Filter's days. */
  completedTasks: Task[]
  /**
   * Task Occurrences completed in the Filter's days, each with the Recurring
   * Task it belongs to. The parent is never completed by this — it continues.
   */
  completedOccurrences: CompletedOccurrence[]
}

/** Review Material as Markdown, with what went into it. */
export interface ReviewMaterial {
  /** One lossless document: heading, Digest verbatim, then Completed. */
  markdown: string
  /** Exactly the number of Note bullets in `markdown`. */
  noteCount: number
  /** Exactly the number of completion bullets in `markdown`. */
  completionCount: number
}

/**
 * The work completed in one Filter's days: ordinary Tasks and Task
 * Occurrences, each kept only when its completion falls in the range.
 */
export interface ReviewCompletions {
  /** Ordinary Tasks completed in the Filter's days. */
  completedTasks: Task[]
  /**
   * Task Occurrences completed in the Filter's days, each with the Recurring
   * Task it belongs to. The parent is never completed by this — it continues.
   */
  completedOccurrences: CompletedOccurrence[]
}

/**
 * Selects the work completed in one Filter's days. Reads
 * `occurrencesKeptIn` for the range alongside `completedTasks()`, keeping
 * ordinary Tasks whose Task Completed At falls inclusively between
 * `filter.from` and `filter.to` — the range read already bounds occurrences
 * the same way, and both are narrowed to the local Journal Day so a
 * completion just after local midnight lands with the day it belongs to.
 *
 * Notes are deliberately not read here: the session holds the canonical
 * Digest from the read that drew the list, and Review Material embeds that
 * Digest verbatim — a second read could describe a journal the reader is no
 * longer looking at, which is the one disagreement ADR 0034 forbids.
 *
 * Only called under Project Any: a Task is never filed under a Project, so a
 * named Project or Unfiled has no completed work to select. The session
 * refuses those before asking; this function reads whatever Filter it is
 * handed.
 */
export async function selectReviewCompletions({
  journal,
  filter,
}: {
  journal: Journal
  filter: Filter
}): Promise<ReviewCompletions> {
  const [completedTasks, completedOccurrences] = await Promise.all([
    journal.completedTasks(),
    journal.occurrencesKeptIn({ from: filter.from, to: filter.to }),
  ])

  return completionsInRange({
    completedTasks,
    completedOccurrences,
    from: filter.from,
    to: filter.to,
  })
}

/** Whether there is nothing to copy: neither Notes nor completions. */
export function reviewRefuses(selection: ReviewSelection): boolean {
  return (
    selection.digest.noteCount === 0 &&
    selection.completedTasks.length === 0 &&
    selection.completedOccurrences.length === 0
  )
}

/**
 * Why the action is refused under a named Project or Unfiled: a Task is never
 * filed under a Project, so completed work has no Project to narrow to. Said
 * by the disabled action as well as by the session that refuses the copy.
 */
export const REVIEW_PROJECT_RULE =
  'Completed work has no Project, so this is only offered for Any Project.'

/** What an empty range says back: nothing was written to the clipboard. */
export const NOTHING_TO_REVIEW = 'No notes or completed work to copy.'

/**
 * What a landed Review Material copy says back, naming which of the two
 * copies it was. Counts ride along so the reader knows it worked before they
 * paste; a half with nothing in it is left out rather than counted as zero.
 */
export function describeCopiedReviewMaterial(
  material: ReviewMaterial,
): string {
  const counted = [
    material.noteCount > 0 ? plural(material.noteCount, 'note') : null,
    material.completionCount > 0
      ? plural(material.completionCount, 'completion')
      : null,
  ].filter((part) => part !== null)

  return `Copied notes + completed work (${counted.join(', ')}).`
}

/**
 * Review Material as one Markdown document: one top-level heading naming the
 * range, the Filter's Digest verbatim, then a Completed section day-grouped
 * under the same headings when the range spans more than one day. A section
 * with nothing in it is left out entirely, so a range of completed work alone
 * carries no empty Notes — and a range with neither half reads as the clear
 * empty result the session refuses to write.
 */
export function buildReviewMaterial(
  selection: ReviewSelection,
): ReviewMaterial {
  const { filter, digest } = selection
  // Two locale policies in one document, deliberately. The heading below
  // names the range in the Filter control's own words — machine locale, like
  // the control — while the day headings further down render journal content
  // in the Digest's pinned `en-GB` — like the Digest. Each half matches its
  // source of truth: the control about which range this is, the Digest about
  // which days its Notes fall under. Pinning the heading would break the
  // first sameness on a non-English machine; localizing the day headings
  // would break the second everywhere. See ADR 0034.
  const heading = `# ${formatDayRange(filter.from, filter.to)}`
  const completions = mergeCompletions({
    completedTasks: selection.completedTasks,
    completedOccurrences: selection.completedOccurrences,
    order: 'oldest-first',
  })

  if (digest.noteCount === 0 && completions.length === 0) {
    return {
      markdown: `${heading}\n\nNothing to review in these days.`,
      noteCount: 0,
      completionCount: 0,
    }
  }

  const parts: string[] = [heading]
  if (digest.markdown !== '') parts.push(digest.markdown)
  if (completions.length > 0) {
    parts.push(renderCompletedSection(completions, filter))
  }

  return {
    markdown: parts.join('\n\n'),
    noteCount: digest.noteCount,
    completionCount: completions.length,
  }
}
