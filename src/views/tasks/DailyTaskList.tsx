import { DragDropProvider } from '@dnd-kit/react'
import { useSortable } from '@dnd-kit/react/sortable'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowDownToLineIcon, ArrowUpToLineIcon, GripVerticalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Task } from '@/journal/journal'

export interface DailyTaskControls {
  rowRef: (element: HTMLLIElement | null) => void
  dropTarget: boolean
  dragSource: boolean
  handle: ReactNode
  actions: ReactNode
}

/** Drag feedback is temporary; the rendered priority changes only after saving. */
export default function DailyTaskList({ tasks, onReorder, onDraggingChange, children }: {
  tasks: Task[]
  onReorder: (order: readonly string[], expected: readonly string[]) => Promise<boolean>
  onDraggingChange: (active: boolean) => void
  children: (task: Task, controls: DailyTaskControls) => ReactNode
}) {
  const saving = useRef(false)
  const [busy, setBusy] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const dragOrder = useRef<string[]>([])
  const list = useRef<HTMLOListElement>(null)
  const instructions = useId()
  useEffect(() => () => onDraggingChange(false), [onDraggingChange])

  async function move(expected: string[], from: number, to: number) {
    if (saving.current || from === to || from < 0 || from >= expected.length || to < 0 || to >= expected.length) return
    const order = [...expected]
    const [id] = order.splice(from, 1)
    order.splice(to, 0, id)
    saving.current = true
    setBusy(true)
    setAnnouncement('Saving Daily Tasks order.')
    try {
      if (await onReorder(order, expected)) {
        setAnnouncement(`Priority saved. Position ${to + 1} of ${order.length}.`)
        const focused = document.activeElement
        if (focused && list.current?.contains(focused)) {
          focused.scrollIntoView?.({ block: 'nearest' })
        }
      } else {
        setAnnouncement('Order was not saved. The current saved list is shown.')
      }
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  return (
    <DragDropProvider
      onBeforeDragStart={() => {
        dragOrder.current = tasks.map(task => task.id)
        onDraggingChange(true)
      }}
      // Keep React's saved order authoritative. The library still provides
      // drag feedback and a drop target, but must not rearrange DOM nodes
      // outside React: a failed/stale save needs to show the persisted order.
      onDragOver={event => event.preventDefault()}
      onDragEnd={event => {
        onDraggingChange(false)
        // Escape belongs to the drag sensor, not the window's close handler.
        if (event.canceled) return
        const { source, target } = event.operation
        if (source && target) {
          const expected = dragOrder.current
          void move(expected, expected.indexOf(String(source.id)), expected.indexOf(String(target.id)))
        }
      }}
    >
      <p id={instructions} className="sr-only">
        Drag to change priority, or use Alt+Arrow Up and Alt+Arrow Down. First is highest priority.
      </p>
      <p role="status" className="sr-only">{announcement}</p>
      <ol ref={list} className="flex flex-col gap-1" aria-label="Daily Tasks priorities" aria-busy={busy}>
        {tasks.map((task, index) => (
          <SortableDailyTask key={task.id} task={task} index={index} count={tasks.length}
            busy={busy} instructions={instructions}
            onMove={to => void move(tasks.map(task => task.id), index, to)}
          >
            {controls => children(task, controls)}
          </SortableDailyTask>
        ))}
      </ol>
    </DragDropProvider>
  )
}

function SortableDailyTask({ task, index, count, busy, instructions, onMove, children }: {
  task: Task
  index: number
  count: number
  busy: boolean
  instructions: string
  onMove: (index: number) => void
  children: (controls: DailyTaskControls) => ReactNode
}) {
  const { ref, handleRef, isDropTarget, isDragSource } = useSortable({ id: task.id, index, disabled: busy })
  return children({
    rowRef: ref,
    dropTarget: isDropTarget && !isDragSource,
    dragSource: isDragSource,
    handle: (
      <Button ref={handleRef} variant="ghost" size="icon-sm"
        aria-label={`Reorder “${task.description}”`}
        aria-describedby={instructions} aria-disabled={busy}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        title="Drag to reorder, or use Alt+↑ / Alt+↓"
        className="touch-none cursor-grab active:cursor-grabbing"
        onKeyDown={event => {
          if (event.defaultPrevented) return
          if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          if (!busy) onMove(index + (event.key === 'ArrowUp' ? -1 : 1))
        }}
      >
        <GripVerticalIcon />
      </Button>
    ),
    actions: (
      <>
        <Button variant="ghost" size="icon-sm"
          aria-label={`Move “${task.description}” to top`} title="Move to top"
          aria-disabled={busy || index === 0}
          onClick={() => { if (!busy && index !== 0) onMove(0) }}
        ><ArrowUpToLineIcon /></Button>
        <Button variant="ghost" size="icon-sm"
          aria-label={`Move “${task.description}” to bottom`} title="Move to bottom"
          aria-disabled={busy || index === count - 1}
          onClick={() => { if (!busy && index !== count - 1) onMove(count - 1) }}
        ><ArrowDownToLineIcon /></Button>
      </>
    ),
  })
}
