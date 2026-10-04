import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ChangelogVersion } from '@/settings/changelog'
import { SettingsGroup, SettingsRow } from './SettingsGroup'

/**
 * What every version changed, from the changelog this build shipped with —
 * asked for whenever the user wants it, rather than only in the moment an
 * update was found. The version running is the one on screen without a press,
 * because "what did the app I have just been given do?" is the question this
 * group exists for; everything before it is a press away.
 *
 * Not a session and not a setting: the disclosure is the state of this view's
 * own control, which is where React keeps it. See
 * docs/adr/0025-a-session-is-for-sequencing-not-for-state.md.
 */
export default function ChangelogSettings({
  versions,
  running,
}: {
  versions: ChangelogVersion[]
  running: string
}) {
  const [earlier, setEarlier] = useState(false)

  if (versions.length === 0) return null

  // Where the running version sits in the file, and the top of it when this
  // build is not a released one — a dev build still answers the question, it
  // just answers it about the newest release it was cut after.
  const from = Math.max(
    versions.findIndex((entry) => entry.version === running),
    0,
  )
  const shown = earlier ? versions.slice(from) : versions.slice(from, from + 1)

  return (
    <SettingsGroup>
      <SettingsRow
        label="What's New"
        explanation="What each version of Work Journal changed, starting with the one running now."
      >
        {versions.length > from + 1 && (
          <Button
            variant="outline"
            size="sm"
            aria-expanded={earlier}
            onClick={() => setEarlier(!earlier)}
          >
            {earlier ? 'Hide earlier versions' : 'Earlier versions'}
          </Button>
        )}
      </SettingsRow>

      {shown.map((entry) => (
        <section
          key={entry.version}
          aria-label={`Work Journal ${entry.version}`}
          className="flex flex-col gap-0.5"
        >
          <h3 className="type-meta">
            {entry.version}
            {entry.date !== '' && ` — ${entry.date}`}
          </h3>
          <ul className="type-meta text-muted-foreground list-disc pl-4">
            {entry.notes.map((note, line) => (
              <li key={line}>{note}</li>
            ))}
          </ul>
        </section>
      ))}
    </SettingsGroup>
  )
}
