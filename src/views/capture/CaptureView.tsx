import { useCallback, useEffect, useRef, useState } from 'react'
import ProjectChip from '@/components/ProjectChip'
import KeyHint from '@/components/KeyHint'
import {
  applyPrediction,
  decideKeystroke,
  markerPrefix,
  type Journal,
  type KeystrokeDecision,
} from '@/journal/journal'
import {
  CAPTURE_FIELD_HEIGHT,
  CAPTURE_HAIRLINE,
  CAPTURE_PANEL_BORDER,
  CAPTURE_PREDICTION_ROW,
  CAPTURE_REFUSAL_HEIGHT,
  CAPTURE_SHADOW_GUTTER,
  type Desktop,
  type PracticeEnded,
} from '@/platform/desktop'

/**
 * One line, one keystroke. The window behind this view is created at startup
 * and only ever shown and hidden, so the view clears itself rather than
 * relying on a fresh React tree — on the Capture ending, never on the window
 * being shown, since the window is also put away to make room for Task
 * Creation with a Body still half-typed in it.
 *
 * While a Project Marker is open, Predictions drawn from Projects already on
 * Notes sit under the field. Choosing one fills the marker; typing a new name
 * and committing still works with no list required.
 *
 * Nothing here is rendered into a portal, and nothing here may be: the window
 * is transparent, undecorated and only as tall as this view asks for, so
 * anything drawn outside the panel is clipped by the window's own edge.
 */
export default function CaptureView({
  desktop,
  journal,
}: {
  desktop: Desktop
  journal: Promise<Journal>
}) {
  const [body, setBody] = useState('')
  // How many times this Capture has been refused. Zero until one is, and zero
  // again when the next Capture begins — a window that stayed open claims
  // nothing on its own. Counted rather than flagged so a second refusal is a
  // second thing on screen: the message invites another Enter, and one that
  // changed nothing would read as the silence it replaced.
  const [refusals, setRefusals] = useState(0)
  // Offered names for the open marker; empty when the marker is closed is
  // derived below so the effect that loads them never has to clear on close.
  const [offered, setOffered] = useState<string[]>([])
  const [highlight, setHighlight] = useState(0)
  const field = useRef<HTMLInputElement>(null)
  const prefix = markerPrefix(body)
  const predictions = prefix === null ? [] : offered
  // Whether this showing was raised for Onboarding practice, as the last
  // shown announcement said. A practice ending goes away through its own
  // dismiss — returning focus to the Main Window and reporting its outcome —
  // while an ordinary one hands focus back as before.
  const practiceRaised = useRef(false)
  // Synchronous across submission events, through announcements and dismissal.
  // A new showing can keep its Draft while an older save finishes.
  const submitting = useRef(false)
  const showing = useRef(0)

  // A Capture never inherits the last one: a Draft is nothing, so ending one
  // leaves exactly the empty window the next one begins in. Ending it is the
  // only thing that clears it — see the window being shown, below.
  const reset = useCallback(() => {
    showing.current += 1
    setBody('')
    setRefusals(0)
    setOffered([])
    setHighlight(0)
  }, [])

  const dismiss = useCallback(async () => {
    reset()
    await desktop.dismissCapture()
  }, [desktop, reset])

  /**
   * Ends this showing as a practice ending: goes away through the practice
   * dismiss, which returns focus to the Main Window and reports the outcome
   * for the attempt holding it. A showing reports exactly once, however it
   * ends — the dismissal carries the outcome, so the two cannot split. The
   * marker is cleared here rather than left for the next showing to correct,
   * so nothing read between the dismissal and that showing can mistake this
   * ended attempt for an open one.
   */
  const dismissPractice = useCallback(
    async (ended: PracticeEnded) => {
      practiceRaised.current = false
      reset()
      await desktop.dismissPracticeCapture(ended)
    },
    [desktop, reset],
  )

  /** Ends this showing, routing a practice ending through its own dismiss. */
  const endShowing = useCallback(
    async (ended: PracticeEnded | null) => {
      if (ended !== null && practiceRaised.current) {
        await dismissPractice(ended)
      } else {
        await dismiss()
      }
    },
    [dismiss, dismissPractice],
  )

  const commit = useCallback(
    async (text: string) => {
      if (submitting.current) return
      submitting.current = true
      const submittedShowing = showing.current
      try {
        let note
        try {
          note = await (await journal).capture(text)
        } catch (error) {
          // A Capture that could not be stored must not vanish: leave the window
          // open with the Body still in it rather than discarding the thought —
          // and say so, since a window that merely stayed open reads as a missed
          // keystroke.
          console.error('could not commit the Note', error)
          if (showing.current === submittedShowing) {
            setRefusals((refused) => refused + 1)
          }
          return
        }

        // Neither a Main Window on screen nor the tray count has any other
        // way to learn of the Note, and the announcements have to leave before
        // the window goes. Two of them because they say different things: one
        // names the day a reader's Filter may want, the other only that a count
        // taken before it is now stale. Made independently, so one that fails
        // does not take the other down with it, and neither is the Capture's
        // problem: the Note is stored either way.
        if (note !== null) {
          const announcements = await Promise.allSettled([
            desktop.announceCapturedNote(note.journalDay),
            desktop.announceJournalChanged(),
          ])
          for (const announcement of announcements) {
            if (announcement.status === 'rejected') {
              console.error('could not announce the Note', announcement.reason)
            }
          }
        }

        if (showing.current !== submittedShowing) return

        // An empty commit stores nothing, so for practice it ends the attempt
        // as a cancellation; an ordinary empty commit just goes away.
        const raised = practiceRaised.current
        await endShowing(
          !raised
            ? null
            : note === null
              ? { outcome: 'cancelled' }
              : { outcome: 'submitted', journalDay: note.journalDay },
        )
      } finally {
        submitting.current = false
      }
    },
    [desktop, journal, endShowing],
  )

  const choosePrediction = useCallback((name: string) => {
    const next = applyPrediction(name)
    setBody(next)
    setOffered([])
    setHighlight(0)
    // After the fill, the cursor sits ready for the Body.
    requestAnimationFrame(() => {
      const input = field.current
      if (input === null) return
      input.focus()
      input.setSelectionRange(next.length, next.length)
    })
  }, [])

  useEffect(() => {
    // The page behind the window has to give way to the rounded corners drawn
    // below; only this window's document is marked, since the bundle is shared.
    document.body.classList.add('capture-window')

    field.current?.focus()

    // Shown again after having been hidden: take focus, and change nothing
    // else. A window is put away either by a dismiss, which has already
    // cleared it, or by the other Entry Point being invoked, which must leave
    // the half-typed Body exactly where the user left it.
    //
    // The showing also says whether it is practice. A practice showing
    // displaced by an ordinary one — put away for something else, then raised
    // again ordinarily — ends the practice attempt it displaced as cancelled:
    // announced, never dismissed, since the window has just been shown and
    // whatever is half-typed in it belongs to the ordinary showing now.
    const shown = desktop.onCaptureShown((practice) => {
      showing.current += 1
      if (!practice && practiceRaised.current) {
        practiceRaised.current = false
        void desktop.announcePracticeEnded({ outcome: 'cancelled' })
      } else {
        practiceRaised.current = practice
      }
      field.current?.focus()
    })
    // Clicking away is a discard, not a Capture left floating over the screen.
    // Unless the window is already gone: another Work Journal window was
    // invoked — the other resident panel, or the Main Window — the Rust side
    // put this one away, and what is half-typed here is waiting for the next
    // time rather than being thrown away behind the user's back.
    const blurred = desktop.onWindowBlurred(() => {
      void desktop.isWindowVisible().then((visible) => {
        if (visible) {
          void endShowing(
            practiceRaised.current ? { outcome: 'cancelled' } : null,
          )
        }
      })
    })

    return () => {
      showing.current += 1
      document.body.classList.remove('capture-window')
      void shown.then((stop) => stop())
      void blurred.then((stop) => stop())
    }
  }, [desktop, endShowing])

  useEffect(() => {
    if (prefix === null) {
      return
    }

    let cancelled = false

    void (async () => {
      const names = await (await journal).projectPredictions(prefix)
      if (cancelled) return
      setOffered(names)
      setHighlight(0)
    })()

    return () => {
      cancelled = true
    }
  }, [prefix, journal])

  // Everything under the field grows the window rather than sharing the field's
  // room, so the size is a function of what is on screen rather than something
  // each caller has to remember to ask for.
  //
  // Fitting the window is the window's business, not the Note's: a Capture that
  // could not resize still holds everything the user typed and still commits
  // it. So a failure is logged and goes no further — but it is logged, because
  // the only symptom is a window of the wrong size, which reads as a layout bug
  // rather than the denied call it is.
  useEffect(() => {
    desktop
      .fitCapture({ predictions: predictions.length, refused: refusals > 0 })
      .catch((error: unknown) => {
        console.error('could not fit the Capture window', error)
      })
  }, [desktop, predictions.length, refusals])

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (predictions.length > 0 && prefix !== null) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((index) => (index + 1) % predictions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight(
          (index) => (index - 1 + predictions.length) % predictions.length,
        )
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        choosePrediction(predictions[highlight] ?? predictions[0])
        return
      }
      // Enter on a bare marker fills the Prediction rather than committing
      // nothing; once a Body is typed, prefix is null and commit runs as usual.
      if (event.key === 'Enter') {
        event.preventDefault()
        choosePrediction(predictions[highlight] ?? predictions[0])
        return
      }
    }

    void act(decideKeystroke(event.key, body))
  }

  async function act(decision: KeystrokeDecision) {
    if (decision === 'commit') {
      await commit(body)
    } else if (decision === 'discard') {
      // Escape abandons: for practice that ends the attempt as a
      // cancellation, otherwise the window just goes away.
      await endShowing(
        practiceRaised.current ? { outcome: 'cancelled' } : null,
      )
    }
  }

  return (
    // The window is larger than the panel on every side: the drop shadow is
    // drawn here rather than by the OS, and a window sized to the panel would
    // clip it. The margin that leaves is transparent, so a press landing in it
    // is a press outside the panel — a discard, exactly as a press on the
    // desktop behind would have been.
    <div
      className="flex h-screen flex-col"
      style={{ padding: CAPTURE_SHADOW_GUTTER }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          void endShowing(
            practiceRaised.current ? { outcome: 'cancelled' } : null,
          )
        }
      }}
    >
      {/* The corners are rounded here rather than on the field: the field all
          but fills the panel, so this is the shape the user sees. Predictions
          sit under the field when a marker is open; the window grows to fit
          them, and to fit a refusal under those.

          The shadow reaches at most `CAPTURE_SHADOW_GUTTER` past the panel —
          offset plus blur less spread — because past that the window clips it.
          It is heavier in the dark palette, where a near-black shadow on a
          dark desktop would otherwise say nothing.

          Never shrinks: the window is resized to fit this panel, and in the
          moment before that lands the field must keep its whole height rather
          than squeeze the line being typed. */}
      <div
        style={{ borderWidth: CAPTURE_PANEL_BORDER }}
        className="flex shrink-0 flex-col overflow-hidden rounded-2xl border-border bg-background shadow-[0_12px_24px_-4px_rgb(0_0_0/0.28),0_2px_8px_-2px_rgb(0_0_0/0.16)] dark:shadow-[0_12px_24px_-4px_rgb(0_0_0/0.6),0_2px_8px_-2px_rgb(0_0_0/0.45)]"
      >
        <div className="relative shrink-0">
          <input
            ref={field}
            type="text"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label="What did you just do?"
            placeholder="What did you just do?"
            aria-describedby={
              refusals > 0 ? `${BARGAIN_ID} ${PROBLEM_ID}` : BARGAIN_ID
            }
            aria-autocomplete="list"
            aria-controls={predictions.length > 0 ? PREDICTIONS_ID : undefined}
            aria-expanded={predictions.length > 0}
            autoComplete="off"
            spellCheck={false}
            // The ring is drawn inside: the field all but fills the panel, and
            // an outset one would be clipped by the panel's own edge. The right
            // padding is the room the bargain takes, with enough over for a
            // wider font than the one this was measured in.
            style={{ height: CAPTURE_FIELD_HEIGHT }}
            className="w-full rounded-2xl bg-transparent pl-5 pr-52 type-field outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
          />
          {/*
            What Return and Escape are worth, said where they are being pressed
            — the window otherwise teaches neither. Described to the field as
            well as drawn beside it, so it reaches a reader who never sees it,
            and unclickable, because reading it is all it is for.
          */}
          <div
            id={BARGAIN_ID}
            className="pointer-events-none absolute inset-y-0 right-5 flex select-none items-center gap-3 type-micro text-muted-foreground/70"
          >
            <KeyHint glyph="↵" reading="Return commits." what="commits" />
            <KeyHint glyph="esc" reading="Escape abandons." what="abandons" />
          </div>
        </div>
        {predictions.length > 0 && (
          <>
            {/* Inset rather than a rule across the panel: the Predictions
                belong to the field above them, and a full-width line would cut
                the panel in two. */}
            <div
              style={{ height: CAPTURE_HAIRLINE }}
              className="mx-5 shrink-0 bg-border"
              aria-hidden="true"
            />
            <ul
              id={PREDICTIONS_ID}
              role="listbox"
              aria-label="Project Predictions"
              className="flex flex-col"
            >
              {predictions.map((name, index) => (
                <li key={name} role="option" aria-selected={index === highlight}>
                  <button
                    type="button"
                    // mousedown: click would blur the field first and risk a
                    // window-blur discard before the choice lands.
                    onMouseDown={(event) => {
                      event.preventDefault()
                      choosePrediction(name)
                    }}
                    style={{ height: CAPTURE_PREDICTION_ROW }}
                    className={
                      index === highlight
                        ? 'flex w-full items-center px-5 text-left type-body bg-accent text-accent-foreground'
                        : 'flex w-full items-center px-5 text-left type-body hover:bg-accent/50'
                    }
                  >
                    <ProjectChip project={name} />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {/*
          A fixed height under everything else, and the window grows by exactly
          that much: the Body the user is being told about keeps the whole field
          and stays editable.

          Keyed by the count so each refusal is a new node: a repeated one is
          then announced again rather than passing as the same message still
          sitting there.
        */}
        {refusals > 0 && (
          <p
            key={refusals}
            id={PROBLEM_ID}
            role="alert"
            style={{ height: CAPTURE_REFUSAL_HEIGHT }}
            className="flex shrink-0 items-center px-5 type-meta text-destructive"
          >
            {CAPTURE_REFUSED}
          </p>
        )}
      </div>
    </div>
  )
}


const PROBLEM_ID = 'capture-problem'
const BARGAIN_ID = 'capture-bargain'
const PREDICTIONS_ID = 'capture-predictions'

/**
 * What a refused Capture says, in the app's voice rather than the error's. Names
 * what did not happen and what to do about it, because a window that stayed open
 * has already told the user that pressing Enter changed nothing.
 */
const CAPTURE_REFUSED = 'That Note could not be stored. Press Enter to retry.'
