import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import ThemeProvider from './components/ThemeProvider.tsx'
import { createAppJournal } from './journal/app-journal.ts'
import { systemClock } from './journal/journal.ts'
import { createImportSession } from './journal/import-session.ts'
import { createObserveSession } from './journal/observe-session.ts'
import { createTaskAlertsSession } from './journal/task-alerts-session.ts'
import { createTrayCount } from './journal/tray-count.ts'
import { createTrayObserving } from './journal/tray-observing.ts'
import { createYesterdayDigest } from './journal/yesterday-digest.ts'
import { CAPTURE_WINDOW } from './platform/desktop.ts'
import { createTauriDesktop } from './platform/tauri-desktop.ts'
import { createAppSettings } from './settings/app-settings.ts'

// The composition root: the one place that says what everything is made of.
// Every window loads this same bundle, so the collaborators are built here
// once and the label decides which window renders.
const desktop = createTauriDesktop()
const settings = createAppSettings(desktop)

// A promise rather than an awaited value: the database opens after the first
// paint, and a Capture is typed into a window that is already on screen.
const journal = createAppJournal({ desktop })
// A journal that cannot be opened is reported by whichever view asks for it.
// This is only so that a window which never asks — Settings, unless the user
// exports — does not leave the failure unhandled.
journal.catch(() => {})

// Today's Captured Note count, beside the menu bar glyph. Kept by the capture
// window because that one is built at startup and only ever hidden, so it is
// the single window that lives exactly as long as the tray it writes to — the
// windows built on demand come and go, and none of them is open on the day
// this is meant to be noticed. It is never stopped: it ends when the app
// does.
if (desktop.windowLabel() === CAPTURE_WINDOW) {
  void createTrayCount({ journal, desktop, clock: systemClock })
    .start()
    // The count is a reminder, not the journal: a tray that cannot be written
    // to must not take the Capture down with it.
    .catch((error: unknown) => {
      console.error('could not keep the tray count', error)
    })

  // Today's meetings, swept into the journal as they end. Kept here for the
  // same reason as the count: this is the one window that lives as long as the
  // app, and a sweep has to keep happening while nothing is on screen.
  void createImportSession({ journal, desktop, settings, clock: systemClock })
    .start()
    // Import is an addition to the journal, never a condition of it: a sweep
    // that cannot run leaves everything else working exactly as before.
    .catch((error: unknown) => {
      console.error('could not import today’s meetings', error)
    })

  // The commits the user made in the repositories they listed, swept into the
  // journal the same way and kept here for the same reason.
  void createObserveSession({ journal, desktop, settings, clock: systemClock })
    .start()
    // Observing is an addition to the journal too: a repository that cannot
    // be read is a gap, never a condition of anything else working.
    .catch((error: unknown) => {
      console.error('could not observe commits', error)
    })

  // The OS's pending Task Alerts, kept equal to what the journal says. Here
  // for the same reason as the count: the reconciliation has to keep happening
  // while nothing is on screen, and this is the one window that lives as long
  // as the app. It never prompts — permission is asked for in the Task Editor,
  // when the user saves the first timed Task.
  void createTaskAlertsSession({ journal, desktop, clock: systemClock })
    .start()
    // A Task Alert is derived from a Task that is already stored: an OS that
    // will not hold one leaves every Task exactly as it was.
    .catch((error: unknown) => {
      console.error('could not reconcile the Task Alerts', error)
    })

  // Yesterday's Digest, copied from the Tray Menu. Kept here for the same
  // reason as the count: the Rust side owns the menu but cannot reach the
  // Notes, and this is the one window certain to be around to answer it.
  void createYesterdayDigest({ journal, desktop, clock: systemClock })
    .start()
    .catch((error: unknown) => {
      console.error("could not answer the Tray Menu's copy", error)
    })

  // The Tray Menu's Observing controls — pause and resume — answered here for
  // the same reason: the pause is an interval in the settings file, and this
  // window is the one that lives as long as the menu.
  void createTrayObserving({ settings, desktop, clock: systemClock })
    .start()
    .catch((error: unknown) => {
      console.error("could not answer the Tray Menu's pause", error)
    })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outside the theme, so that a provider that itself fails is still caught.
        The dark class is left on the document either way, so the fallback is
        painted to match whatever the window was already showing. */}
    <ErrorBoundary>
      <ThemeProvider settings={settings}>
        <App
          windowLabel={desktop.windowLabel()}
          desktop={desktop}
          settings={settings}
          journal={journal}
          clock={systemClock}
        />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
)
