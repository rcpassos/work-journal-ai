import { describe, expect, it } from 'vitest'
import {
  describeUnavailableHotkey,
  describeHotkeyAction,
  hotkeyForKeystroke,
  HOTKEY_ACTIONS,
} from './hotkey'

describe('hotkeyForKeystroke', () => {
  const keystroke = {
    code: 'KeyJ',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
  }

  it('reads a modified letter as the combination it is', () => {
    expect(
      hotkeyForKeystroke({
        ...keystroke,
        ctrlKey: true,
        altKey: true,
        metaKey: true,
      }),
    ).toBe('Ctrl+Alt+Cmd+J')
  })

  it('spells the modifiers in one order, whichever were held', () => {
    expect(hotkeyForKeystroke({ ...keystroke, metaKey: true, shiftKey: true })).toBe(
      'Shift+Cmd+J',
    )
  })

  it('refuses a key held with no modifier, which would swallow typing everywhere', () => {
    expect(hotkeyForKeystroke(keystroke)).toBeNull()
    expect(hotkeyForKeystroke({ ...keystroke, shiftKey: true })).toBeNull()
  })

  it('is nothing at all while only modifiers are down', () => {
    expect(
      hotkeyForKeystroke({ ...keystroke, code: 'MetaLeft', metaKey: true }),
    ).toBeNull()
    expect(
      hotkeyForKeystroke({ ...keystroke, code: 'ShiftLeft', shiftKey: true }),
    ).toBeNull()
  })

  it('takes digits, function keys and Space', () => {
    expect(hotkeyForKeystroke({ ...keystroke, code: 'Digit7', ctrlKey: true })).toBe(
      'Ctrl+7',
    )
    expect(hotkeyForKeystroke({ ...keystroke, code: 'F5', ctrlKey: true })).toBe(
      'Ctrl+F5',
    )
    expect(hotkeyForKeystroke({ ...keystroke, code: 'Space', ctrlKey: true })).toBe(
      'Ctrl+Space',
    )
  })

  it('leaves Escape alone, because Escape dismisses the recorder', () => {
    expect(
      hotkeyForKeystroke({ ...keystroke, code: 'Escape', ctrlKey: true }),
    ).toBeNull()
  })

  it('reads the physical key, so a different layout still spells one accelerator', () => {
    expect(
      hotkeyForKeystroke({ ...keystroke, code: 'BracketLeft', ctrlKey: true }),
    ).toBeNull()
  })
})

describe('describeUnavailableHotkey', () => {
  it('says what failed, why, and where to go instead', () => {
    const message = describeUnavailableHotkey(
      'note',
      'Ctrl+Shift+Cmd+J',
      'the combination belongs to another application',
    )

    expect(message).toContain('Ctrl+Shift+Cmd+J')
    expect(message).toContain('the combination belongs to another application')
    expect(message).toMatch(/menu bar|tray|work journal menu/i)
  })

  it('names the action, so the fallback it points at is the right one', () => {
    expect(describeUnavailableHotkey('note', 'Ctrl+K', 'refused')).toContain(
      'New Note',
    )
    expect(describeUnavailableHotkey('task', 'Ctrl+K', 'refused')).toContain(
      'New Task',
    )
    expect(describeUnavailableHotkey('task', 'Ctrl+K', 'refused')).toContain(
      'Task Hotkey',
    )
  })
})

describe('HOTKEY_ACTIONS', () => {
  it('names each action and its Tray Menu fallback', () => {
    expect(HOTKEY_ACTIONS.map((each) => each.action)).toEqual([
      'note', 'task', 'viewTasks',
    ])
    expect(describeHotkeyAction('note').label).toBe('Note Hotkey')
    expect(describeHotkeyAction('task').trayItem).toBe('New Task')
    expect(describeHotkeyAction('viewTasks').label).toBe('View Tasks Hotkey')
    expect(describeHotkeyAction('viewTasks').trayItem).toBe('View Tasks')
  })
})
