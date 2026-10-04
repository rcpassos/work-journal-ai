import { useCallback, useEffect, useRef, useState } from 'react'
import type { Clock, Journal } from '@/journal/journal'
import type {
  Desktop,
  MainSection,
  SettingsTab,
  Unlisten,
} from '@/platform/desktop'
import OnScreenContext from '@/components/on-screen-context'
import type { AppSettings } from '@/settings/app-settings'
import HistoryView from '@/views/history/HistoryView'
import SettingsView from '@/views/settings/SettingsView'
import WorkSummaryView from '@/views/work-summary/WorkSummaryView'
import TasksView from '@/views/tasks/TasksView'
import OnboardingView from '@/views/onboarding/OnboardingView'
import SectionSidebar from './SectionSidebar'

/**
 * The one window the journal is read in: a sidebar of sections down the left,
 * exactly one of them showing — see
 * docs/adr/0022-one-main-window-for-reading-and-settings.md.
 *
 * The window is built when it is asked for and genuinely closed on dismiss, so
 * everything here starts fresh with it. Which section it starts on is the
 * Entry Point's to say: the Tray Menu and a clicked Task Alert each name one,
 * and a request naming none resolves to History.
 *
 * Every section stays mounted and only the one showing is on screen. A section
 * is a place the user keeps coming back to rather than a page they load: a
 * Filter narrowed in History, or a Task half-edited, survives a trip to the
 * other section — and a Nudge raised while the other one is showing waits
 * quietly on History rather than being announced from the sidebar.
 *
 * A section knows nothing about the sidebar. Every section is rendered exactly
 * as it was when each had a window to itself, which is also how they are still
 * tested. The one thing they are told is whether they are on screen — see
 * `on-screen-context` — because hiding a section hides only what it holds, and
 * a dialog it portalled out of the document stays on screen without it.
 *
 * Onboarding is a temporary guided flow shown in place of the sections while
 * it runs — see docs/onboarding.md. It appears on its own when a fresh
 * installation is still due, and when Settings asks to replay it. While it is
 * up the sections stay mounted and hidden exactly as they do when another
 * section is showing, so leaving the flow — Finish, Skip onboarding, or a
 * sidebar choice — returns to the section that was there. Leaving it is also
 * what dismisses automatic presentation: a fresh installation is offered the
 * introduction until it is finished, skipped, closed, quit out of, or left by
 * navigating away, and manual replay from Settings never re-enables any of
 * that.
 */
export default function MainWindow({
  desktop,
  settings,
  journal,
  clock,
}: {
  desktop: Desktop
  settings: AppSettings
  journal: Promise<Journal>
  /** What the day is, for the section that groups by it. */
  clock: Clock
}) {
  const [section, setSection] = useState<MainSection>('history')
  // The tab of Settings showing. Held here rather than in Settings because
  // what names one — the Tray Menu's Check for Updates…, Work Summary asking
  // for Model Access — is outside it. Not stored anywhere: the window is
  // rebuilt on open, so Settings starts on General each time.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  // The Onboarding flow currently showing in place of the sections, and
  // whether it was offered automatically (a fresh installation still due) or
  // replayed by hand from Settings. Null is the ordinary state: sections.
  const [onboarding, setOnboarding] = useState<{ automatic: boolean } | null>(
    null,
  )
  // The practice Note to reveal in History once Onboarding leaves for it: its
  // Journal Day. Null is the ordinary state: History opens where its Filter
  // already is. A new object per request, so asking for the same day twice
  // still lands.
  const [historyReveal, setHistoryReveal] = useState<{ day: string } | null>(
    null,
  )
  // The section on screen, as the element the sidebar is not part of.
  const showing = useRef<HTMLDivElement>(null)
  // The flow's own mount state, read by the section switch that ends it.
  const onboardingRef = useRef(onboarding)
  useEffect(() => {
    onboardingRef.current = onboarding
  }, [onboarding])
  // Whether an Entry Point named a section for this window — written down as
  // the section lands, so the automatic-presentation read can tell a window
  // opened on the introduction from one the user opened on a section.
  const sectionRequested = useRef(false)
  // Whether automatic Onboarding was dismissed already, so a later close of
  // the same window does not write the marker twice.
  const dismissed = useRef(false)

  /**
   * Ends automatic presentation for good: what Finish, Skip onboarding,
   * Close and navigation away all settle on. The marker write is the Rust
   * side's — one-way, so replaying the flow never re-enables it — and a
   * refusal is logged rather than allowed to keep the flow on screen.
   */
  const dismissAutomaticOnboarding = useCallback(() => {
    if (dismissed.current) return Promise.resolve()
    dismissed.current = true
    return desktop.dismissOnboarding().catch((error: unknown) => {
      console.error('could not dismiss automatic Onboarding', error)
    })
  }, [desktop])

  /**
   * Takes the flow off the screen, keeping every section it was hiding. An
   * automatic flow records its dismissal as it leaves; a manual replay
   * changes nothing, so a dismissed installation stays dismissed.
   */
  const leaveOnboarding = useCallback(() => {
    const presenting = onboardingRef.current
    if (presenting === null) return
    setOnboarding(null)
    if (presenting.automatic) void dismissAutomaticOnboarding()
  }, [dismissAutomaticOnboarding])

  /**
   * Shows a section. While the flow is up this is what leaving it means —
   * the sidebar's choice, or an Entry Point naming the section — and for an
   * automatic flow that leaving is the dismissal.
   */
  const openSection = useCallback(
    (next: MainSection) => {
      sectionRequested.current = true
      leaveOnboarding()
      setSection(next)
    },
    [leaveOnboarding],
  )

  /**
   * Shows the practice Note in History: its Journal Day with Project = Any,
   * whatever the Filter said before. Leaving the flow this way is navigating
   * away, so an automatic flow records its dismissal as it goes.
   */
  const viewPracticeNote = useCallback(
    (journalDay: string) => {
      setHistoryReveal({ day: journalDay })
      openSection('history')
    },
    [openSection],
  )

  useEffect(() => {
    // An Entry Point says the section twice — written down for a window that
    // has yet to ask, announced for one already listening — because a window
    // built by that very request has no webview when the announcement goes
    // out. Both are read here, and whichever section was named last wins.

    // The announcement first, and the section written down only once this is
    // listening: a request arriving in the gap between the two would otherwise
    // be announced to nothing and already taken from where it was written.
    let announced = false
    const listening = desktop.onSectionRequested(({ section, tab }) => {
      announced = true
      // The section heard is claimed as well, exactly as Tasks View claims a
      // Task Alert it hears: what was written down for this window has been
      // delivered, and leaving it there would hand it to the next window to
      // open — which nobody asked to land anywhere but History.
      void desktop.requestedSection().catch((error: unknown) => {
        console.error('could not claim the section that was announced', error)
      })
      openSection(section)
      if (tab !== null) setSettingsTab(tab)
    })

    void listening.then(() => desktop.requestedSection()).then(
      (requested) => {
        // An announcement that has already landed is the later word: the
        // window was told a section while this claim was still crossing, and
        // what it came back with cannot undo that.
        if (requested === null || announced) return
        openSection(requested.section)
        if (requested.tab !== null) setSettingsTab(requested.tab)
      },
      (error: unknown) => {
        console.error('could not read the section this window opened on', error)
      },
    )

    return () => {
      void listening.then((stop) => stop())
    }
  }, [desktop, openSection])

  useEffect(() => {
    // A fresh installation — or one whose unfinished Onboarding a crash
    // interrupted — is offered the introduction automatically, but only when
    // the window was not opened on a section an Entry Point named. Opening on
    // a named section is the user navigating there, and navigation away is a
    // dismissal.
    let cancelled = false
    let stopClose: Unlisten | null = null

    void desktop.onboardingState().then((state) => {
      if (cancelled) return
      if (state !== 'unfinished') return

      // Closing the window rather than answering is a dismissal too, exactly
      // as it was for the first-run question this flow replaced. Heard for as
      // long as the window is open: the write has to land before the window
      // closes, or the introduction would return on the next launch.
      void desktop.onCloseRequested(dismissAutomaticOnboarding).then((stop) => {
        if (cancelled) stop()
        else stopClose = stop
      })

      if (sectionRequested.current) {
        void dismissAutomaticOnboarding()
        return
      }
      setOnboarding({ automatic: true })
    })

    return () => {
      cancelled = true
      stopClose?.()
    }
  }, [desktop, dismissAutomaticOnboarding])

  useEffect(() => {
    // A section takes focus as it mounts, but the section switched to has been
    // mounted all along — and whatever did the switching has the focus: the
    // sidebar button, or nothing at all when an Entry Point named the section.
    // Escape belongs to the section, bound to its own root, so the root is
    // handed focus here exactly as it takes it when a window opens on it.
    if (onboarding !== null) return
    const root = showing.current?.firstElementChild
    if (root instanceof HTMLElement) root.focus()
  }, [section, onboarding])

  const sectionsOffScreen = onboarding !== null

  return (
    <div className="flex h-screen bg-background">
      <SectionSidebar current={section} onChoose={openSection} />
      {onboarding !== null && (
        <OnboardingView
          desktop={desktop}
          settings={settings}
          onDone={() => openSection('history')}
          onViewNote={viewPracticeNote}
        />
      )}
      <Section section="history" on={!sectionsOffScreen && section === 'history'} onScreen={showing}>
        <HistoryView desktop={desktop} journal={journal} reveal={historyReveal} />
      </Section>
      <Section section="tasks" on={!sectionsOffScreen && section === 'tasks'} onScreen={showing}>
        <TasksView desktop={desktop} journal={journal} clock={clock} />
      </Section>
      <Section section="settings" on={!sectionsOffScreen && section === 'settings'} onScreen={showing}>
        <SettingsView
          desktop={desktop}
          settings={settings}
          journal={journal}
          tab={settingsTab}
          onTabChange={setSettingsTab}
          onReplayOnboarding={() => setOnboarding({ automatic: false })}
        />
      </Section>
      <Section
        section="work-summary"
        on={!sectionsOffScreen && section === 'work-summary'}
        onScreen={showing}
      >
        <WorkSummaryView
          desktop={desktop}
          settings={settings}
          journal={journal}
          clock={clock}
          onOpenSettings={() => {
            setSettingsTab('intelligence')
            setSection('settings')
          }}
        />
      </Section>
    </div>
  )
}

/**
 * One section, showing or hidden — and told which, because hiding it reaches
 * only what it holds: a dialog or a popup it portalled out of the document
 * would otherwise stand over the section that is showing. See
 * docs/adr/0024-a-view-is-told-whether-it-is-on-screen.md.
 *
 * Hidden rather than unmounted: the section the user comes back to is the one
 * they left, down to the Filter and the scroll position. `hidden` rather than
 * a class, so the section that is not showing is out of the accessibility tree
 * as well as off the screen — nothing in it is reachable by Tab, by a screen
 * reader, or by a label the section showing uses too.
 *
 * `min-w-0` so the section is what gives way when the window is narrowed: the
 * sidebar's width is fixed, and a section whose content refused to shrink
 * would push its own right-hand edge off the window.
 */
function Section({
  section,
  on,
  onScreen,
  children,
}: {
  /** The shared section name, useful to the accessibility/test surface. */
  section: MainSection
  /** Whether this is the section showing. */
  on: boolean
  /** Where the window keeps the section showing, to hand it the focus. */
  onScreen: React.RefObject<HTMLDivElement | null>
  children: React.ReactNode
}) {
  return (
    <OnScreenContext.Provider value={on}>
      <div
        hidden={!on}
        ref={on ? onScreen : null}
        data-main-section={section}
        className="min-w-0 flex-1"
      >
        {children}
      </div>
    </OnScreenContext.Provider>
  )
}
