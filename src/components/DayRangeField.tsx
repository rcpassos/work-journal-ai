import { useState } from 'react'
import { CalendarRangeIcon } from 'lucide-react'
import { useOffScreen } from '@/components/on-screen-context'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  formatDayRange,
  dayAsDate,
  journalDayFor,
  type DayRange,
  type FilterPreset,
} from '@/journal/journal'

const PRESET_OPTIONS: ReadonlyArray<{ value: FilterPreset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this-week', label: 'This week' },
  { value: 'last-week', label: 'Last week' },
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
]

/**
 * A day axis, whole: a button that reads the range in words, and one popup
 * holding both ways to change it — a named range, or two ends on a calendar.
 * One concept, one control — see
 * docs/adr/0013-the-filter-day-axis-is-one-control.md.
 *
 * Typed on a bare day range rather than a Filter, so every section holding
 * dates shares it: History passes its Filter unchanged (`Filter` extends
 * `DayRange`), and sections with no Project axis pass their range. A Preset
 * never touches anything but the days.
 *
 * A day is picked in one click and is a whole day when it lands, which is why
 * nothing here holds a half-typed value: the partial-value dance the old date
 * inputs needed is gone with them rather than ported across.
 */
export default function DayRangeField({
  range,
  onPick,
  onChoosePreset,
}: {
  range: DayRange
  onPick: (from: string, to: string) => void
  onChoosePreset: (preset: FilterPreset) => void
}) {
  const [open, setOpen] = useState(false)
  // The first end of a range being picked, while the second is still to come.
  // Null whenever the calendar is showing the range rather than a new one.
  const [started, setStarted] = useState<Date | null>(null)

  function show(next: boolean) {
    setOpen(next)
    if (!next) setStarted(null)
  }

  // The popup is portalled out of the section, so it has to be closed rather
  // than hidden when this view leaves the screen. The range it would have
  // moved is untouched; only a half-picked range goes with it.
  useOffScreen(() => show(false))

  function pickDay(day: Date) {
    if (started === null) {
      setStarted(day)
      return
    }

    // Whichever end was clicked first: the core orders the range.
    onPick(journalDayFor(started), journalDayFor(day))
    show(false)
  }

  return (
    <Popover open={open} onOpenChange={show}>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <CalendarRangeIcon data-icon="inline-start" />
        {/*
          Named and read at once: a label that replaced the button's text
          would announce "Days" and keep the range — the whole point of the
          control — to itself.
        */}
        <span className="sr-only">Days</span>{' '}
        {formatDayRange(range.from, range.to)}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto gap-2 p-2">
        <div className="grid grid-cols-3 gap-1">
          {PRESET_OPTIONS.map((option) => (
            <Button
              key={option.value}
              variant="ghost"
              size="sm"
              className="justify-start"
              onClick={() => {
                onChoosePreset(option.value)
                show(false)
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <Calendar
          mode="range"
          autoFocus
          // Monday, as every Preset's week is — see ADR-0006.
          weekStartsOn={1}
          defaultMonth={dayAsDate(range.to)}
          selected={
            started === null
              ? { from: dayAsDate(range.from), to: dayAsDate(range.to) }
              : { from: started, to: undefined }
          }
          onSelect={(_range, day) => pickDay(day)}
          className="p-0"
        />
      </PopoverContent>
    </Popover>
  )
}
