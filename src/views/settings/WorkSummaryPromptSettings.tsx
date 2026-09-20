import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useOnScreenToast } from '@/components/on-screen-toast'
import { DEFAULT_WORK_SUMMARY_PROMPT } from '@/settings/settings'
import type { AppSettings } from '@/settings/app-settings'
import type { SettingsInitialState } from './SettingsInitialState'
import {
  SettingsAside,
  SettingsGroup,
  SettingsProblem,
  SettingsRow,
  notStored,
} from './SettingsGroup'
import { saySettled } from './saySettled'

/**
 * The preferences a Work Summary is written under, as the user's — plain
 * text in the settings file beside the rest, because a prompt is voice rather
 * than a secret. It lives here rather than beside the summary it produced:
 * editing a prompt next to one week's summary invites tuning it against that
 * week, which is how you end up with a prompt that only works on Tuesdays.
 *
 * Voice and structure only: which records a summary describes is the
 * section's selection, and no customization here redefines it or turns an
 * inference into a recorded fact.
 *
 * Empty means the default, not silence. A cleared field is written as the
 * empty string, `readSettings` reads it back as the shipped prompt, and a
 * model is never asked under an empty system prompt — see issue #133.
 */
export default function WorkSummaryPromptSettings({
  settings,
  initialSettings,
}: {
  settings: AppSettings
  initialSettings: Promise<SettingsInitialState | null> | null
}) {
  // The prompt as it stands, starting at the shipped one. Seeded from the
  // stored value by the same coordinated read every group shares, and never
  // over what the user has already typed.
  const [workSummaryPrompt, setWorkSummaryPrompt] = useState(
    DEFAULT_WORK_SUMMARY_PROMPT,
  )
  // Whether the store would not take the last write. Said rather than rolled
  // back: the field is text the user is still typing, and putting an older
  // value back under the cursor would throw away the keystrokes since.
  const [unsaved, setUnsaved] = useState(false)
  const typedIn = useRef(false)
  // A keystroke is a save here, and the field cannot say so; the toast with
  // the prompt's name replaces itself rather than stacking one per keystroke.
  const says = useOnScreenToast()

  useEffect(() => {
    if (initialSettings === null) return

    void initialSettings.then((initial) => {
      if (initial === null) return

      // A field nobody has touched, and only that.
      if (!typedIn.current)
        setWorkSummaryPrompt(initial.stored.workSummaryPrompt)
    })
  }, [initialSettings])

  function change(next: string) {
    typedIn.current = true
    setWorkSummaryPrompt(next)
    saySettled(says, settings.saveWorkSummaryPrompt(next), {
      id: 'work-summary-prompt',
      saved: 'Work Summary Prompt saved.',
      couldNot: 'Could not save the Work Summary Prompt.',
      what: 'could not change the Work Summary Prompt',
      onSaved: () => setUnsaved(false),
      onRefused: () => setUnsaved(true),
    })
  }

  /**
   * The shipped prompt back, whatever the field holds now. The same change as
   * any other — the explicit click counts as a keystroke, so a read still on
   * its way must not seed an older value over it — only with the default as
   * the value.
   */
  function restoreDefault() {
    change(DEFAULT_WORK_SUMMARY_PROMPT)
  }

  return (
    <SettingsGroup>
      <SettingsRow
        label="Work Summary Prompt"
        explanation="What voice and structure a Work Summary is written with."
        controls="work-summary-prompt"
        stacked
      >
        <div className="flex w-full flex-col items-end gap-2">
          <Textarea
            id="work-summary-prompt"
            className="w-full"
            value={workSummaryPrompt}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => change(event.target.value)}
          />
          <Button variant="outline" size="sm" onClick={restoreDefault}>
            Restore Default
          </Button>
        </div>
      </SettingsRow>

      <SettingsAside>
        Factual-grounding rules are always sent with it and cannot be edited
        out. Left empty, the shipped voice is used — a model is never asked
        nothing.
      </SettingsAside>

      {unsaved && (
        <SettingsProblem>{notStored('Work Summary Prompt')}</SettingsProblem>
      )}
    </SettingsGroup>
  )
}
