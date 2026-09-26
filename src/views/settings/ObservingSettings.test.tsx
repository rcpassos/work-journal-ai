// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
import { createObserveSession } from '@/journal/observe-session'
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

function showSettings(
  desktop: FakeDesktop,
  journal: Promise<Journal> = new Promise<Journal>(() => {}),
) {
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
    openJournals.push(close)
    return createJournal({ clock: fixedClock('2026-03-09T10:00:00'), driver })
  })
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

/** The commit sweep, running as the app runs it over this desktop. */
function sweeping(desktop: FakeDesktop, journal: Promise<Journal>) {
  const clock = fixedClock(new Date())
  const settings = createAppSettings(desktop, clock)
  return createObserveSession({ journal, desktop, settings, clock })
}

/** Lets a sweep the session started on its own finish before asserting. */
async function flushSweep(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve()
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

describe('a repository whose state moves on', () => {
  it('takes its reason away when the first commit becomes no Note, and shows it again when the folder goes', async () => {
    const { journal } = await journalWith()
    const desktop = fakeDesktop({
      stored: {
        observing: {
          enabled: true,
          repositories: [
            {
              path: '/code/fresh',
              repository: '/code/fresh/.git',
              identities: ['me@example.com'],
              ignoredPrefixes: ['Merge'],
            },
          ],
          consent: { '/code/fresh/.git': [{ from: 1, until: null }] },
          pauses: {},
        },
      },
      repositories: {
        '/code/fresh': {
          repository: '/code/fresh/.git',
          configuredEmail: 'me@example.com',
          commits: [],
          noHead: true,
        },
      },
    })
    showSettings(desktop, journal)
    expect(
      await screen.findByText(
        'The default branch of that repository cannot be resolved. Its commits are not being added.',
      ),
    ).toBeTruthy()

    // The sweep, as the app runs it. What Settings says about a repository
    // follows the sweep: it is the only thing that sees the disk move, and
    // nothing here announces anything by hand.
    const session = sweeping(desktop, journal)
    await session.start()

    // The first commit lands — a merge, which is never a Note. The journal
    // says nothing happened at all.
    desktop.repositories['/code/fresh'] = {
      repository: '/code/fresh/.git',
      configuredEmail: 'me@example.com',
      commits: [
        {
          hash: 'm1',
          subject: "Merge branch 'main'",
          author: 'me@example.com',
          authoredAt: Date.now(),
        },
      ],
    }
    desktop.beginCapture()
    await flushSweep()

    // The reason and a Note must never stand beside each other — and here
    // there is no Note at all.
    await expect
      .poll(() => screen.queryByText(/Its commits are not being added\./))
      .toBeNull()
    expect(
      await screen.findByText('Nothing yet since you turned this on'),
    ).toBeTruthy()

    // And the other way: a folder deleted while Settings sits open is flagged.
    desktop.repositories['/code/fresh'] = 'missing'
    desktop.beginCapture()
    await flushSweep()

    expect(await screen.findByText(/^That folder is gone\./)).toBeTruthy()
    session.stop()
  })

  it('applies only its newest read: an older one landing late is not heard', async () => {
    const { journal } = await journalWith()
    const { desktop } = listedAt('/code/work-journal-ai', WORK_JOURNAL, journal)
    // A slow disk: every read answers with what it saw when it began, and
    // lands only when the test lets it.
    const held: Array<() => void> = []
    const disk = desktop.repositoryIdentities.bind(desktop)
    desktop.repositoryIdentities = async (path) => {
      const answer = await disk(path)
      await new Promise<void>((resolve) => held.push(resolve))
      return answer
    }
    showSettings(desktop, journal)
    await screen.findByRole('checkbox', { name: 'me@example.com' })
    expect(held).toHaveLength(1)

    // The folder goes, and the sweep's word of it arrives while that first
    // read is still in flight — the section never leaves the screen, so the
    // two reads are one after the other and only which is newest can speak.
    desktop.repositories['/code/work-journal-ai'] = 'missing'
    await act(async () => desktop.announceRepositoryStateChanged())
    expect(held).toHaveLength(2)

    // The newer read lands: gone. (The later of the two held — the earlier
    // one is the read that began when the folder was still there.)
    const newer = held.pop()
    if (newer) await act(async () => newer())
    expect(await screen.findByText(/^That folder is gone\./)).toBeTruthy()

    // And then the older one, which saw the folder where it was.
    const older = held.shift()
    if (older) await act(async () => older())
    expect(screen.queryByText(/^That folder is gone\./)).toBeTruthy()
  })

  it('is read again only for what the repository says about itself', async () => {
    const { journal } = await journalWith()
    const { desktop } = listedAt('/code/work-journal-ai', WORK_JOURNAL, journal)
    const reads = vi.spyOn(desktop, 'repositoryIdentities')
    showSettings(desktop, journal)
    await screen.findByRole('checkbox', { name: 'me@example.com' })
    await expect.poll(() => reads.mock.calls.length).toBeGreaterThan(0)
    const asked = reads.mock.calls.length

    // A sweep lands a Note: the journal changes, the repository does not.
    desktop.repositories['/code/work-journal-ai'] = {
      ...WORK_JOURNAL,
      commits: [
        {
          hash: 'n1',
          subject: 'A Note',
          author: 'me@example.com',
          authoredAt: Date.now(),
        },
      ],
    }
    const session = sweeping(desktop, journal)
    await session.start()
    await flushSweep()

    // The Last line follows the journal. The reason line is not re-read for
    // it: every journal change reading git again was the cost of that.
    expect(await screen.findByText(/^Last: A Note/)).toBeTruthy()
    expect(reads.mock.calls.length).toBe(asked)
    session.stop()
  })

  it('is not read while the section is off screen, and once when it comes back', async () => {
    const { journal } = await journalWith()
    const { desktop } = listedAt('/code/work-journal-ai', WORK_JOURNAL, journal)
    const control = showSettingsOnScreen(desktop, journal)
    await screen.findByRole('checkbox', { name: 'me@example.com' })
    const reads = vi.spyOn(desktop, 'repositoryIdentities')

    await act(async () => control.hide())
    expect(reads).not.toHaveBeenCalled()

    await act(async () => control.show())
    expect(reads).toHaveBeenCalledTimes(1)
  })

  it('reads its reason again when the section comes back on screen', async () => {
    const { journal } = await journalWith()
    const { desktop } = listedAt('/code/work-journal-ai', WORK_JOURNAL, journal)
    const control = showSettingsOnScreen(desktop, journal)
    await screen.findByRole('checkbox', { name: 'me@example.com' })

    await act(async () => control.hide())
    desktop.repositories['/code/work-journal-ai'] = 'missing'
    await act(async () => control.show())

    expect(await screen.findByText(/^That folder is gone\./)).toBeTruthy()
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

  // A repository whose last Note arrived just now: the line to age.
  async function arrived() {
    const { journal } = await journalWith([
      {
        source: 'commit',
        eventKey: '9a1c@/code/work-journal-ai/.git',
        body: 'Age in place',
        happenedAt: new Date().toISOString(),
        project: null,
      },
    ])
    const { desktop } = listedAt('/code/work-journal-ai', WORK_JOURNAL, journal)
    return { desktop, journal }
  }

  it('ages its "ago" as the Last line sits there', async () => {
    const { desktop, journal } = await arrived()
    // Faked from the render on — Date and the line's own tick — so the words
    // move as the test says: they are computed at render and would otherwise
    // say "just now" for the rest of the afternoon. The rest of the timers
    // stay real: the journal's own work needs them.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    try {
      showSettings(desktop, journal)
      expect(await screen.findByText(/· just now$/)).toBeTruthy()

      await act(async () => {
        vi.advanceTimersByTime(2 * 60 * 60 * 1000)
      })

      expect(screen.getByText(/· 2 h ago$/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads the clock again when the section comes back on screen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { desktop, journal } = await arrived()
      const control = showSettingsOnScreen(desktop, journal)
      expect(await screen.findByText(/· just now$/)).toBeTruthy()

      // Two hours in another section: left alone, the line would say "just
      // now" of a Note two hours old until the next tick came round. Each on
      // its own render: a view hidden and shown again in one would never have
      // been away.
      await act(async () => control.hide())
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)
      await act(async () => control.show())

      expect(screen.getByText(/· 2 h ago$/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads the clock again when the Mac wakes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { desktop, journal } = await arrived()
      showSettings(desktop, journal)
      expect(await screen.findByText(/· just now$/)).toBeTruthy()

      // The Mac slept through the age: its tick froze with the sleep and has
      // fired for nobody since.
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)
      await act(async () => desktop.wake())

      expect(screen.getByText(/· 2 h ago$/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
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

describe('the Project field', () => {
  /** The repository added, and the field its row carries. */
  async function addedRepository() {
    const desktop = observingDesktop()
    desktop.chosenFolder = '/code/work-journal-ai'
    const { core } = showSettings(desktop, openJournal())
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
    const { core } = showSettings(desktop, openJournal())
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

  it('keeps the mapping when Enter is pressed with nothing typed', async () => {
    const user = userEvent.setup()
    const { core, field } = await addedRepository()

    await user.click(field)
    await user.keyboard('Beta{Enter}')
    await expect.poll(() => mapped(core)).toBe('beta')

    // Enter on a field nothing was typed into is no decision at all: only a
    // field the user has emptied takes the mapping away.
    await user.keyboard('{Enter}')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(field.value).toBe('beta')
    expect(await mapped(core)).toBe('beta')
    expect(toasts()).not.toContain('Commits will be Unfiled.')
  })

  it('shows the name a rename moved it to, once the journal says so', async () => {
    const user = userEvent.setup()
    const { desktop, core, field } = await addedRepository()

    await user.click(field)
    await user.keyboard('Beta{Enter}')
    await expect.poll(() => mapped(core)).toBe('beta')

    // A rename in History rewrites the mapping with everything else — and
    // announces the journal, which is what this row hears it by.
    await (await core).renameProject('beta', 'gamma')
    await desktop.announceJournalChanged()

    await expect.poll(() => field.value).toBe('gamma')
  })

  it('gives Escape back to the window once there is nothing to abandon', async () => {
    const user = userEvent.setup()
    const { desktop, core, field } = await addedRepository()

    await user.click(field)
    await user.keyboard('Beta{Enter}')
    await expect.poll(() => mapped(core)).toBe('beta')

    // What was typed is the field's to abandon, and the window stays.
    await user.keyboard('Gamma{Escape}')
    expect(field.value).toBe('beta')
    expect(desktop.windowsClosed).toBe(0)

    // Abandoned, the window has Escape back.
    await user.keyboard('{Escape}')
    await expect.poll(() => desktop.windowsClosed).toBe(1)
  })

  it('saves two quick changes in the order they were made', async () => {
    const first = heldWrite()
    const journal = openJournal().then((core) => ({
      ...core,
      setProjectMapping: (repository: string, project: string | null) => {
        if (first.unused) {
          first.unused = false
          return first.held.then(() => core.setProjectMapping(repository, project))
        }
        return core.setProjectMapping(repository, project)
      },
    }))
    const user = userEvent.setup()
    const desktop = observingDesktop()
    desktop.chosenFolder = '/code/work-journal-ai'
    const { core } = showSettings(desktop, journal)
    ;(await screen.findByRole('button', { name: 'Add Repository…' })).click()
    const field = (await screen.findByLabelText('Project')) as HTMLInputElement

    await user.click(field)
    await user.keyboard('Beta{Enter}')
    await user.clear(field)
    await user.keyboard('Gamma{Enter}')
    first.settle('saved')

    // The older save must not settle last and hold the journal where the
    // field no longer is.
    await expect.poll(() => mapped(core)).toBe('gamma')
    expect(field.value).toBe('gamma')
  })

  it('puts nothing back when a save is refused after a newer one has landed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = heldWrite()
    const journal = openJournal().then((core) => ({
      ...core,
      setProjectMapping: (repository: string, project: string | null) => {
        if (first.unused) {
          first.unused = false
          return first.held.then(() => core.setProjectMapping(repository, project))
        }
        return core.setProjectMapping(repository, project)
      },
    }))
    const user = userEvent.setup()
    const desktop = observingDesktop()
    desktop.chosenFolder = '/code/work-journal-ai'
    const { core } = showSettings(desktop, journal)
    ;(await screen.findByRole('button', { name: 'Add Repository…' })).click()
    const field = (await screen.findByLabelText('Project')) as HTMLInputElement

    await user.click(field)
    await user.keyboard('Beta{Enter}')
    await user.clear(field)
    await user.keyboard('Gamma{Enter}')
    first.settle('refused')

    // The refusal is said of the save it belongs to — and a rollback is
    // discarded once a newer change has landed (ADR 0028): what the newer
    // save put down stays, in the field and in the journal.
    await expect.poll(() => mapped(core)).toBe('gamma')
    expect(field.value).toBe('gamma')
    await expect.poll(toasts).toContain('Commits will be filed under #gamma.')
  })
})

/** A write whose settlement this test decides, and with what. */
function heldWrite() {
  let settle!: (outcome: 'saved' | 'refused') => void
  const held = new Promise<void>((resolve, reject) => {
    settle = (outcome) =>
      outcome === 'saved' ? resolve() : reject(new Error('no database'))
  })
  held.catch(() => {})
  return { held, settle, unused: true }
}
