import { beforeEach, describe, expect, it, vi } from 'vitest'

const { check, downloadAndInstall, invoke, loadDatabase } = vi.hoisted(() => ({
  check: vi.fn(),
  downloadAndInstall: vi.fn(),
  invoke: vi.fn(),
  loadDatabase: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({ check }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: loadDatabase } }))

import { createTauriDesktop } from './tauri-desktop'
import { TRANSACTION_GUARD_MISS, TransactionGuardMiss } from '@/journal/journal'
import { NO_OBSERVING } from '@/settings/observing'

describe('the Observing compare-and-set command', () => {
  it('sends the raw expected value and returns a conflict unchanged', async () => {
    const expected = { enabled: true, repositories: 'old format' }
    const conflict = { written: false, current: { ...NO_OBSERVING, enabled: true } }
    invoke.mockResolvedValueOnce(conflict)
    const result = await createTauriDesktop().compareAndSetObserving(expected, NO_OBSERVING)
    expect(invoke).toHaveBeenLastCalledWith('compare_and_set_observing', { expected, next: NO_OBSERVING })
    expect(result).toEqual(conflict)
  })
})

describe('the journal transaction driver', () => {
  beforeEach(() => {
    invoke.mockReset()
    loadDatabase.mockResolvedValue({})
  })

  it('translates the Rust guard miss into the journal contract', async () => {
    invoke.mockRejectedValue(TRANSACTION_GUARD_MISS)
    const driver = await createTauriDesktop().openJournalDatabase()

    await expect(driver.transaction([
      { sql: 'UPDATE tasks SET completed_at = ? WHERE id = ?', params: ['now', 'missing'], expectedRows: 1 },
    ])).rejects.toBeInstanceOf(TransactionGuardMiss)
  })

  it('preserves unrelated storage failures', async () => {
    invoke.mockRejectedValue('database is locked')
    const driver = await createTauriDesktop().openJournalDatabase()

    await expect(driver.transaction([])).rejects.toBe('database is locked')
  })
})

describe('the updater', () => {
  beforeEach(() => {
    check.mockReset()
    downloadAndInstall.mockReset()
    check.mockResolvedValue({
      version: '0.9.0',
      body: '',
      downloadAndInstall,
    })
    downloadAndInstall.mockResolvedValue(undefined)
  })

  it('gives up on a check that never answers', async () => {
    await createTauriDesktop().checkForUpdate()

    expect(check).toHaveBeenCalledWith({ timeout: expect.any(Number) })
    expect(check.mock.calls[0][0].timeout).toBeGreaterThan(0)
  })

  it('gives up on an install that never finishes, allowing longer than a check', async () => {
    const desktop = createTauriDesktop()
    await desktop.checkForUpdate()
    await desktop.installUpdate(() => {})

    const options = downloadAndInstall.mock.calls[0][1]
    expect(options.timeout).toBeGreaterThan(check.mock.calls[0][0].timeout)
  })
})


describe('observed branch commands', () => {
  it('passes selected refs, empty all-branches, and legacy unset through IPC', async () => {
    invoke.mockReset()
    invoke.mockResolvedValue({ state: 'read', commits: [] })
    const desktop = createTauriDesktop()
    for (const branches of [['refs/heads/develop'], [], undefined]) {
      await desktop.repositoryCommits('/code/chronos', ['me@example.com'], 123, branches)
      expect(invoke).toHaveBeenLastCalledWith('repository_commits', { path: '/code/chronos', identities: ['me@example.com'], since: 123, branches })
    }
    invoke.mockResolvedValue({ state: 'read', branches: ['refs/heads/develop'], defaultBranch: 'refs/heads/main' })
    expect(await desktop.repositoryBranches('/code/chronos')).toEqual({ state: 'read', branches: ['refs/heads/develop'], defaultBranch: 'refs/heads/main' })
    expect(invoke).toHaveBeenLastCalledWith('repository_branches', { path: '/code/chronos' })
  })
})


it('passes the applicable branch histories through identity-discovery IPC', async () => {
  invoke.mockReset()
  invoke.mockResolvedValue({ state: 'read', repository: '/code/chronos/.git', identities: ['previous@example.test'], reason: null })
  const desktop = createTauriDesktop()
  for (const branches of [['refs/heads/develop'], [], undefined]) {
    const result = await desktop.repositoryIdentities('/code/chronos', branches)
    expect(invoke).toHaveBeenLastCalledWith('repository_identities', { path: '/code/chronos', branches })
    expect(result).toMatchObject({ identities: ['previous@example.test'] })
  }
})
