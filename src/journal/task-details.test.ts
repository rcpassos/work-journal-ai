import { expect, it } from 'vitest'
import { createJournal } from './journal'
import { buildWorkSummaryMaterial, selectWorkSummary } from './work-summary'
import { buildReviewMaterial, selectReviewCompletions } from './review'
import { taskAlerts } from './journal'
import { fixedClock, occurrencesOf, openTestDatabase } from './testing/database'

it('persists optional details with LF line endings and preserves nonblank whitespace', async () => {
  const { driver, close } = await openTestDatabase()
  try {
    const clock = fixedClock('2026-03-12T09:00:00')
    const journal = createJournal({ driver, clock })
    const task = await journal.createTask(' proposal ', null, null, '  Olá 🌍\r\n\r  instructions\n ')
    const reopened = createJournal({ driver, clock })
    expect(await reopened.openTasks()).toEqual([{
      ...task, description: 'proposal', details: '  Olá 🌍\n\n  instructions\n ',
    }])
    await expect(journal.createTask(' ', null, null, 'context')).rejects.toThrow()
    const blank = await journal.createTask('blank', null, null, ' \r\n\t')
    expect(blank.details).toBeNull()
  } finally { close() }
})

it('searches literal details once and preserves details across recurring lifecycle and undo', async () => {
  const { driver, close } = await openTestDatabase()
  try {
    const journal = createJournal({ driver, clock: fixedClock('2026-03-12T09:00:00') })
    const task = await journal.createTask('renew', { date: '2026-03-12', time: null }, { unit: 'day', interval: 1, weekdays: [] }, 'Only HERE %_')
    expect((await journal.tasksMatching('here %_')).map(t => t.id)).toEqual([task.id])
    const next = await journal.completeTask(task.id)
    const history = await occurrencesOf(journal, task.id)
    const edited = await journal.editTask(task.id, { description: 'renew HERE %_', details: 'new HERE %_', schedule: { date: next.scheduledDate!, time: null } })
    expect(edited).toEqual({ ...next, description: 'renew HERE %_', details: 'new HERE %_' })
    expect(await occurrencesOf(journal, task.id)).toEqual(history)
    expect(await journal.tasksMatching('HERE %_')).toHaveLength(1)
    const undone = await journal.undoCompletion(task.id)
    expect(undone.details).toBe('new HERE %_')
    expect((await journal.stopRecurrence(task.id)).details).toBe('new HERE %_')
    const completed = await journal.completeTask(task.id)
    const cleared = await journal.editTask(task.id, { description: completed.description, details: ' \n', schedule: { date: completed.scheduledDate!, time: null } })
    expect(cleared).toEqual({ ...completed, details: null })
    expect((await journal.reopenTask(task.id)).details).toBeNull()
  } finally { close() }
})

it('renders Markdown-looking details as literal nested supporting text in export and material', async () => {
  const { driver, close } = await openTestDatabase()
  try {
    const journal = createJournal({ driver, clock: fixedClock('2026-03-12T09:00:00') })
    await journal.createTask('proposal', null, null, '# heading\n- [x] fake task\n```\n  Olá\n')
    const block = '  ````\n  # heading\n  - [x] fake task\n  ```\n    Olá\n  \n  ````'
    const exported = await journal.exportJournal()
    expect(exported.taskCount).toBe(1)
    expect(exported.markdown).toBe('# Tasks\n\n## Open\n- [ ] proposal\n' + block)
    const selection = await selectWorkSummary({ journal, range: { from: '2026-03-09', to: '2026-03-12' } })
    expect(buildWorkSummaryMaterial(selection)).toContain('- [ ] proposal\n' + block)
  } finally { close() }
})

it('includes current details on completed occurrences in both materials and keeps Alerts short', async () => {
  const { driver, close } = await openTestDatabase()
  try {
    const clock = fixedClock('2026-03-12T09:00:00')
    const journal = createJournal({ driver, clock })
    const task = await journal.createTask('renew', { date: '2026-03-12', time: '10:00' }, { unit: 'day', interval: 1, weekdays: [] }, 'initial context')
    expect(taskAlerts([task], clock.now())[0].description).toBe('renew')
    const next = await journal.completeTask(task.id)
    await journal.editTask(task.id, { description: task.description, details: '  updated\n\ncontext', schedule: { date: next.scheduledDate!, time: next.scheduledTime } })
    const range = { from: '2026-03-12', to: '2026-03-12' }
    const selected = await selectWorkSummary({ journal, range })
    expect(selected.completedOccurrences[0].task.details).toBe('  updated\n\ncontext')
    const work = buildWorkSummaryMaterial(selected)
    const completed = await selectReviewCompletions({ journal, filter: range })
    const review = buildReviewMaterial({ ...completed, filter: range, digest: await journal.digest(range) })
    expect(review.completionCount).toBe(1)
    const block = '  ```\n    updated\n  \n  context\n  ```'
    expect(work).toContain('(occurrence 2026-03-12 10:00)\n' + block)
    expect(review.markdown).toContain('(occurrence 2026-03-12 10:00)\n' + block)
    expect((await journal.exportJournal()).taskCount).toBe(1)
  } finally { close() }
})
