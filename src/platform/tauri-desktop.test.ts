import { beforeEach, describe, expect, it, vi } from 'vitest'

const { check, downloadAndInstall } = vi.hoisted(() => ({
  check: vi.fn(),
  downloadAndInstall: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({ check }))

import { createTauriDesktop } from './tauri-desktop'

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
