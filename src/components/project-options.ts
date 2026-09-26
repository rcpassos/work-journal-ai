/**
 * What a Project field offers as the user types into it, and the rule the
 * options are built by: the journal's own Predictions matched by prefix, a
 * name nothing has been filed under yet offered as itself, Unfiled as a value
 * like any other, and — where a surface has one — a name of its own to offer
 * first. Shared by every surface that files something under a Project, so the
 * same typing always offers the same choices: History's per-Note field and a
 * repository's Project Mapping field differ in chrome and never in the list.
 * See CONTEXT.md, "Prediction".
 */

import { useEffect, useState } from 'react'
import {
  formatProject,
  isProjectName,
  projectName,
  type Journal,
} from '@/journal/journal'

/**
 * One line of the Project list: a Project the journal already names, the name
 * being typed for the first time, or Unfiled — which is a value like any other
 * and so is chosen like one, rather than by emptying a field.
 */
export type ProjectOption =
  | { kind: 'unfiled'; key: string; label: string }
  | { kind: 'project'; key: string; label: string; name: string }

/** What has been typed, as a Project name: the display `#` is not part of it. */
export function projectPrefix(typed: string): string {
  return typed.trim().replace(/^#/, '')
}

/**
 * The Predictions as a field is typed into — the journal's own, so a name
 * offered here is one a Capture could have been offered. A null prefix is a
 * field nobody is typing into, and asks the journal nothing. What comes back
 * is read for the prefix given and no other: a list answering an earlier
 * prefix would show one field another's choices.
 */
export function useProjectPredictions(
  journal: Promise<Journal>,
  prefix: string | null,
): string[] {
  const [read, setRead] = useState<{ prefix: string; names: string[] } | null>(
    null,
  )

  useEffect(() => {
    if (prefix === null) return

    let cancelled = false
    void (async () => {
      const names = await (await journal).projectPredictions(prefix)
      if (!cancelled) setRead({ prefix, names })
    })()

    return () => {
      cancelled = true
    }
  }, [journal, prefix])

  return read !== null && read.prefix === prefix ? read.names : NOTHING
}

const NOTHING: string[] = []

/**
 * The list under a Project field. Unfiled is offered only while nothing has
 * been typed — once the reader is naming a Project they are not looking for
 * the absence of one — and a new name is offered only when no Prediction
 * already is it, so the same Project is never on screen twice. A name is
 * always shown as it is stored: identity is case-insensitive and lowercase,
 * and a list that showed it any other way would be showing another name.
 *
 * `suggestion` is a name the surface has of its own — a repository's own name
 * beside its mapping — offered first and never inferred: it is one line of
 * the list like any other, and becomes a Project only if the user picks or
 * types it. First even once the journal names it too, because it is still the
 * first thing this field is offering. Only a name the record would take is
 * ever offered, whether suggested or typed: a list holding a choice that
 * cannot be made is not a list of choices.
 */
export function projectOptions(
  prefix: string,
  predictions: string[],
  filed: string | null,
  suggestion: string | null = null,
): ProjectOption[] {
  const options: ProjectOption[] = []

  if (prefix === '' && filed !== null) {
    options.push({ kind: 'unfiled', key: 'unfiled', label: formatProject(null) })
  }

  const first =
    suggestion !== null && isProjectName(suggestion)
      ? projectName(suggestion)
      : null
  const names =
    first !== null && first.startsWith(prefix.toLowerCase())
      ? [first, ...predictions.filter((name) => name !== first)]
      : [...predictions]

  for (const name of names) {
    options.push({ kind: 'project', key: name, label: formatProject(name), name })
  }

  const known = names.some(
    (name) => name.toLowerCase() === prefix.toLowerCase(),
  )
  if (!known && isProjectName(prefix)) {
    const name = projectName(prefix)
    options.push({
      kind: 'project',
      key: `new:${name}`,
      label: formatProject(name),
      name,
    })
  }

  return options
}
