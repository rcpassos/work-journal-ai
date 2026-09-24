// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import {
  fakeDesktop,
  type FakeDesktop,
  type FakeRepository,
  type FakeUnreadablePath,
} from '@/platform/testing/desktop'
import OnScreenContext from '@/components/on-screen-context'
import { createJournal, type Journal, type SourceEvent } from '@/journal/journal'
import { fixedClock, openTestDatabase } from '@/journal/testing/database'
import ThemeProvider from '@/components/ThemeProvider'
import { createAppSettings } from '@/settings/app-settings'
import { pauseObserving, readObserving, type Observing } from '@/settings/observing'
import SettingsView from './SettingsView'

// The Observing group as the user meets it, inside the whole Settings view and
// over a fake desktop: what is on screen, what the picker answers, and what
// the settings file came to hold.

const openJournals: Array<() => void> = []

afterEach(() => {
  for (const close of openJournals.splice(0)) close()
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

function showSettings(
  desktop: FakeDesktop,
  journal: Promise<Journal> = new Promise<Journal>(() => {}),
) {
  const settings = createAppSettings(desktop)
  render(
    <ThemeProvider settings={settings}>
      <SettingsView
        desktop={desktop}
        settings={settings}
        journal={journal}
      />
    </ThemeProvider>,
  )
  return settings
}

/** The Settings view under a visibility this test can change the slow way. */
function showSettingsOnScreen(desktop: FakeDesktop, journal: Promise<Journal>) {
  const settings = createAppSettings(desktop)
  const control: { hide(): void; show(): void } = { hide: () => {}, show: () => {} }
  function Harness() {
    const [onScreen, setOnScreen] = useState(true)
    control.hide = () => setOnScreen(false)
    control.show = () => setOnScreen(true)
    return (
      <ThemeProvider settings={settings}>
        <OnScreenContext.Provider value={onScreen}>
          <div hidden={!onScreen}>
            <SettingsView desktop={desktop} settings={settings} journal={journal} />
          </div>
        </OnScreenContext.Provider>
      </ThemeProvider>
    )
  }
  render(<Harness />)
  return control
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

/** Observing on with one repository listed at `path`. */
function listedAt(
  path: string,
  found: FakeRepository | FakeUnreadablePath,
  journal: Promise<Journal> = new Promise<Journal>(() => {}),
) {
  return {
    desktop: fakeDesktop({
      stored: {
        observing: {
          enabled: true,
          repositories: [
            {
              path,
              repository: `${path}/.git`,
              identities: ['me@example.com'],
              ignoredPrefixes: [],
            },
          ],
          consent: { [`${path}/.git`]: [{ from: 1, until: null }] },
          pauses: {},
        },
      },
      repositories: { [path]: found },
    }),
    journal,
  }
}

/** A journal holding the events given, over real SQL and a clock of now. */
async function journalWith(events: SourceEvent[] = []) {
  const { driver, close } = await openTestDatabase()
  openJournals.push(close)
  const core = createJournal({ clock: fixedClock(new Date()), driver })
  const notes = []
  for (const event of events) notes.push(await core.observe(event))
  return { journal: Promise.resolve(core), core, notes }
}

describe('a repository that is not working', () => {
  it.each<[FakeUnreadablePath, string]>([
    ['missing', 'That folder is gone.'],
    ['not-a-repository', 'That folder is not a git repository.'],
  ])('says its reason beside the entry it concerns: %s', async (reason, sentence) => {
    const { journal } = await journalWith()
    const { desktop } = listedAt('/code/gone', reason, journal)

    showSettings(desktop, journal)

    expect(
      await screen.findByText(`${sentence} Its commits are not being added.`),
    ).toBeTruthy()
    // The reason is a line in the section, never a prompt of any kind.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says a repository with nothing on its branches yet cannot be read, beside what it still offers', async () => {
    // The reader answers this way and no other: a repository with nothing
    // resolvable is read for who the user might be — and the reason nothing
    // can be read comes back beside them, because this read is the one
    // Settings makes and the sweep's answer never reaches the section.
    const { journal } = await journalWith()
    const { desktop } = listedAt(
      '/code/fresh',
      {
        repository: '/code/fresh/.git',
        configuredEmail: 'me@example.com',
        commits: [],
        noHead: true,
      },
      journal,
    )

    showSettings(desktop, journal)

    expect(
      await screen.findByText(
        'The default branch of that repository cannot be resolved. Its commits are not being added.',
      ),
    ).toBeTruthy()
    // Not a dead entry: the addresses are still there to tick.
    expect(await screen.findByRole('checkbox', { name: 'me@example.com' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('a repository that is working', () => {
  it('shows the last Note it produced and when it arrived', async () => {
    const { journal } = await journalWith([
      {
        source: 'commit',
        eventKey: '6f47772@/code/work-journal-ai/.git',
        body: 'Fix the second scrollbar on Settings (#256)',
        happenedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        project: null,
      },
      {
        source: 'commit',
        eventKey: 'b1@/code/work-journal-ai/.git',
        body: 'Observe: the third Note origin',
        happenedAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
        project: null,
      },
    ])
    const { desktop } = listedAt('/code/work-journal-ai', WORK_JOURNAL)

    showSettings(desktop, journal)

    // One sweep brings them together, so what arrived together is told apart
    // by the work's own instant — and the "when" is their arrival: "just now"
    // whatever the work says.
    expect(
      await screen.findByText(
        'Last: Fix the second scrollbar on Settings (#256) · just now',
      ),
    ).toBeTruthy()
    expect(screen.queryByText(/· 2 h ago/)).toBeNull()
    expect(screen.queryByText(/· 1 day ago/)).toBeNull()
  })

  it('says nothing has arrived since Observing was turned on, before the first does', async () => {
    const { journal } = await journalWith()
    const { desktop } = listedAt('/code/work-journal-ai', WORK_JOURNAL)

    showSettings(desktop, journal)

    expect(
      await screen.findByText('Nothing yet since you turned this on'),
    ).toBeTruthy()
  })

  it('does not count a Note the user deleted', async () => {
    const { journal, core, notes } = await journalWith([
      {
        source: 'commit',
        eventKey: 'b2@/code/work-journal-ai/.git',
        body: 'Fix the second scrollbar on Settings (#256)',
        happenedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        project: null,
      },
      {
        source: 'commit',
        eventKey: 'b1@/code/work-journal-ai/.git',
        body: 'Observe: the third Note origin',
        happenedAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
        project: null,
      },
    ])
    await core.delete(notes[0]!.id)
    const { desktop } = listedAt('/code/work-journal-ai', WORK_JOURNAL)

    showSettings(desktop, journal)

    expect(
      await screen.findByText(/^Last: Observe: the third Note origin · /),
    ).toBeTruthy()
  })
})

describe('the pause', () => {
  /** Observing on, one repository added through the picker, and the menu open. */
  async function pausedFromTheMenu(length: string) {
    const user = userEvent.setup()
    const desktop = observingDesktop()
    desktop.chosenFolder = '/code/work-journal-ai'
    showSettings(desktop)
    ;(await screen.findByRole('button', { name: 'Add Repository…' })).click()
    await screen.findByText('work-journal-ai')

    await user.click(await screen.findByRole('button', { name: 'Pause observing' }))
    await user.click(await screen.findByRole('menuitem', { name: length }))
    return { user, desktop }
  }

  it('is taken from the menu, says until when, and confirms with a toast', async () => {
    const { desktop } = await pausedFromTheMenu('For an hour')

    await expect
      .poll(toasts)
      .toContain('Nothing done in the next hour will be added to the journal.')
    expect(stored(desktop).pauses['/code/work-journal-ai/.git']).toHaveLength(1)
    expect(await screen.findByText(/^Paused until /)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pause observing' })).toBeNull()
  })

  it('holds until resumed when it is taken until resumed', async () => {
    const { desktop } = await pausedFromTheMenu('Until resumed')

    await expect
      .poll(toasts)
      .toContain('Nothing done before you resume will be added to the journal.')
    expect(await screen.findByText('Paused')).toBeTruthy()
    expect(stored(desktop).pauses['/code/work-journal-ai/.git']?.[0]?.until).toBeNull()
  })

  it('is resumed from here, and keeps what it excluded', async () => {
    const { user, desktop } = await pausedFromTheMenu('For an hour')
    await screen.findByText(/^Paused until /)

    await user.click(screen.getByRole('button', { name: 'Resume' }))

    await expect
      .poll(toasts)
      .toContain('Your commits will be added to the journal again.')
    const pause = stored(desktop).pauses['/code/work-journal-ai/.git']?.[0]
    expect(pause?.until).not.toBeNull()
    // Closed at the resume instant, keeping the stretch it excluded.
    expect(pause?.until).toBeGreaterThanOrEqual(pause?.from ?? Infinity)
    await screen.findByRole('button', { name: 'Pause observing' })
  })

  it('is shown here too when it was taken from the Tray Menu', async () => {
    const { desktop } = listedAt('/code/work-journal-ai', WORK_JOURNAL)
    showSettings(desktop)
    await screen.findByRole('button', { name: 'Pause observing' })

    // The capture window's answer to the tray's press: the same rule, over
    // the same file, announced the same way.
    await createAppSettings(desktop).updateObserving((observing, now) =>
      pauseObserving(observing, 'until-resumed', now),
    )

    expect(await screen.findByText('Paused')).toBeTruthy()
    await screen.findByRole('button', { name: 'Resume' })
  })
})

describe('the pause row after time passed unseen', () => {
  // The row ends itself with a timer, and a timer is no use through a sleep —
  // WebKit stops it — or through a trip to another section, where the row
  // stays mounted and stale. Both moments read the clock again: the system
  // wake, and the section coming back on screen.

  /** Observing on, one repository listed, and an hour's pause already taken. */
  async function paused() {
    const { desktop, journal } = listedAt('/code/work-journal-ai', WORK_JOURNAL)
    // Taken while Settings was closed, as the Tray Menu takes it.
    await createAppSettings(desktop).updateObserving((observing, now) =>
      pauseObserving(observing, 'an-hour', now),
    )
    return { desktop, journal }
  }

  it('reads the clock again when the Mac wakes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { desktop, journal } = await paused()
      showSettings(desktop, journal)
      await screen.findByRole('button', { name: 'Resume' })

      // The pause ended while the Mac slept; its timer stopped with the
      // sleep and has fired for nobody since.
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)
      desktop.wake()

      expect(
        await screen.findByRole('button', { name: 'Pause observing' }),
      ).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads the clock again when the section comes back on screen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { desktop, journal } = await paused()
      const control = showSettingsOnScreen(desktop, journal)
      await screen.findByRole('button', { name: 'Resume' })

      // Each on its own render: a view hidden and shown again in one would
      // never have been away.
      await act(async () => control.hide())
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)
      await act(async () => control.show())

      expect(
        await screen.findByRole('button', { name: 'Pause observing' }),
      ).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
