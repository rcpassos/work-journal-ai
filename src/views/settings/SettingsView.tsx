import { useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CHANGELOG } from '@/settings/changelog'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from './SettingsGroup'
import WindowTitleBar from '@/components/WindowTitleBar'
import type { Journal } from '@/journal/journal'
import type { AppIdentity, Desktop } from '@/platform/desktop'
import type { AppSettings } from '@/settings/app-settings'
import BackupSettings from './BackupSettings'
import ExportSettings from './ExportSettings'
import HotkeySettings from './HotkeySettings'
import MeetingImportSettings from './MeetingImportSettings'
import ModelAccessSettings from './ModelAccessSettings'
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
 * Laid out the way macOS lays settings out: four named sections, each one card
 * of hairline-divided groups, with what the setting is on the left and the
 * control that changes it on the right. Every control here is the app's own —
 * a native widget brings its own font, height and focus ring, and belongs to
 * the OS rather than to this window.
 *
 * The window behind this view is created on demand and genuinely closed on
 * dismiss, so the view loads once on mount and needs no reset — see
 * docs/adr/0002-capture-window-is-hidden-never-closed.md.
 */
export default function SettingsView({
  desktop,
  settings,
  journal,
  onReplayOnboarding = () => {},
}: {
  desktop: Desktop
  settings: AppSettings
  journal: Promise<Journal>
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
        <div className="relative flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pt-5 pb-5">
          <SettingsSection title="Capture">
            <HotkeySettings desktop={desktop} initialSettings={initialSettings} />

            <ThemeSettings />

            <StartAtLoginSettings
              desktop={desktop}
              settings={settings}
              initialSettings={initialSettings}
            />
          </SettingsSection>

          <SettingsSection title="Journal">
            <MeetingImportSettings
              desktop={desktop}
              settings={settings}
              initialSettings={initialSettings}
            />

            <TaskAlertSettings
              desktop={desktop}
              initialSettings={initialSettings}
            />

            <ExportSettings desktop={desktop} journal={journal} />

            {/* Beside Export, which it is deliberately not: Export is the
                human-readable way out, Backup the snapshot — see the two
                entries in CONTEXT.md and ADR 0032. */}
            <BackupSettings desktop={desktop} />
          </SettingsSection>

          <SettingsSection title="Intelligence">
            <ModelAccessSettings
              desktop={desktop}
              settings={settings}
              initialSettings={initialSettings}
            />

            {/* The prompt a model writes from sits beside where that model is
                reached: both belong to the same call, and the field is plain
                text while the Key is not. */}
            <WorkSummaryPromptSettings
              settings={settings}
              initialSettings={initialSettings}
            />
          </SettingsSection>

          <SettingsSection title="About">
            {/* Beside the version in the footer: both are about the build
                rather than about the journal it holds. */}
            <UpdateSettings desktop={desktop} />

            {/* Under the way into the next version, because it is what the
                last one did. The version is null until it has been read, and
                the changelog opens at its own newest entry until then. */}
            <ChangelogSettings
              versions={CHANGELOG}
              running={appIdentity?.version ?? ''}
            />

            {/* The introduction itself, offered again. An action rather than a
                setting: it changes nothing that is saved, so it sits with the
                window's other actions rather than with a group that reads or
                writes a value. */}
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
          </SettingsSection>

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

          <Toaster />
        </div>
      </TooltipProvider>
    </div>
  )
}
