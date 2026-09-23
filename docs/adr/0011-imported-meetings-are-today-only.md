# Imported meetings are today-only, never backfilled

Import covers the current day and nothing else: meetings become Notes as they end, plus a catch-up on wake or launch for anything from *today* that was missed. Never a historical backfill — including the first time the feature is enabled. Rejected: an unbounded catch-up, which on a Monday would import all of the previous week and bury a journal whose whole value is a short honest record of what was actually done; and today-only with no wake catch-up, which loses a meeting forever whenever the lid closes before it ends, since nothing would ever look back for it.

The day is bounded by when a meeting **ran**, not by when it began. A meeting is swept once it has ended, provided it ended after today's local midnight and began no earlier than yesterday's. Anchoring on the start instead loses the meeting that was still running as today began — before midnight it has not ended, and after midnight it no longer began today, so no sweep could ever reach it. That is a silent, permanent loss of exactly the late call most worth remembering, and "a missed meeting is worse than an extra one" decides it.

## Consequences

A meeting that crossed midnight becomes a Note on the day it **began**, which by the time it is swept is yesterday — Captured At is the instant the meeting began, so it cannot land anywhere else. This is the single exception to "never yesterday", and it is bounded by the meeting having ended today: a meeting that ended before today's midnight is never swept, however recently the app woke, and neither is a multi-day event that ends today but began before yesterday.

## Amended: Observing reads seven days back, inside consent

This rule is Meeting Import's and stays so. Observing does not share it. Commits are filtered by author date, and on this machine they are mostly authored between 22:00 and midnight: under today-only, a commit made at 23:40 before closing the lid, or merged on GitHub and fetched the next morning, would be lost for good. The reason above — a catch-up burying the journal — does not carry over: an Observed Note lands on its own Journal Day rather than on today, at nought to five a day.

So the commit sweep reads what was authored in the last seven days, and only inside a consented interval. Enabling Import at 18:40 imports a meeting that began at 09:30, because no enablement instant was ever stored; Observing cannot work that way, since a commit authored before the user said yes is work they did not consent to have recorded. The instants Observing was turned on and off, and a repository added to and removed from the list, are stored per repository in the settings store and survive a restart, and a commit is observed only if it was **authored** inside one of those intervals — never by when a sweep found it. Nothing from before the first enablement ever arrives, so there is still no backfill before consent. Intervals are pruned once they end before the lookback. See `src/settings/observing.ts`.

Whether Meeting Import should adopt the same rule is a separate question, not answered here.
