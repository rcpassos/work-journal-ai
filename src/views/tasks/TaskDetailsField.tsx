import { useId } from 'react'
import { Textarea } from '@/components/ui/textarea'

/** Text is owned by each form; this field supplies only the shared control. */
export default function TaskDetailsField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <label htmlFor={id} className="flex min-h-0 flex-col gap-1">
      <span className="type-meta text-muted-foreground">Task Details (optional)</span>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{ fieldSizing: 'fixed', height: 96, minHeight: 48 }}
        autoComplete="off"
      />
    </label>
  )
}
