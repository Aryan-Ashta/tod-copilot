import type { ReactNode } from 'react'
import Brand from './Brand'

/**
 * Top of the side panel on the plan and edit screens: the name (home link) left, the link to the other screen right,
 * and a line about the plan underneath. It scrolls with the panel.
 */
export default function PanelHeader({ link, children }: { link: ReactNode; children?: ReactNode }) {
  return (
    <header className="shrink-0 border-b border-rule px-5 py-3">
      <div className="flex items-center justify-between gap-3">
        <Brand className="text-[19px]" />
        {link}
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] empty:hidden">{children}</div>
    </header>
  )
}
