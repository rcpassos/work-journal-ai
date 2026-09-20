import { InfoIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * A named part of the settings pane: a caption over one card, with the groups
 * inside it divided by hairlines. The caption is what says which settings
 * belong together; without it a long pane is one undifferentiated scroll.
 */
export function SettingsSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={`${headingId(title)}-section`}>
      <h2
        id={`${headingId(title)}-section`}
        className="px-1 pb-2 type-micro font-semibold uppercase text-muted-foreground"
      >
        {title}
      </h2>
      <Card className="divide-y divide-border px-4">{children}</Card>
    </section>
  )
}

/** Settings about one subject, between two hairlines. */
export function SettingsGroup({ children }: { children: React.ReactNode }) {
  return <section className="flex flex-col gap-2 py-3">{children}</section>
}

/**
 * One setting: what it is on the left, the control that changes it on the
 * right. The name of the setting stays a heading, because that is what it is —
 * a settings list is a document with sections, and a screen reader navigates
 * it as one. `controls` names the control's element inside that heading, so the
 * name is also the control's label rather than text that merely sits beside it.
 *
 * The explanation is shown on hover or focus of the ⓘ beside the name, and
 * stays in the document as text for a screen reader to read in order. A row
 * that carries its paragraph at all times is a row nobody scans; a row whose
 * detail is one hover away is.
 */
export function SettingsRow({
  label,
  explanation,
  controls,
  stacked,
  children,
}: {
  label: string
  explanation: string
  controls?: string
  /** Render the controls below the label and explanation instead of beside
   * them — for text fields, which want the full width and read better when
   * the words they answer to sit directly above them. */
  stacked?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={
        stacked
          ? "flex flex-col gap-2"
          : "flex items-center justify-between gap-6"
      }
    >
      <div className="flex flex-col">
        {/*
          The ⓘ is a sibling of the heading rather than a child of it: its own
          name would otherwise become part of the heading's, and the heading is
          what names the control beside it.
        */}
        <div className="flex items-center gap-1.5">
          <h2 id={`${headingId(label)}-heading`} className="type-section">
            {controls === undefined ? (
              label
            ) : (
              <label htmlFor={controls}>{label}</label>
            )}
          </h2>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`About ${label}`}
                  className="flex items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                />
              }
            >
              <InfoIcon className="size-3.5" />
            </TooltipTrigger>
            {/* A visual duplicate of the sentence already below, which a
                screen reader would otherwise read twice. */}
            <TooltipContent aria-hidden="true">{explanation}</TooltipContent>
          </Tooltip>
        </div>
        <p className="sr-only">{explanation}</p>
      </div>
      <div
        className={
          stacked ? "flex items-center gap-2" : "flex shrink-0 items-center gap-2"
        }
      >
        {children}
      </div>
    </div>
  )
}

/** Said plainly, and never in place of the setting it is about. */
export function SettingsProblem({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="type-meta text-destructive">
      {children}
    </p>
  )
}

/**
 * A field the settings file would not take, named: the other field may have
 * saved perfectly well, and a line that said only "that" would leave the user
 * guessing which of the two to type again.
 */
// A sentence every group may need to say, wherever the settings file
// refused its field — so it lives beside the group it speaks in.
// eslint-disable-next-line react-refresh/only-export-components
export function notStored(field: string): string {
  return `${field} could not be saved to the settings file, so it will be gone at the next launch.`
}

/**
 * Standing context: a consequence the reader needs before they act, which is
 * exactly what must not be hidden behind a hover.
 */
export function SettingsAside({ children }: { children: React.ReactNode }) {
  return <p className="type-meta text-muted-foreground">{children}</p>
}

/**
 * A Row's heading, named after the setting, so that a control which cannot
 * carry a `<label>` — a group of buttons is not a form field — can still point
 * at the words the user is reading as its own name.
 */
function headingId(label: string): string {
  return label.toLowerCase().replace(/[^a-z]+/g, '-')
}
