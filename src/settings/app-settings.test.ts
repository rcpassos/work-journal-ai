import { afterEach, describe, expect, it, vi } from 'vitest'
import { START_AT_LOGIN_KEY } from '../platform/desktop'
import { fakeDesktop } from '../platform/testing/desktop'
import { DEFAULT_WORK_SUMMARY_PROMPT } from './settings'
import { createAppSettings, type ModelAccessChange } from './app-settings'
import { addRepository, turnObserving } from './observing'

// The settings as a running window has them: the core's rules over the
// desktop's store, plus the announcements that keep the other windows honest.

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the Theme', () => {
  it('reads back what was saved, and announces it', async () => {
    const desktop = fakeDesktop()
    const settings = createAppSettings(desktop)
    const heard: string[] = []
    await desktop.onThemeChanged((theme) => heard.push(theme))

    await settings.saveTheme('dark')

    expect(await settings.loadTheme()).toBe('dark')
    expect(heard).toEqual(['dark'])
  })

  it('follows the system until the user has chosen', async () => {
    expect(await createAppSettings(fakeDesktop()).loadTheme()).toBe('system')
  })

  it('records a Theme whose announcement could not be sent', async () => {
    // The emit is what keeps the other windows honest, not what saves — a
    // failed one leaves every window repainted and the file written, and is
    // logged rather than raised, or the saver would be told a Theme was
    // refused that in truth took.
    const desktop = fakeDesktop()
    desktop.announceTheme = () => Promise.reject(new Error('the bus is gone'))
    const settings = createAppSettings(desktop)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await settings.saveTheme('dark')

    expect(await settings.loadTheme()).toBe('dark')
  })
})

describe('start at login', () => {
  it('changes the login item and records the answer', async () => {
    const desktop = fakeDesktop()
    const settings = createAppSettings(desktop)

    await settings.saveStartAtLogin(true)

    expect(desktop.loginItem).toBe(true)
    expect((await settings.load()).startAtLogin).toBe(true)
  })

  it('removes the login item when switched off, and records it', async () => {
    const desktop = fakeDesktop()
    const settings = createAppSettings(desktop)

    await settings.saveStartAtLogin(false)

    expect(desktop.loginItem).toBe(false)
    expect((await settings.load()).startAtLogin).toBe(false)
  })

  it('records nothing the OS refused to do', async () => {
    const desktop = fakeDesktop()
    desktop.setStartAtLogin = () => Promise.reject(new Error('refused'))
    const settings = createAppSettings(desktop)

    await expect(settings.saveStartAtLogin(true)).rejects.toThrow()
    expect((await settings.load()).startAtLogin).toBe(false)
  })

  it('does not announce an older save once a newer one has landed', async () => {
    // Save A turns the login item on and starts writing the file; save B
    // turns it off while that write is still held, and B's write lands
    // first — the OS and the file both hold off. When A's write finally
    // settles it must not announce the on it was asked for: B superseded it,
    // and a control hearing A would read on while the OS and the file held
    // off. The newer save speaks for the answer that came to hold.
    const stored: Record<string, unknown> = { startAtLogin: false }
    let release = () => {}
    const firstWriteHeld = new Promise<void>((resolve) => {
      release = resolve
    })
    let writes = 0
    const desktop = fakeDesktop({
      stored,
      openSettingsStore: async () => ({
        async get<T>(key: string) {
          return stored[key] as T | undefined
        },
        async has(key: string) {
          return key in stored
        },
        async set(key: string, value: unknown) {
          stored[key] = value
          if (key === START_AT_LOGIN_KEY && ++writes === 1) {
            await firstWriteHeld
          }
        },
      }),
    })
    const settings = createAppSettings(desktop)
    const heard: boolean[] = []
    settings.onStartAtLoginChanged((next) => heard.push(next))

    const older = settings.saveStartAtLogin(true)
    await expect.poll(() => writes).toBe(1)
    await settings.saveStartAtLogin(false)

    expect(desktop.loginItem).toBe(false)
    expect(stored.startAtLogin).toBe(false)
    expect(heard).toEqual([false])

    release()
    await older

    // The older save settled after the newer one: its on stays unannounced.
    expect(heard).toEqual([false])
  })
})

describe('importing meetings', () => {
  it('reads back what was saved, and announces it to the window that sweeps', async () => {
    const desktop = fakeDesktop()
    const settings = createAppSettings(desktop)
    let announced = 0
    await desktop.onImportChanged(() => (announced += 1))

    await settings.saveImportMeetings(true)
    await settings.saveImportCalendars(['work'])

    const stored = await settings.load()
    expect(stored.importMeetings).toBe(true)
    expect(stored.importCalendars).toEqual(['work'])
    expect(announced).toBe(2)
  })

  it('is off, with nothing ticked, until the user says otherwise', async () => {
    const stored = await createAppSettings(fakeDesktop()).load()

    expect(stored.importMeetings).toBe(false)
    expect(stored.importCalendars).toEqual([])
  })

  it('announces every settled Import save with the file as it stands', async () => {
    // Save A turns Import on and starts writing the file; save B ticks a
    // calendar while that write is still held, and B's write lands first.
    // Both speak when they settle — each announcement re-reads the file, so
    // no payload can be a superseded answer — and the last one heard is the
    // last write to have landed, whatever order the saves started in.
    const stored: Record<string, unknown> = {}
    let release = () => {}
    const firstWriteHeld = new Promise<void>((resolve) => {
      release = resolve
    })
    let writes = 0
    const desktop = fakeDesktop({
      stored,
      openSettingsStore: async () => ({
        async get<T>(key: string) {
          return stored[key] as T | undefined
        },
        async has(key: string) {
          return key in stored
        },
        async set(key: string, value: unknown) {
          // A write in flight has not landed: what the file holds is what
          // settled before it.
          if (key === 'importMeetings' && ++writes === 1) {
            await firstWriteHeld
          }
          stored[key] = value
        },
      }),
    })
    const settings = createAppSettings(desktop)
    const heard: Array<{ importMeetings: boolean; importCalendars: string[] }> =
      []
    settings.onImportChanged((imported) => heard.push(imported))

    const older = settings.saveImportMeetings(true)
    await expect.poll(() => writes).toBe(1)
    await settings.saveImportCalendars(['work'])

    // The newer save settled first and spoke the file as it stood then.
    await expect
      .poll(() => heard)
      .toEqual([{ importMeetings: false, importCalendars: ['work'] }])

    release()
    await older

    // The older save settles after it — and speaks too, with the file as it
    // stands now: listeners end agreeing with the file on both keys.
    await expect.poll(() => heard).toEqual([
      { importMeetings: false, importCalendars: ['work'] },
      { importMeetings: true, importCalendars: ['work'] },
    ])
    expect(stored.importMeetings).toBe(true)
    expect(stored.importCalendars).toEqual(['work'])
  })
  it('says a save took even when the announcement could not be sent', async () => {
    // The window that sweeps catches up at its next read; the user who
    // pressed is told what the file holds, not that an emit hiccuped.
    const desktop = fakeDesktop()
    desktop.announceImportChanged = () =>
      Promise.reject(new Error('the window is gone'))
    const settings = createAppSettings(desktop)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await settings.saveImportMeetings(true)

    expect((await settings.load()).importMeetings).toBe(true)
  })
})

describe('Model Access', () => {
  it('announces a settled Base URL or Model save as the part it wrote', async () => {
    const desktop = fakeDesktop({ apiKey: 'sk-a-key' })
    let keychainAsks = 0
    const ask = desktop.apiKeySet.bind(desktop)
    desktop.apiKeySet = async () => {
      keychainAsks += 1
      return ask()
    }
    const settings = createAppSettings(desktop)
    const heard: ModelAccessChange[] = []
    settings.onModelAccessChanged((change) => heard.push(change))

    await settings.saveModelBaseUrl('http://localhost:11434/v1')
    await settings.saveModel('llama3.1')

    // Each save says only the part it wrote, so the other surface can apply
    // exactly what changed — and a field save never asks the Keychain, so a
    // keystroke cannot put a Keychain prompt in front of the user.
    expect(heard).toEqual([
      { modelBaseUrl: 'http://localhost:11434/v1' },
      { model: 'llama3.1' },
    ])
    expect(keychainAsks).toBe(0)
    // The file holds both fields, whichever order they settled in.
    const stored = await settings.load()
    expect(stored.modelBaseUrl).toBe('http://localhost:11434/v1')
    expect(stored.model).toBe('llama3.1')
  })

  it('announces a Key handed to the Keychain, and one taken out of it', async () => {
    const desktop = fakeDesktop()
    const settings = createAppSettings(desktop)
    const heard: ModelAccessChange[] = []
    settings.onModelAccessChanged((change) => heard.push(change))

    await settings.saveApiKey('sk-a-key')
    await settings.clearApiKey()

    // A Key save knows the Keychain now holds — or no longer holds — a Key
    // without asking it again, and announces that answer alone.
    await expect.poll(() => heard).toEqual([
      { keySet: true },
      { keySet: false },
    ])
    // The Key is a Keychain matter, never a settings-file one.
    expect(desktop.apiKey).toBe(null)
    expect(desktop.stored.apiKey).toBeUndefined()
  })

  it('records a Key the Keychain refused to take, announcing nothing', async () => {
    const desktop = fakeDesktop({ keychainRefuses: true })
    const settings = createAppSettings(desktop)
    const heard: ModelAccessChange[] = []
    settings.onModelAccessChanged((change) => heard.push(change))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(settings.saveApiKey('sk-a-key')).rejects.toThrow()
    // No settled save speaks for one that never landed.
    expect(heard).toEqual([])
  })

  it('announces a field save even while the Keychain is shut', async () => {
    // The announcement never asks the Keychain, so a Keychain that refuses
    // to answer cannot take a field save's announcement down with it — the
    // mounted group is not left on a stale field until its next mount.
    const desktop = fakeDesktop({ keychainRefuses: true })
    const settings = createAppSettings(desktop)
    const heard: ModelAccessChange[] = []
    settings.onModelAccessChanged((change) => heard.push(change))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await settings.saveModelBaseUrl('http://localhost:11434/v1')

    expect(heard).toEqual([{ modelBaseUrl: 'http://localhost:11434/v1' }])
    expect((await settings.load()).modelBaseUrl).toBe(
      'http://localhost:11434/v1',
    )
  })

  it('discards an older overlapping field save once a newer one has been started', async () => {
    // The older save settles after the newer one has been typed: were it to
    // speak, its older value would go back under the cursor after the newer
    // keystroke rendered. Only the save that is still the newest of its part
    // announces.
    const stored: Record<string, unknown> = {}
    let releaseOldWrite = () => {}
    const oldWriteHeld = new Promise<void>((resolve) => {
      releaseOldWrite = resolve
    })
    let writes = 0
    const desktop = fakeDesktop({
      stored,
      openSettingsStore: async () => ({
        async get<T>(key: string) {
          return stored[key] as T | undefined
        },
        async has(key: string) {
          return key in stored
        },
        async set(key: string, value: unknown) {
          writes += 1
          // The first keystroke's write stays in flight while the second
          // settles.
          if (writes === 1) await oldWriteHeld
          stored[key] = value
        },
      }),
    })
    const settings = createAppSettings(desktop)
    const heard: ModelAccessChange[] = []
    settings.onModelAccessChanged((change) => heard.push(change))

    const first = settings.saveModelBaseUrl('http://stale.example/v1')
    await settings.saveModelBaseUrl('http://localhost:11434/v1')
    releaseOldWrite()
    await first

    // Only the newer save spoke: the older one settling late held its tongue
    // rather than putting the stale value back.
    expect(heard).toEqual([{ modelBaseUrl: 'http://localhost:11434/v1' }])
  })
})

describe('the Work Summary Prompt', () => {
  it('opens at the shipped prompt until the user has written their own', async () => {
    const stored = await createAppSettings(fakeDesktop()).load()

    expect(stored.workSummaryPrompt).toBe(DEFAULT_WORK_SUMMARY_PROMPT)
  })

  it('reads back what was saved', async () => {
    const desktop = fakeDesktop()
    const settings = createAppSettings(desktop)

    await settings.saveWorkSummaryPrompt('Write it in pirate speak.')

    expect((await settings.load()).workSummaryPrompt).toBe('Write it in pirate speak.')
  })
})

describe('Observing', () => {
  const at = (time: string) => ({ now: () => new Date(time) })

  it('applies a change to the file as it stands, at the instant it is made, and announces it', async () => {
    const desktop = fakeDesktop()
    let clock = at('2026-03-09T18:40:00')
    const settings = createAppSettings(desktop, { now: () => clock.now() })
    let heard = 0
    await desktop.onObservingChanged(() => (heard += 1))

    const saved = await settings.updateObserving((observing, now) =>
      turnObserving(observing, true, now),
    )
    clock = at('2026-03-09T19:00:00')
    await settings.updateObserving((observing, now) =>
      addRepository(
        observing,
        { path: '/code/a', repository: '/code/a/.git', identities: [], ignoredPrefixes: [] },
        now,
      ),
    )

    expect(saved.enabled).toBe(true)
    expect((await settings.load()).observing.consent).toEqual({
      '/code/a/.git': [{ from: new Date('2026-03-09T19:00:00').getTime(), until: null }],
    })
    expect(heard).toBe(2)
  })

  it('never loses one change to another made while it was still being written', async () => {
    const desktop = fakeDesktop()
    const settings = createAppSettings(desktop)
    const repository = (name: string) => ({
      path: `/code/${name}`,
      repository: `/code/${name}/.git`,
      identities: [],
      ignoredPrefixes: [],
    })

    await Promise.all([
      settings.updateObserving((observing, now) => addRepository(observing, repository('a'), now)),
      settings.updateObserving((observing, now) => addRepository(observing, repository('b'), now)),
    ])

    expect(
      (await settings.load()).observing.repositories.map(({ path }) => path),
    ).toEqual(['/code/a', '/code/b'])
  })
})
