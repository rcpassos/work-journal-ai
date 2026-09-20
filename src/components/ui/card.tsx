import { cn } from "@/lib/utils"

/**
 * A bordered surface holding one thing: the settings of a section, a summary,
 * a callout. Nothing but the surface — what sits inside decides its own
 * padding and divisions.
 */
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "rounded-xl border border-border bg-card text-card-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Card }
