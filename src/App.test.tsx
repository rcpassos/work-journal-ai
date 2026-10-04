import { describe, expect, it } from 'vitest'
import App from './App'
import type { Clock, Journal } from './journal/journal'
import type { Desktop } from './platform/desktop'
import type { AppSettings } from './settings/app-settings'

function appFor(windowLabel: string) {
  return App({
    windowLabel,
    desktop: {} as Desktop,
    settings: {} as AppSettings,
    journal: new Promise<Journal>(() => {}),
    clock: {} as Clock,
  })
}

describe('App', () => {
  it('renders nothing for a window label it has no view for', () => {
    expect(appFor('history')).toBeNull()
    // Tasks View is a section of the Main Window, not a window of its own.
    expect(appFor('tasks')).toBeNull()
    // Settings is a section of the Main Window, not a window of its own.
    expect(appFor('settings')).toBeNull()
    expect(appFor('')).toBeNull()
  })
})
