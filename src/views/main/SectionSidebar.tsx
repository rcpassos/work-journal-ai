import { cn } from '@/lib/utils'
import WindowTitleBar from '@/components/WindowTitleBar'
import type { MainSection } from '@/platform/desktop'
import { SECTIONS } from './sections'

/**
 * The Main Window's sidebar: every section, with the one showing marked.
 *
 * It carries the window's title bar strip because the traffic lights are
 * overlaid on the window's top-left corner, which is over the sidebar — see
 * `WindowTitleBar`. The section beside it keeps a strip of its own, which is
 * what levels its first row with this one.
 *
 * Keyboard: ordinary buttons, so Tab reaches them in the order they are listed
 * and Enter or Space chooses one. Nothing here rebinds the arrow keys — a
 * sidebar of a few named places is a list of links, not a grid to steer around.
 */
export default function SectionSidebar({
  current,
  onChoose,
}: {
  current: MainSection
  onChoose: (section: MainSection) => void
}) {
  return (
    <nav
      aria-label="Sections"
      className="flex w-44 shrink-0 flex-col border-r border-sidebar-border bg-sidebar"
    >
      <WindowTitleBar />
      <div className="flex flex-col gap-0.5 p-2">
        {SECTIONS.map(({ id, label, icon: Icon }) => {
          const showing = id === current

          return (
            <button
              key={id}
              type="button"
              // The section showing is the page the window is on, so it is
              // said to be current rather than only painted differently.
              aria-current={showing ? 'page' : undefined}
              onClick={() => onChoose(id)}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-left type-meta',
                'outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                showing
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60',
              )}
            >
              <Icon aria-hidden className="size-4 shrink-0" />
              {label}
            </button>
          )
        })}
      </div>
    </nav>
  )
}
