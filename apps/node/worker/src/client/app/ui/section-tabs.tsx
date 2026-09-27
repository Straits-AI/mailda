import { Link } from "@tanstack/react-router";

import type { AppRoute } from "../../../app-routes.ts";

/**
 * Sibling screens under one sidebar row (Butlers and Rules, under Automations), as links, because each is a
 * route of its own and a bookmark to either still lands on it. No heading here: the screen keeps its own h1.
 */
export function SectionTabs({ label, tabs }: { label: string; tabs: ReadonlyArray<{ to: AppRoute; label: string }> }) {
  return (
    <nav className="section-tabs" aria-label={label}>
      {tabs.map((tab) => (
        <Link key={tab.to} to={tab.to} className="section-tab" activeProps={{ className: "section-tab current" }}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
