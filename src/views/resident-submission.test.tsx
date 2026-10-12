// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createJournal, type Journal } from '@/journal/journal'
import { fixedClock, openTestDatabase } from '@/journal/testing/database'
import { fakeDesktop } from '@/platform/testing/desktop'
import CaptureView from './capture/CaptureView'
import TaskCreationView from './tasks/TaskCreationView'

const closeDatabases: (() => void)[] = []
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  for (const close of closeDatabases.splice(0)) close()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((release, refuse) => {
    resolve = release
    reject = refuse
  })
  return { promise, resolve, reject }
}

for (const mode of ['note', 'task'] as const) {
  describe(`overlapping ${mode} submissions`, () => {
    async function setup(opening?: Promise<Journal>, persistence?: Promise<void>) {
      const db = await openTestDatabase()
      closeDatabases.push(db.close)
      const storing = deferred<void>()
      let waiting = persistence
      const journal = createJournal({
        clock: fixedClock('2026-10-11T12:00:00Z'),
        driver: {
          ...db.driver,
          async execute(sql, params) {
            storing.resolve()
            await waiting
            await db.driver.execute(sql, params)
          },
        },
      })
      const desktop = fakeDesktop()
      const pending = opening ?? Promise.resolve(journal)
      render(mode === 'note'
        ? <CaptureView desktop={desktop} journal={pending} />
        : <TaskCreationView desktop={desktop} journal={pending} />)
      const field = screen.getByLabelText(mode === 'note'
        ? 'What did you just do?'
        : 'What do you need to do?') as HTMLInputElement
      return {
        journal,
        desktop,
        field,
        storing: storing.promise,
        resumeWrites: () => { waiting = undefined },
        type: (text: string) => fireEvent.change(field, { target: { value: text } }),
        enter: () => fireEvent.keyDown(field, { key: 'Enter' }),
        show: () => mode === 'note'
          ? desktop.beginCapture()
          : desktop.showTaskCreation(),
        dismissed: () => mode === 'note'
          ? desktop.capturesDismissed
          : desktop.taskCreationsDismissed,
        records: () => mode === 'note'
          ? journal.notesForFilter({ from: '2026-10-11', to: '2026-10-11' })
          : journal.openTasks(),
      }
    }

    it.each(mode === 'task' ? ['Enter', 'Create Task'] : ['Enter'])(
      'stores once when Enter is followed by %s while the journal opens', async (again) => {
        const opening = deferred<Journal>()
        const view = await setup(opening.promise)
        view.type('ship the fix')
        view.enter()
        if (again === 'Enter') view.enter()
        else fireEvent.click(screen.getByRole('button', { name: again }))

        await act(async () => { opening.resolve(view.journal) })

        expect(await view.records()).toHaveLength(1)
        expect(view.dismissed()).toBe(1)
      },
    )

    it.each(mode === 'task' ? ['Enter', 'Create Task'] : ['Enter'])(
      'stores once when Enter is followed by %s during persistence', async (again) => {
        const persistence = deferred<void>()
        const view = await setup(undefined, persistence.promise)
        view.type('ship the fix')
        view.enter()
        await act(async () => { await view.storing })
        if (again === 'Enter') view.enter()
        else fireEvent.click(screen.getByRole('button', { name: again }))
        await act(async () => { persistence.resolve() })

        expect(await view.records()).toHaveLength(1)
        expect(view.dismissed()).toBe(1)
      },
    )

    it('keeps the submission guarded until announcements finish', async () => {
      const announcement = deferred<void>()
      const announcing = deferred<void>()
      const view = await setup()
      const announce = mode === 'note'
        ? view.desktop.announceJournalChanged
        : view.desktop.announceTasksChanged
      const delayed = async () => {
        announcing.resolve()
        await announcement.promise
        await announce()
      }
      if (mode === 'note') view.desktop.announceJournalChanged = delayed
      else view.desktop.announceTasksChanged = delayed
      view.type('ship the fix')
      view.enter()
      await act(async () => { await announcing.promise })
      view.enter()
      await act(async () => { announcement.resolve() })

      expect(await view.records()).toHaveLength(1)
      expect(view.dismissed()).toBe(1)
    })

    it('keeps the submission guarded until dismissal finishes', async () => {
      const dismissal = deferred<void>()
      const dismissing = deferred<void>()
      const view = await setup()
      const dismiss = mode === 'note'
        ? view.desktop.dismissCapture
        : view.desktop.dismissTaskCreation
      const delayed = async () => {
        await dismiss()
        dismissing.resolve()
        await dismissal.promise
      }
      if (mode === 'note') view.desktop.dismissCapture = delayed
      else view.desktop.dismissTaskCreation = delayed
      view.type('ship the fix')
      view.enter()
      await act(async () => { await dismissing.promise })
      view.type('ship the fix')
      view.enter()
      await act(async () => { dismissal.resolve() })

      expect(await view.records()).toHaveLength(1)
      expect(view.dismissed()).toBe(1)
    })

    it('retains a refused draft and lets a retry store it once', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const persistence = deferred<void>()
      const view = await setup(undefined, persistence.promise)
      view.type('ship the fix')
      view.enter()
      await act(async () => { await view.storing })
      await act(async () => { persistence.reject(new Error('the disk is gone')) })

      expect(screen.getByRole('alert').textContent).toContain('could not be stored')
      expect(view.field.value).toBe('ship the fix')
      expect(await view.records()).toHaveLength(0)
      expect(view.dismissed()).toBe(0)

      view.resumeWrites()
      view.enter()
      view.enter()
      await act(async () => {})

      expect(await view.records()).toHaveLength(1)
      expect(view.dismissed()).toBe(1)
    })

    it('leaves a newer showing intact when an abandoned save completes', async () => {
      const persistence = deferred<void>()
      const view = await setup(undefined, persistence.promise)
      view.type('ship the fix')
      view.enter()
      await act(async () => { await view.storing })

      fireEvent.keyDown(view.field, { key: 'Escape' })
      await act(async () => { view.show() })
      view.type('a newer draft')
      await act(async () => { persistence.resolve() })

      expect(await view.records()).toHaveLength(1)
      expect(view.field.value).toBe('a newer draft')
      expect(view.dismissed()).toBe(1)

      view.enter()
      await act(async () => {})
      expect(await view.records()).toHaveLength(2)
      expect(view.dismissed()).toBe(2)
    })

    it('keeps a newer showing when the old window was put away without abandonment', async () => {
      const persistence = deferred<void>()
      const view = await setup(undefined, persistence.promise)
      view.type('ship the fix')
      view.enter()
      await act(async () => { await view.storing })
      view.desktop.windowVisible = false
      await act(async () => { view.desktop.blur() })
      view.desktop.windowVisible = true
      await act(async () => { view.show() })
      view.type('a newer draft')
      await act(async () => { persistence.resolve() })

      expect(await view.records()).toHaveLength(1)
      expect(view.field.value).toBe('a newer draft')
      expect(view.dismissed()).toBe(0)
    })

    it('does not show an old refusal against a newer draft', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const persistence = deferred<void>()
      const view = await setup(undefined, persistence.promise)
      view.type('ship the fix')
      view.enter()
      await act(async () => { await view.storing })
      fireEvent.keyDown(view.field, { key: 'Escape' })
      await act(async () => { view.show() })
      view.type('a newer draft')
      await act(async () => { persistence.reject(new Error('the disk is gone')) })

      expect(view.field.value).toBe('a newer draft')
      expect(screen.queryByRole('alert')).toBeNull()
      expect(view.dismissed()).toBe(1)
    })

    if (mode === 'task') {
      it('still asks about alerts when an older timed Task is saved', async () => {
        const persistence = deferred<void>()
        const view = await setup(undefined, persistence.promise)
        view.type('ship the fix')
        fireEvent.click(screen.getByRole('button', { name: 'Add a date' }))
        fireEvent.change(screen.getByLabelText('Scheduled For'), {
          target: { value: '2026-10-12' },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Add a time' }))
        fireEvent.change(screen.getByLabelText('Time'), {
          target: { value: '09:00' },
        })
        view.enter()
        await act(async () => { await view.storing })
        fireEvent.keyDown(view.field, { key: 'Escape' })
        await act(async () => { view.show() })
        view.type('a newer draft')
        await act(async () => { persistence.resolve() })

        expect(await view.records()).toHaveLength(1)
        expect(view.desktop.alertPrompted).toBe(true)
        expect(view.field.value).toBe('a newer draft')
        expect(view.dismissed()).toBe(1)
      })
    }
  })
}
