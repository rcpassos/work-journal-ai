// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { toast } from 'sonner'
import { fakeDesktop, type FakeDesktop } from '@/platform/testing/desktop'
import type { Journal } from '@/journal/journal'
import ThemeProvider from '@/components/ThemeProvider'
import { createAppSettings } from '@/settings/app-settings'
import { readObserving, type Observing } from '@/settings/observing'
import SettingsView from './SettingsView'

// The Observing group as the user meets it, inside the whole Settings view and
// over a fake desktop: what is on screen, what the picker answers, and what
// the settings file came to hold.

afterEach(() => {
  cleanup()
  toast.dismiss()
})

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
})

const WORK_JOURNAL = {
  repository: '/code/work-journal-ai/.git',
  configuredEmail: 'me@example.com',
  commits: [],
}

function showSettings(desktop: FakeDesktop) {
  const settings = createAppSettings(desktop)
  render(
    <ThemeProvider settings={settings}>
      <SettingsView
        desktop={desktop}
        settings={settings}
        journal={new Promise<Journal>(() => {})}
      />
    </ThemeProvider>,
  )
}

function observingSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: 'Add your commits to the journal' })
}

function stored(desktop: FakeDesktop): Observing {
  return readObserving(desktop.stored.observing)
}

function toasts(): string[] {
  return [...document.querySelectorAll('[data-sonner-toast]')].map(
    (each) => each.textContent ?? '',
  )
}

/** A desktop with Observing already on and nothing listed. */
function observingDesktop() {
  return fakeDesktop({
    stored: { observing: { enabled: true, repositories: [], consent: {} } },
    repositories: {
      '/code/work-journal-ai': WORK_JOURNAL,
      // A second worktree reports the same common directory.
      '/code/work-journal-ai-260': WORK_JOURNAL,
      '/tmp': 'not-a-repository',
    },
  })
}

describe('the Observing switch', () => {
  it('reads off until turned on, and offers nothing to choose until then', async () => {
    const desktop = fakeDesktop()
    showSettings(desktop)

    expect(observingSwitch().getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Add Repository…' })).toBeNull()
  })

  it('records the enablement instant, and confirms with a toast', async () => {
    const desktop = fakeDesktop()
    showSettings(desktop)

    observingSwitch().click()

    await expect.poll(() => stored(desktop).enabled).toBe(true)
    await expect.poll(toasts).toContain('Your commits will be added to the journal.')
    expect(await screen.findByText('No repositories chosen, so nothing is observed.')).toBeTruthy()
  })
})

describe('adding a repository', () => {
  it('is through the folder picker, with the suggestions offered unticked', async () => {
    const desktop = observingDesktop()
    desktop.chosenFolder = '/code/work-journal-ai'
    showSettings(desktop)

    ;(await screen.findByRole('button', { name: 'Add Repository…' })).click()

    const identity = await screen.findByRole('checkbox', { name: 'me@example.com' })
    expect(identity.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('work-journal-ai')).toBeTruthy()
    expect(stored(desktop).repositories).toEqual([
      {
        path: '/code/work-journal-ai',
        repository: '/code/work-journal-ai/.git',
        identities: [],
        ignoredPrefixes: [],
      },
    ])
    // Listed while on, so consented from now.
    expect(stored(desktop).consent['/code/work-journal-ai/.git']).toHaveLength(1)

    identity.click()

    await expect
      .poll(() => stored(desktop).repositories[0]?.identities)
      .toEqual(['me@example.com'])
    await expect.poll(toasts).toContain('Addresses saved.')
  })

  it('adds nothing for a second worktree, and says which entry it already is', async () => {
    const desktop = observingDesktop()
    desktop.chosenFolder = '/code/work-journal-ai'
    showSettings(desktop)
    const addButton = await screen.findByRole('button', { name: 'Add Repository…' })
    addButton.click()
    await screen.findByText('work-journal-ai')

    desktop.chosenFolder = '/code/work-journal-ai-260'
    addButton.click()

    await expect.poll(toasts).toContain('Already added as work-journal-ai.')
    expect(stored(desktop).repositories).toHaveLength(1)
  })

  it('does nothing when the picker is cancelled', async () => {
    const desktop = observingDesktop()
    showSettings(desktop)

    ;(await screen.findByRole('button', { name: 'Add Repository…' })).click()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(stored(desktop).repositories).toEqual([])
  })

  it('says why a folder that is not a repository cannot be added', async () => {
    const desktop = observingDesktop()
    desktop.chosenFolder = '/tmp'
    showSettings(desktop)

    ;(await screen.findByRole('button', { name: 'Add Repository…' })).click()

    await expect
      .poll(toasts)
      .toContain('Could not add that folder: That folder is not a git repository.')
    expect(stored(desktop).repositories).toEqual([])
  })
})

describe('a repository on the list', () => {
  it('takes the prefixes to skip, one per line, once the field is left', async () => {
    const desktop = observingDesktop()
    desktop.chosenFolder = '/code/work-journal-ai'
    showSettings(desktop)
    ;(await screen.findByRole('button', { name: 'Add Repository…' })).click()

    const field = await screen.findByLabelText(/Skip commits whose subject begins with/)
    fireEvent.change(field, { target: { value: 'Release \n\nchore:' } })
    // Nothing is saved while the field is being typed into.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stored(desktop).repositories[0]?.ignoredPrefixes).toEqual([])
    fireEvent.blur(field)

    await expect
      .poll(() => stored(desktop).repositories[0]?.ignoredPrefixes)
      .toEqual(['Release ', 'chore:'])
    await expect.poll(toasts).toContain('Skipped prefixes saved.')
  })

  it('is removed, closing its consent rather than forgetting it', async () => {
    const desktop = observingDesktop()
    desktop.chosenFolder = '/code/work-journal-ai'
    showSettings(desktop)
    ;(await screen.findByRole('button', { name: 'Add Repository…' })).click()

    ;(await screen.findByRole('button', { name: 'Remove work-journal-ai' })).click()

    await expect.poll(() => stored(desktop).repositories).toEqual([])
    expect(stored(desktop).consent['/code/work-journal-ai/.git']?.[0]?.until).not.toBeNull()
    await expect.poll(toasts).toContain('work-journal-ai removed.')
  })
})
