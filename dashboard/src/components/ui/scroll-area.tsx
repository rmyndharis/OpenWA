import * as React from "react"

import { cn } from "@/lib/utils"

function ScrollArea({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="scroll-area"
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <div
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] overflow-y-auto"
      >
        {children}
      </div>
    </div>
  )
}

function ScrollBar({
  className: _className,
  orientation: _orientation = "vertical",
}: React.HTMLAttributes<HTMLDivElement> & {
  orientation?: "vertical" | "horizontal"
}) {
  return null
}

export { ScrollArea, ScrollBar }
