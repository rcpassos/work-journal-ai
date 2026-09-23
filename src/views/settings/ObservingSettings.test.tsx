// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { fakeDesktop, type FakeDesktop } from '@/platform/testing/desktop'
import { createJournal, type Journal } from '@/journal/journal'
import { fixedClock, openTestDatabase } from '@/journal/testing/database'
import ThemeProvider from '@/components/ThemeProvider'
import { createAppSettings } from '@/settings/app-settings'
import { readObserving, type Observing } from '@/settings/observing'
import SettingsView from './SettingsView'

// The Observing group as the user meets it, inside the whole Settings view and
// over a fake desktop: what is on screen, what the picker answers, and what
// the settings file came to hold.

const openDatabases: Array<() => void> = []

afterEach(() => {
  for (const close of openDatabases.splice(0)) close()
  cleanup()
  toast.dismiss()
  vi.restoreAllMocks()
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

function showSettings(desktop: FakeDesktop, journal = openJournal()) {
  const settings = createAppSettings(desktop)
  render(
    <ThemeProvider settings={settings}>
      <SettingsView desktop={desktop} settings={settings} journal={journal} />
    </ThemeProvider>,
  )
  return { core: journal }
}

/**
 * A real journal, on a database this file closes afterwards: a Project
 * Mapping is journal content, so the field is driven against real SQL.
 */
function openJournal(): Promise<Journal> {
  return openTestDatabase().then(({ driver, close }) => {
    openDatabases.push(close)
    return createJournal({ clock: fixedClock('2026-03-09T10:00:00'), driver })
  })
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

  it('saves nothing, and says nothing, when the field is left unchanged', async () => {
    const desktop = observingDesktop()
    desktop.chosenFolder = '/code/work-journal-ai'
    showSettings(desktop)
    ;(await screen.findByRole('button', { name: 'Add Repository…' })).click()
    const field = await screen.findByLabelText(/Skip commits whose subject begins with/)
    await expect.poll(toasts).toContain('work-journal-ai added. Tick the addresses that are you.')
    let changed = 0
    await desktop.onObservingChanged(() => (changed += 1))

    fireEvent.focus(field)
    fireEvent.blur(field)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(changed).toBe(0)
    expect(toasts()).not.toContain('Skipped prefixes saved.')
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

describe('the Project field', () => {
  /** The repository added, and the field its row carries. */
  async function addedRepository() {
    const desktop = observingDesktop()
    desktop.chosenFolder = '/code/work-journal-ai'
    const { core } = showSettings(desktop)
    ;(await screen.findByRole('button', { name: 'Add Repository…' })).click()
    const field = (await screen.findByLabelText('Project')) as HTMLInputElement
    return { desktop, core, field }
  }

  function mapped(core: Promise<Journal>) {
    return core.then((journal) =>
      journal.projectMapping('/code/work-journal-ai/.git'),
    )
  }

  it('starts empty — Unfiled — and maps nothing until a Project is picked or typed', async () => {
    const { core, field } = await addedRepository()

    expect(field.value).toBe('')
    expect(field.placeholder).toBe('Unfiled')

    // The repository's own name is the first completion offered — offered,
    // and only that: it becomes the Project if the user picks it.
    fireEvent.focus(field)
    await expect
      .poll(async () =>
        (await screen.findAllByRole('option')).map((each) => each.textContent),
      )
      .toContain('#work-journal-ai')
    expect((await screen.findAllByRole('option'))[0]?.textContent).toBe(
      '#work-journal-ai',
    )

    // Not even typing at it maps anything: only a pick, or a name said with
    // Enter, decides the filing.
    fireEvent.change(field, { target: { value: 'half typed' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await mapped(core)).toBeNull()
  })

  it('maps the repository’s own name once it is picked', async () => {
    const user = userEvent.setup()
    const { core, field } = await addedRepository()

    await user.click(field)
    // The line of the list under the pointer, as it is drawn.
    const offered = await screen.findByRole('option', { name: '#work-journal-ai' })
    await user.click(within(offered).getByRole('button'))

    await expect.poll(() => mapped(core)).toBe('work-journal-ai')
    expect(field.value).toBe('work-journal-ai')
    await expect
      .poll(toasts)
      .toContain('Commits will be filed under #work-journal-ai.')
  })

  it('maps a name that is typed, and takes the mapping away again when it is emptied', async () => {
    const user = userEvent.setup()
    const { core, field } = await addedRepository()

    await user.click(field)
    await user.keyboard('Beta{Enter}')

    // Stored the way every Note's Project is stored.
    await expect.poll(() => mapped(core)).toBe('beta')
    expect(field.value).toBe('beta')

    await user.clear(field)
    await user.keyboard('{Enter}')

    await expect.poll(() => mapped(core)).toBeNull()
    expect(field.value).toBe('')
    await expect.poll(toasts).toContain('Commits will be Unfiled.')
  })

  it('offers the Predictions the journal already names, under the repository’s own name', async () => {
    const user = userEvent.setup()
    const desktop = observingDesktop()
    desktop.chosenFolder = '/code/work-journal-ai'
    const { core } = showSettings(desktop)
    await (await core).capture('#alpha shipped the tray')
    ;(await screen.findByRole('button', { name: 'Add Repository…' })).click()
    const field = await screen.findByLabelText('Project')

    await user.click(field)

    await expect
      .poll(async () =>
        (await screen.findAllByRole('option')).map((each) => each.textContent),
      )
      .toEqual(['#work-journal-ai', '#alpha'])
  })

  it('puts the field back to what it held when the journal refuses the save', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const refused = openJournal().then((journal) => ({
      ...journal,
      setProjectMapping: () => Promise.reject(new Error('no database')),
    }))
    const user = userEvent.setup()
    const desktop = observingDesktop()
    desktop.chosenFolder = '/code/work-journal-ai'
    showSettings(desktop, refused)
    ;(await screen.findByRole('button', { name: 'Add Repository…' })).click()
    const field = (await screen.findByLabelText('Project')) as HTMLInputElement

    await user.click(field)
    await user.keyboard('Beta{Enter}')

    // The field comes back before the toast raises, so what the user is told
    // and what they are looking at agree (ADR 0029).
    await expect.poll(toasts).toContain('Could not save the Project.')
    expect(field.value).toBe('')
  })
})
