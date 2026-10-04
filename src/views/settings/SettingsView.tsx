import { useEffect, useRef, useState } from 'react'
import OnScreenContext, { useOnScreen } from '@/components/on-screen-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CHANGELOG } from '@/settings/changelog'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
} from './SettingsGroup'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import WindowTitleBar from '@/components/WindowTitleBar'
import type { Journal } from '@/journal/journal'
import type { AppIdentity, Desktop, SettingsTab } from '@/platform/desktop'
import type { AppSettings } from '@/settings/app-settings'
import BackupSettings from './BackupSettings'
import ExportSettings from './ExportSettings'
import HotkeySettings from './HotkeySettings'
import MeetingImportSettings from './MeetingImportSettings'
import ModelAccessSettings from './ModelAccessSettings'
import ObservingSettings from './ObservingSettings'
import WorkSummaryPromptSettings from './WorkSummaryPromptSettings'
import StartAtLoginSettings from './StartAtLoginSettings'
import {
  loadSettingsInitialState,
  type SettingsInitialState,
} from './SettingsInitialState'
import TaskAlertSettings from './TaskAlertSettings'
import ThemeSettings from './ThemeSettings'
import UpdateSettings from './UpdateSettings'
import ChangelogSettings from './ChangelogSettings'

/**
 * The settings section of the Main Window: a shell that composes one group per
 * setting and owns only the window chrome and application metadata. The groups
 * own their controls, state and platform interactions so new settings can be
 * added without making this composition root larger.
 *
 * Laid out the way macOS lays settings out: five tabs along the top, one
 * card of hairline-divided groups showing at a time, with what the setting is
 * on the left and the control that changes it on the right. Every control
 * here is the app's own — a native widget brings its own font, height and
 * focus ring, and belongs to the OS rather than to this window.
 *
 * Every tab stays mounted and only the selected one is on screen, so what the
 * user did on a tab — an API Key typed and not yet saved, an Export still
 * running — is still there after they switch away and back. Which tab is
 * selected is view state, held by the Main Window because an Entry Point can
 * name one; see docs/adr/0025-a-session-is-for-sequencing-not-for-state.md.
 *
 * The window behind this view is created on demand and genuinely closed on
 * dismiss, so the view loads once on mount and needs no reset — see
 * docs/adr/0002-capture-window-is-hidden-never-closed.md.
 */
export default function SettingsView({
  desktop,
  settings,
  journal,
  tab,
  onTabChange,
  onReplayOnboarding = () => {},
}: {
  desktop: Desktop
  settings: AppSettings
  journal: Promise<Journal>
  /**
   * The tab showing, held by the Main Window so an Entry Point can name one.
   */
  tab: SettingsTab
  onTabChange: (tab: SettingsTab) => void
  /**
   * The Main Window's way of showing the Onboarding flow again, in place of
   * the sections. Replaying starts at the introduction, reflects current
   * settings, and never re-enables automatic presentation.
   */
  onReplayOnboarding?: () => void
}) {
  const [appIdentity, setAppIdentity] = useState<AppIdentity | null>(null)
  const page = useRef<HTMLDivElement>(null)
  const [initialSettings, setInitialSettings] = useState<
    Promise<SettingsInitialState | null> | null
  >(null)

  useEffect(() => {
    void desktop.appIdentity().then(setAppIdentity, (error: unknown) => {
      console.error('could not read the app identity', error)
    })
  }, [desktop])

  useEffect(() => {
    // A Dock-less app does not reliably hand focus to a new window, and Escape
    // has to reach this view for the window to close.
    page.current?.focus()

    // This state is the one post-commit handoff of the coordinated read to the
    // groups. Publishing the in-flight Promise immediately lets every group
    // observe the same snapshot without starting platform work during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInitialSettings(loadSettingsInitialState(desktop, settings))
  }, [desktop, settings])

  function onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    // HotkeyRecorder stops Escape before it reaches this shell while it owns
    // the keystroke.
    if (event.key === 'Escape') {
      void desktop.closeWindow()
    }
  }

  return (
    <div
      ref={page}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex h-screen flex-col bg-background type-body outline-none"
    >
      <WindowTitleBar />

      {/* Every ⓘ on the page shares one provider, so a reader moving down the
          rows is told what the next setting is without waiting again. */}
      <TooltipProvider delay={400}>
        {/* Everything the window says scrolls; the strip above it does not. The
            first section keeps the clear space it always had, measured from
            under the strip rather than from the top of the window.

            `relative` so this is the containing block of what it holds: every
            row's explanation is screen-reader-only text, which is positioned
            absolutely, and an absolute box is only clipped by the scroller
            that is its containing block. Without it those explanations sit at
            their static positions outside the scroller, the page itself grows
            to reach the last one, and the window gets a second scrollbar. */}
        <Tabs
          value={tab}
          onValueChange={(next) => onTabChange(next as SettingsTab)}
          className="min-h-0 flex-1 gap-0"
        >
          <TabsList className="mx-auto mt-3 shrink-0">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="sources">Sources</TabsTrigger>
            <TabsTrigger value="intelligence">Intelligence</TabsTrigger>
            <TabsTrigger value="data">Data</TabsTrigger>
            <TabsTrigger value="about">About</TabsTrigger>
          </TabsList>

          {/* Everything the tab says scrolls; the strip above it does not.

              `relative` so this is the containing block of what it holds:
              every row's explanation is screen-reader-only text, which is
              positioned absolutely, and an absolute box is only clipped by the
              scroller that is its containing block. Without it those
              explanations sit at their static positions outside the scroller,
              the page itself grows to reach the last one, and the window gets a
              second scrollbar. */}
          <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-5 pb-5">
            <TabPanel value="general" selected={tab}>
              <SettingsCard>
                <StartAtLoginSettings
                  desktop={desktop}
                  settings={settings}
                  initialSettings={initialSettings}
                />

                <ThemeSettings />

                <HotkeySettings
                  desktop={desktop}
                  initialSettings={initialSettings}
                />

                <TaskAlertSettings
                  desktop={desktop}
                  initialSettings={initialSettings}
                />
              </SettingsCard>
            </TabPanel>

            <TabPanel value="sources" selected={tab}>
              <SettingsCard>
                <MeetingImportSettings
                  desktop={desktop}
                  settings={settings}
                  initialSettings={initialSettings}
                />

                <ObservingSettings
                  desktop={desktop}
                  settings={settings}
                  journal={journal}
                  initialSettings={initialSettings}
                />
              </SettingsCard>
            </TabPanel>

            <TabPanel value="intelligence" selected={tab}>
              <SettingsCard>
                <ModelAccessSettings
                  desktop={desktop}
                  settings={settings}
                  initialSettings={initialSettings}
                />

                {/* The prompt a model writes from sits beside where that model
                    is reached: both belong to the same call, and the field is
                    plain text while the Key is not. */}
                <WorkSummaryPromptSettings
                  settings={settings}
                  initialSettings={initialSettings}
                />
              </SettingsCard>
            </TabPanel>

            <TabPanel value="data" selected={tab}>
              <SettingsCard>
                <ExportSettings desktop={desktop} journal={journal} />

                {/* Beside Export, which it is deliberately not: Export is the
                    human-readable way out, Backup the snapshot — see the two
                    entries in CONTEXT.md and ADR 0032. */}
                <BackupSettings desktop={desktop} />
              </SettingsCard>
            </TabPanel>

            <TabPanel value="about" selected={tab} className="flex flex-col">
              <SettingsCard>
                {/* Beside the version in the footer: both are about the build
                    rather than about the journal it holds. */}
                <UpdateSettings desktop={desktop} />

                {/* Under the way into the next version, because it is what the
                    last one did. The version is null until it has been read,
                    and the changelog opens at its own newest entry until then. */}
                <ChangelogSettings
                  versions={CHANGELOG}
                  running={appIdentity?.version ?? ''}
                />

                {/* The introduction itself, offered again. An action rather
                    than a setting: it changes nothing that is saved, so it
                    sits with the window's other actions rather than with a
                    group that reads or writes a value. */}
                <SettingsGroup>
                  <SettingsRow
                    label="Onboarding"
                    explanation="See the introduction and the optional setup again, with your current Hotkeys and settings."
                  >
                    <Button variant="outline" onClick={onReplayOnboarding}>
                      Replay introduction
                    </Button>
                  </SettingsRow>
                </SettingsGroup>
              </SettingsCard>

              {appIdentity !== null && (
                <footer
                  aria-label="Application version"
                  className="mt-auto flex items-center justify-center gap-2 pt-2 type-meta text-muted-foreground"
                >
                  <span>{appIdentity.version}</span>
                  {appIdentity.isDevelopment && (
                    <Badge variant="outline">Dev</Badge>
                  )}
                </footer>
              )}
            </TabPanel>

            <Toaster />
          </div>
        </Tabs>
      </TooltipProvider>
    </div>
  )
}

/**
 * One tab's panel. Kept mounted while another tab shows, and hidden — which
 * hides only what it holds, so each group is told it is off screen exactly as
 * it is when the whole section is: a restart an Update was waiting to make, or
 * a toast, must not land on a tab nobody is looking at. See
 * docs/adr/0024-a-view-is-told-whether-it-is-on-screen.md.
 */
function TabPanel({
  value,
  selected,
  className,
  children,
}: {
  value: SettingsTab
  /** The tab showing. */
  selected: SettingsTab
  className?: string
  children: React.ReactNode
}) {
  const sectionOnScreen = useOnScreen()

  return (
    <TabsContent value={value} keepMounted className={className}>
      <OnScreenContext.Provider value={sectionOnScreen && selected === value}>
        {children}
      </OnScreenContext.Provider>
    </TabsContent>
  )
}
