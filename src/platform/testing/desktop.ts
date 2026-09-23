import type { CalendarEvent, SqlDriver, TaskAlert } from '../../journal/journal'
import type { HotkeyStatuses } from '../../settings/hotkey'
import type { SettingsStore } from '../../settings/settings'
import type { Theme } from '../../settings/theme'
import type {
  AppIdentity,
  AutomaticBackups,
  AvailableUpdate,
  BackupResult,
  CalendarAccess,
  CalendarInfo,
  CaptureFit,
  Commit,
  CommitsRead,
  Desktop,
  ExportedFile,
  IdentitiesRead,
  MainSection,
  OnboardingState,
  PracticeEnded,
  RepositoryUnreadable,
  WorkSummaryRequest,
  WorkSummaryResponse,
  TaskAlertCompletion,
  TaskAlertPermission,
  Unlisten,
} from '../desktop'

/** One commit on a fake repository, with the address that wrote it. */
export interface FakeCommit extends Omit<Commit, 'repository'> {
  author: string
}

/**
 * A repository the fake reader can read: its identity, the address
 * `git config user.email` would answer with, and its first-parent history,
 * newest first — what the real reader walks, already walked.
 */
export interface FakeRepository {
  repository: string
  configuredEmail?: string
  commits: FakeCommit[]
}

/**
 * The desktop a test runs on: the same surface, in memory. Announcements are
 * delivered to every subscriber, including the window that made them — which
 * is what the real one does too, so a test sees what a second window would.
 */
export interface FakeDesktop extends Desktop {
  /** Shows the capture window, as an Entry Point would. */
  beginCapture(): void
  /** Shows the Task Creation window, as a Task Entry Point would. */
  showTaskCreation(): void
  /** How many times a Task Entry Point asked for the resident window. */
  taskCreationsBegun: number
  /** How many times practice asked for the real Capture window. */
  practiceCapturesBegun: number
  /** How many times the window the caller is in was closed. */
  windowsClosed: number
  /** How many times a Task Creation was dismissed. */
  taskCreationsDismissed: number
  /** How many times a Capture was dismissed. */
  capturesDismissed: number
  /** Every size the Task Creation window was asked to take, most recent last. */
  taskCreationFits: boolean[]
  /** What the settings store holds, readable without going through a facade. */
  stored: Record<string, unknown>
  /**
   * Where automatic Onboarding stands, as the marker the Rust side keeps.
   * Writable, as the classification writes it before this window exists — a
   * test of automatic presentation sets it to `unfinished`.
   */
  onboarding: OnboardingState
  /** Whether the login item is there, as the OS would report it. */
  loginItem: boolean
  /** Every export written, most recent last. */
  exported: Array<{ markdown: string; fileName: string }>
  /**
   * What the save dialog answers with: a path, or null for a cancelled one.
   * Writable, so the three cases — cancel, pick-then-succeed,
   * pick-then-fail — are separately scriptable.
   */
  chosenBackupLocation: string | null
  /** Every backup written, most recent last. */
  backups: string[]
  /** Whether a backup write fails, as it does when the disk refuses. */
  backupFails: boolean
  /**
   * What the open dialog answers with: a path, or null for a cancelled one.
   * Writable, so the cases — cancel, pick-then-stage, pick-then-refuse — are
   * separately scriptable.
   */
  chosenRestoreCandidate: string | null
  /** Every restore staged, most recent last. */
  stagedRestores: string[]
  /**
   * Why staging refuses, as the Rust side's validation would say it. Null
   * stages cleanly; set, staging throws it and stages nothing.
   */
  restoreError: string | null
  /**
   * What the automatic backups look like; writable, as an emptied folder is.
   * Named `automaticBackupStatus` because the interface member of the same
   * shape on `Desktop` is the method that reads it.
   */
  automaticBackupStatus: AutomaticBackups
  /** How many times the backups folder was revealed. */
  backupsRevealed: number
  /** Whether revealing fails, as it does when the folder is gone. */
  revealFails: boolean
  /** Every size the Capture window was asked to take, most recent last. */
  fits: CaptureFit[]
  /** What is beside the menu bar glyph; null until something is put there. */
  trayTitle: string | null
  /** What is on the clipboard; null until something is copied there. */
  clipboard: string | null
  /** The Tray Menu asks for yesterday's Digest. */
  requestYesterdayDigest(): void
  /** The machine wakes from sleep. */
  wake(): void
  /** Whether the caller's window is on screen, as the OS would report it. */
  windowVisible: boolean
  /** The window loses focus, as it does when another application takes it. */
  blur(): void
  /** The window gets focus back, as it does when the user returns to it. */
  focus(): void
  /** The user dismisses the window, as the traffic light does. */
  requestClose(): void
  /** What macOS allows of Task Alerts; writable, as a revocation is. */
  alertPermission: TaskAlertPermission
  /** Whether the app has ever asked for Task Alert permission. */
  alertPrompted: boolean
  /** The pending requests macOS holds, as the last reconciliation left them. */
  pendingAlerts: TaskAlert[]
  /** Every reconciliation asked for, most recent last. */
  reconciliations: TaskAlert[][]
  /** Whether reconciling fails, as it does when the OS refuses. */
  alertsFail: boolean
  /**
   * An Entry Point names a section of the Main Window — the Tray Menu, or a
   * clicked Task Alert. Written down for a window that has yet to ask, and
   * announced for one already on screen, so whichever section was named last
   * is the one the window lands on.
   *
   * Null is an Entry Point that names no section — a click on the Dock icon,
   * which opens the window on History and takes away whatever an earlier
   * request left waiting.
   */
  requestSection(section: MainSection | null): void
  /**
   * The section waiting to be claimed by the Main Window it named. Null when
   * nothing has asked for one, which resolves to History.
   */
  pendingSection: MainSection | null
  /** How many times a window has asked which section it opened on. */
  sectionsClaimed: number
  /** The user clicks a Task Alert. */
  openTaskAlert(taskId: string): void
  /** The user chooses Complete on a Task Alert. */
  completeTaskAlert(completion: TaskAlertCompletion): void
  /**
   * The Complete actions waiting to be claimed by the Capture window they are
   * addressed to — what choices made while the app was not running leave
   * behind. Empty when nothing chose one.
   */
  pendingTaskAlertCompletion: TaskAlertCompletion[]
  /**
   * The Alert waiting to be claimed by the window it opened — what a click
   * that built the window leaves behind. Null when the window was opened any
   * other way.
   */
  pendingTaskAlert: string | null
  /** How many times System Settings was opened at Notifications. */
  notificationSettingsOpened: number
  /** What the OS allows of the calendars; writable, as a revocation is. */
  access: CalendarAccess
  /** Whether the user was ever asked, and what they said if they were. */
  prompted: boolean
  /** What the calendars hold today. */
  events: CalendarEvent[]
  /** The API Key the Keychain holds; null when there is none. */
  apiKey: string | null
  /**
   * Whether the Keychain refuses to answer at all — locked, or a prompt the
   * user denied. Writable, because that is how it happens: a Keychain open a
   * moment ago can be shut.
   */
  keychainRefuses: boolean
  /**
   * The release a check finds, or null when this build is the latest.
   * Writable: a check made after one was installed finds nothing.
   */
  availableUpdate: AvailableUpdate | null
  /** How big the found release is, as the download reports it. */
  updateSize: number
  /** How many times an update was looked for. */
  updateChecks: number
  /** How many times the found update was installed. */
  updatesInstalled: number
  /** How many times the app was asked to restart into what it installed. */
  restarts: number
  /** Whether looking fails, as it does with nothing to reach. */
  updateCheckFails: boolean
  /** Whether installing fails, as it does when the bundle cannot be written. */
  updateInstallFails: boolean
  /** Every Work Summary call asked for, most recent last. */
  workSummaryRequests: WorkSummaryRequest[]
  /**
   * How a Work Summary call answers. Writable, so a test can script a failure
   * or a second generation answering differently.
   */
  workSummaryResponse: WorkSummaryResponse
  /**
   * What is on disk, by path: a repository, or why the path is not one that
   * can be read. A path not here is missing. Writable, as a disk is.
   */
  repositories: Record<string, FakeRepository | RepositoryUnreadable>
  /** The folder the next picker answers with; null is a cancel. */
  chosenFolder: string | null
}

export function fakeDesktop({
  driver,
  stored = {},
  hotkey = {
    note: { state: 'registered', hotkey: 'Ctrl+Shift+Cmd+J' },
    task: { state: 'registered', hotkey: 'Ctrl+Shift+Cmd+T' },
  },
  appIdentity = { version: 'test', isDevelopment: true },
  openSettingsStore,
  access = 'undetermined',
  answersPrompt = 'granted',
  alertPermission = 'undetermined',
  answersAlertPrompt = 'granted',
  calendars = [],
  events = [],
  apiKey = null,
  keychainRefuses = false,
  repositories = {},
}: {
  /** Only the tests that reach the journal need one. */
  driver?: SqlDriver
  stored?: Record<string, unknown>
  hotkey?: HotkeyStatuses
  appIdentity?: AppIdentity
  /** Overridden by the tests about a settings file that cannot be read. */
  openSettingsStore?: () => Promise<SettingsStore>
  /** What the OS allows before anybody asks. */
  access?: CalendarAccess
  /** What answering the prompt comes to. */
  answersPrompt?: CalendarAccess
  /** What macOS allows of Task Alerts before anybody asks. */
  alertPermission?: TaskAlertPermission
  /** What answering the Task Alert prompt comes to. */
  answersAlertPrompt?: TaskAlertPermission
  calendars?: CalendarInfo[]
  events?: CalendarEvent[]
  /** What the Keychain already holds, as a previous run would have left it. */
  apiKey?: string | null
  /** Whether the Keychain is locked, or the prompt was refused. */
  keychainRefuses?: boolean
  repositories?: Record<string, FakeRepository | RepositoryUnreadable>
} = {}): FakeDesktop {
  const captureShown = subscribers<boolean>()
  const windowBlurred = subscribers<void>()
  const taskCreationShown = subscribers<void>()
  const tasksChanged = subscribers<void>()
  const systemWoke = subscribers<void>()
  const importChanged = subscribers<void>()
  const observingChanged = subscribers<void>()
  const yesterdayDigestRequested = subscribers<void>()
  const noteCaptured = subscribers<string>()
  const practiceEnded = subscribers<PracticeEnded>()
  const journalChanged = subscribers<void>()
  const themeChanged = subscribers<Theme>()
  const windowFocused = subscribers<void>()
  const closeRequested = subscribers<void>()
  const sectionRequested = subscribers<MainSection>()
  const taskAlertOpened = subscribers<string>()
  const taskAlertCompleted = subscribers<TaskAlertCompletion>()
  const taskAlertsReconciled = subscribers<boolean>()

  const desktop: FakeDesktop = {
    stored,
    onboarding: 'suppressed',
    loginItem: false,
    exported: [],
    chosenBackupLocation: null,
    backups: [],
    backupFails: false,
    chosenRestoreCandidate: null,
    stagedRestores: [],
    restoreError: null,
    automaticBackupStatus: { count: 0, newestTakenAt: null },
    backupsRevealed: 0,
    revealFails: false,
    fits: [],
    trayTitle: null,
    clipboard: null,
    access,
    prompted: false,
    events,
    windowsClosed: 0,
    taskCreationsBegun: 0,
    practiceCapturesBegun: 0,
    taskCreationsDismissed: 0,
    capturesDismissed: 0,
    taskCreationFits: [],
    alertPermission,
    alertPrompted: false,
    pendingAlerts: [],
    reconciliations: [],
    alertsFail: false,
    notificationSettingsOpened: 0,
    pendingSection: null,
    sectionsClaimed: 0,
    pendingTaskAlert: null,
    pendingTaskAlertCompletion: [],
    apiKey,
    keychainRefuses,
    availableUpdate: null,
    updateSize: UPDATE_SIZE,
    updateChecks: 0,
    updatesInstalled: 0,
    restarts: 0,
    updateCheckFails: false,
    updateInstallFails: false,
    workSummaryRequests: [],
    workSummaryResponse: { state: 'generated', markdown: GENERATED_SUMMARY },
    repositories,
    chosenFolder: null,

    beginCapture: () => captureShown.announce(false),
    showTaskCreation: () => taskCreationShown.announce(undefined),
    requestYesterdayDigest: () => yesterdayDigestRequested.announce(undefined),
    wake: () => systemWoke.announce(undefined),

    windowLabel: () => 'main',
    appIdentity: async () => appIdentity,
    // The marker is the Rust side's to write; this only reports it and flips
    // it to suppressed on a dismissal, exactly as the commands do.
    onboardingState: async () => desktop.onboarding,
    dismissOnboarding: async () => {
      desktop.onboarding = 'suppressed'
    },
    closeWindow: async () => {
      desktop.windowsClosed += 1
      // Every path that closes the window — the traffic lights, Escape, a
      // view's own Close — reaches the same OS close the real desktop
      // funnels through `onCloseRequested`, so the answers registered there
      // (an automatic Onboarding dismissal) run for each of them.
      closeRequested.announce(undefined)
    },
    windowVisible: true,
    blur: () => windowBlurred.announce(undefined),
    focus: () => windowFocused.announce(undefined),
    requestClose: () => closeRequested.announce(undefined),
    onWindowBlurred: async (handle) => windowBlurred.add(handle),
    onWindowFocused: async (handle) => windowFocused.add(handle),
    isWindowVisible: async () => desktop.windowVisible,
    onCloseRequested: async (closing) => closeRequested.add(closing),

    openJournalDatabase: async () => {
      if (driver === undefined) {
        throw new Error('This fake desktop was built without a database.')
      }
      return driver
    },

    openSettingsStore:
      openSettingsStore ??
      (async () => ({
        async get<T>(key: string) {
          return desktop.stored[key] as T | undefined
        },
        async has(key: string) {
          return key in desktop.stored
        },
        async set(key: string, value: unknown) {
          desktop.stored[key] = value
        },
      })),

    dismissCapture: async () => {
      desktop.capturesDismissed += 1
    },
    // A practice ending goes away through its own dismiss, which returns
    // focus to the Main Window and reports the outcome for the attempt
    // holding it — exactly as the command does.
    dismissPracticeCapture: async (ended) => {
      desktop.capturesDismissed += 1
      practiceEnded.announce(ended)
    },
    announcePracticeEnded: async (ended) => practiceEnded.announce(ended),
    onPracticeEnded: async (handle) => practiceEnded.add(handle),
    // Practice reaches the same resident window ordinary Capture does: the
    // real one, counted separately so a test can tell practice asked for it.
    // The showing carries that it is practice, as the Rust side's does.
    beginPracticeCapture: async () => {
      desktop.practiceCapturesBegun += 1
      captureShown.announce(true)
    },
    fitCapture: async (fit) => {
      desktop.fits.push(fit)
    },
    onCaptureShown: async (handle) => captureShown.add(handle),

    // Every Task Entry Point reaches the same resident window: the real one
    // focuses it without resetting it, so this only counts the asking.
    beginTaskCreation: async () => {
      desktop.taskCreationsBegun += 1
      taskCreationShown.announce(undefined)
    },
    dismissTaskCreation: async () => {
      desktop.taskCreationsDismissed += 1
    },
    onTaskCreationShown: async (handle) => taskCreationShown.add(handle),
    fitTaskCreation: async (refused) => {
      desktop.taskCreationFits.push(refused)
    },
    announceTasksChanged: async () => tasksChanged.announce(undefined),
    onTasksChanged: async (handle) => tasksChanged.add(handle),

    taskAlertPermission: async () => desktop.alertPermission,
    requestTaskAlertPermission: async () => {
      desktop.alertPrompted = true
      // macOS answers for the user once it has an answer on file: after a
      // denial the prompt never appears again, whatever the app does.
      if (desktop.alertPermission === 'undetermined') {
        desktop.alertPermission = answersAlertPrompt
      }
      return desktop.alertPermission
    },
    reconcileTaskAlerts: async (alerts) => {
      if (desktop.alertsFail) {
        throw new Error('macOS refused the Task Alerts.')
      }
      desktop.reconciliations.push(alerts)
      // Nothing is pending without permission, exactly as macOS has it.
      desktop.pendingAlerts =
        desktop.alertPermission === 'granted' ? alerts : []
    },
    requestSection: (section) => {
      // Both, exactly as the Rust side does it: written down for a Main Window
      // that has yet to ask — one this request is about to build, or one still
      // starting up — and announced for a window already listening.
      desktop.pendingSection = section
      if (section !== null) sectionRequested.announce(section)
    },
    requestedSection: async () => {
      // Handed over exactly once, like the Alert: the section an Entry Point
      // named is for the window it opened, not for every window after it.
      desktop.sectionsClaimed += 1
      const waiting = desktop.pendingSection
      desktop.pendingSection = null
      return waiting
    },
    onSectionRequested: async (handle) => {
      // Listening begins only once this has settled, as it does across the
      // IPC: a window whose webview is still coming up hears nothing, which
      // is the whole reason an Entry Point writes its section down as well.
      await Promise.resolve()
      return sectionRequested.add(handle)
    },

    onTaskAlertOpened: async (handle) => taskAlertOpened.add(handle),
    onTaskAlertCompleted: async (handle) => taskAlertCompleted.add(handle),
    announceTaskAlertsReconciled: async (held) =>
      taskAlertsReconciled.announce(held),
    onTaskAlertsReconciled: async (handle) => taskAlertsReconciled.add(handle),
    openTaskAlert: (taskId) => {
      // Both, exactly as the Rust side does it: written down for a Tasks View
      // that this very click is about to build, and announced for one that is
      // already on screen. Whichever claims it, it is claimed once.
      desktop.pendingTaskAlert = taskId
      taskAlertOpened.announce(taskId)
    },
    openedTaskAlert: async () => {
      // Handed over exactly once, as the real one is: an Alert singles a Task
      // out for the window it opened, not for every window after it.
      const waiting = desktop.pendingTaskAlert
      desktop.pendingTaskAlert = null
      return waiting
    },
    completeTaskAlert: (completion) => {
      // Both, exactly as the Rust side does it: written down for a Capture
      // window that has yet to ask — a choice made while the app was not
      // running — and announced for one already listening. Whatever is
      // written down is claimed once, and one choice never destroys another.
      // The default-click handoff is untouched.
      desktop.pendingTaskAlertCompletion.push(completion)
      taskAlertCompleted.announce(completion)
    },
    completedTaskAlert: async () => {
      // Handed over exactly once, as the real one is: whatever is waiting is
      // taken, and the next ask finds nothing.
      const waiting = desktop.pendingTaskAlertCompletion
      desktop.pendingTaskAlertCompletion = []
      return waiting
    },
    focusTaskAlert: async (alertId) => {
      // A stale Complete opens for review through the very same delivery a
      // click uses: written down for a Tasks View about to be built, and
      // announced for one already on screen.
      desktop.openTaskAlert(alertId)
    },
    openNotificationSettings: async () => {
      desktop.notificationSettingsOpened += 1
    },
    onYesterdayDigestRequested: async (handle) =>
      yesterdayDigestRequested.add(handle),

    calendarAccess: async () => desktop.access,
    requestCalendarAccess: async () => {
      desktop.prompted = true
      // macOS answers for the user once it has an answer on file, which is why
      // the app never nags: asking again after a refusal does not re-prompt.
      if (desktop.access === 'undetermined') {
        desktop.access = answersPrompt
      }
      return desktop.access
    },
    calendars: async () => (desktop.access === 'granted' ? calendars : []),
    todaysCalendarEvents: async () =>
      desktop.access === 'granted' ? desktop.events : [],

    repositoryCommits: async (path, identities, since): Promise<CommitsRead> => {
      const found = desktop.repositories[path] ?? 'missing'
      if (typeof found === 'string') return { state: 'unreadable', reason: found }

      // Matched on the whole address regardless of case, as the reader does.
      const named = new Set(identities.map((identity) => identity.toLowerCase()))
      return {
        state: 'read',
        commits: found.commits
          .filter(
            ({ author, authoredAt }) =>
              named.has(author.toLowerCase()) && authoredAt >= since,
          )
          .map(({ hash, subject, authoredAt }) => ({
            hash,
            subject,
            authoredAt,
            repository: found.repository,
          })),
      }
    },
    repositoryIdentities: async (path): Promise<IdentitiesRead> => {
      const found = desktop.repositories[path] ?? 'missing'
      if (typeof found === 'string') return { state: 'unreadable', reason: found }

      const since = Date.now() - SUGGESTION_LOOKBACK
      const addresses = [
        ...(found.configuredEmail ? [found.configuredEmail] : []),
        // Most recent by author date, as the reader sorts them: a rebase
        // leaves walk order and author order apart.
        ...found.commits
          .filter(({ authoredAt }) => authoredAt >= since)
          .toSorted((a, b) => b.authoredAt - a.authoredAt)
          .map(({ author }) => author),
      ]
      // One address in any case, the first spelling met kept.
      const identities = new Map<string, string>()
      for (const address of addresses) {
        const key = address.toLowerCase()
        if (!identities.has(key)) identities.set(key, address)
      }
      return {
        state: 'read',
        repository: found.repository,
        identities: [...identities.values()],
      }
    },

    chooseRepositoryFolder: async () => desktop.chosenFolder,
    announceObservingChanged: async () => observingChanged.announce(undefined),
    onObservingChanged: async (handle) => observingChanged.add(handle),

    onSystemWoke: async (handle) => systemWoke.add(handle),
    announceImportChanged: async () => importChanged.announce(undefined),
    onImportChanged: async (handle) => importChanged.add(handle),

    announceCapturedNote: async (journalDay) => noteCaptured.announce(journalDay),
    onNoteCaptured: async (handle) => noteCaptured.add(handle),
    announceJournalChanged: async () => journalChanged.announce(undefined),
    onJournalChanged: async (handle) => journalChanged.add(handle),
    announceTheme: async (theme) => themeChanged.announce(theme),
    onThemeChanged: async (handle) => themeChanged.add(handle),

    hotkeyStatus: async () => hotkey,
    setHotkey: async (action, next) => ({
      ...hotkey,
      [action]: { state: 'registered', hotkey: next },
    }),

    startsAtLogin: async () => desktop.loginItem,
    setStartAtLogin: async (startAtLogin) => {
      desktop.loginItem = startAtLogin
    },

    copyToClipboard: async (text) => {
      desktop.clipboard = text
    },

    apiKeySet: async () => {
      refuseALockedKeychain(desktop)
      return desktop.apiKey !== null
    },
    saveApiKey: async (apiKey) => {
      refuseALockedKeychain(desktop)
      desktop.apiKey = apiKey
    },
    clearApiKey: async () => {
      refuseALockedKeychain(desktop)
      desktop.apiKey = null
    },

    exportJournal: async (markdown, fileName): Promise<ExportedFile> => {
      desktop.exported.push({ markdown, fileName })
      return { path: `/tmp/${fileName}`, fileName }
    },

    automaticBackups: async (): Promise<AutomaticBackups> =>
      desktop.automaticBackupStatus,

    chooseBackupLocation: async (): Promise<string | null> =>
      desktop.chosenBackupLocation,

    backupJournal: async (path): Promise<BackupResult> => {
      if (desktop.backupFails) {
        throw new Error('The snapshot could not be written.')
      }
      // Mirrors backup_journal's settlement: a path the dialog offered to
      // replace is already occupied, so the write lands beside it — `-2`,
      // `-3` — rather than on what is there. The result carries where the
      // snapshot actually went, which is what the toast names.
      const settled = desktop.backups.includes(path) ? nextSibling(path, desktop.backups) : path
      desktop.backups.push(settled)
      const fileName = settled.split('/').pop() ?? settled
      return { path: settled, fileName }
    },

    revealBackups: async () => {
      if (desktop.revealFails) {
        throw new Error('The backups folder could not be opened.')
      }
      desktop.backupsRevealed += 1
    },

    chooseRestoreCandidate: async (): Promise<string | null> =>
      desktop.chosenRestoreCandidate,

    stageRestore: async (path): Promise<void> => {
      if (desktop.restoreError !== null) {
        throw new Error(desktop.restoreError)
      }
      desktop.stagedRestores.push(path)
    },

    generateWorkSummary: async (request): Promise<WorkSummaryResponse> => {
      desktop.workSummaryRequests.push(request)
      return desktop.workSummaryResponse
    },

    checkForUpdate: async (): Promise<AvailableUpdate | null> => {
      desktop.updateChecks += 1
      if (desktop.updateCheckFails) {
        throw new Error('Nothing answered.')
      }
      return desktop.availableUpdate
    },

    installUpdate: async (report) => {
      if (desktop.availableUpdate === null) {
        throw new Error('Nothing has been found to install.')
      }
      // The length first and the bytes after, which is the order the real one
      // reports them in — so a view that shows a share of the download is
      // driven here exactly as it is in the app.
      report({ downloaded: 0, total: desktop.updateSize })
      if (desktop.updateInstallFails) {
        throw new Error('The bundle could not be written.')
      }
      report({ downloaded: desktop.updateSize, total: desktop.updateSize })
      desktop.updatesInstalled += 1
    },

    // The real one ends the process here. A test that wants to know what the
    // user could still read counts on being able to look at this moment.
    restart: async () => {
      desktop.restarts += 1
    },

    showTrayCount: async (title) => {
      desktop.trayTitle = title
    },
  }

  return desktop
}

/** How big a fake release is: enough bytes that a share of it is a round number. */
const UPDATE_SIZE = 20_000_000

/** What the fake model says, distinguishable from anything the user wrote. */
const GENERATED_SUMMARY = 'The work summary the model wrote.'

/**
 * A settings store that does not open until the test says so — the fixture
 * the settings-race tests are built on. Act on a control while the window's
 * initial read is still landing, then open the store and let it arrive.
 */
export function deferredStore(stored: Record<string, unknown>): {
  /** Lets the settings read land, once the test has acted. */
  openTheStore: () => void
  /** Handed to fakeDesktop: the settings file, opened on release. */
  openSettingsStore: () => Promise<SettingsStore>
} {
  let openTheStore = () => {}
  const opened = new Promise<void>((resolve) => {
    openTheStore = resolve
  })

  return {
    openTheStore,
    openSettingsStore: async () => {
      await opened
      return {
        async get<T>(key: string) {
          return stored[key] as T | undefined
        },
        async has(key: string) {
          return key in stored
        },
        async set(key: string, value: unknown) {
          stored[key] = value
        },
      }
    },
  }
}

/** What the Keychain says when it will not answer, in the words Rust returns. */
function refuseALockedKeychain(desktop: FakeDesktop): void {
  if (desktop.keychainRefuses) {
    throw new Error('the keychain could not be reached')
  }
}

function subscribers<T>() {
  const handlers = new Set<(value: T) => void>()
  return {
    add(handle: (value: T) => void): Unlisten {
      handlers.add(handle)
      return () => handlers.delete(handle)
    },
    announce(value: T): void {
      for (const handle of handlers) handle(value)
    },
  }
}

/// The next free sibling of a taken name — `name.ext` → `name-2.ext` — the
/// same settlement `export.rs`'s `free_path` performs on the Rust side.
function nextSibling(path: string, existing: string[]): string {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  const stem = dot > slash ? path.slice(0, dot) : path
  const extension = dot > slash ? path.slice(dot) : ''
  let attempt = 2
  while (existing.includes(`${stem}-${attempt}${extension}`)) {
    attempt += 1
  }
  return `${stem}-${attempt}${extension}`
}

/**
 * How far back suggestions look. Must match `SUGGESTION_LOOKBACK` in
 * `src-tauri/src/commits.rs`, as `src/platform/desktop-rust.test.ts` checks.
 */
export const SUGGESTION_LOOKBACK = 90 * 24 * 60 * 60 * 1000
