# Review Material is a third lossless rendering

> Amended by [ADR 0041](0041-work-summary-combines-a-selected-period-with-current-commitments.md): Work Summary now owns a date range of its own, so "A Review surface with its own day range" below is no longer rejected — a surface whose purpose is not History's may hold its own axis, and History keeps its Filter. Review Material itself is unchanged: still Filter-shaped, still retrospective, still never Open Tasks. Where this ADR names Standup Material, read [Work Summary Material](0041-work-summary-combines-a-selected-period-with-current-commitments.md), which superseded it.

Reading back a week, a month or a quarter is a named payoff of the journal, but the app only productized the day. Preparing a review means copying a Digest for the range and then hand-searching Tasks View for what was completed in it, because the two record types are reachable only from different surfaces. Review Material is the Filter's Notes and the work completed in the Filter's days as one lossless Markdown document, copyable from History with no key, no network and no waiting.

That makes three lossless renderings: the [Digest](0027-the-standup-post-never-replaces-yesterdays-digest.md), which is Notes-shaped and Filter-shaped; [Standup Material](0031-standup-material-is-a-second-lossless-rendering.md), which is yesterday-shaped and adds both completed and open Tasks; and Review Material, which is Filter-shaped and adds completed work only. Three renderings is a cost, and the naming carries it: Material is a rendering that is always true, and the prose written from Material — a Standup Post, and later a Review Brief — is lossy and may be wrong.

Review Material exists only under Project `Any`. The Filter has two axes and a Task can honour only one of them: `CONTEXT.md` and ADR 0014 say a Task is never filed under a Project. Rather than let the artifact mean a different thing depending on a control elsewhere in the header, the action states the rule and asks for `Any`.

## Considered options

- **Grow the Digest to carry completed work**, leaving one Filter-shaped artifact instead of two. Rejected for the reason ADR 0031 already gave: a Digest is Filter-shaped *and* Notes-shaped by definition — its very type reports a `noteCount` — and Tasks match neither axis of the Filter. Widening it would make `Copy` in History mean something different from `Copy Yesterday's Digest` in the Tray Menu.
- **Notes only under a named Project, plus a line saying Tasks were omitted.** Rejected: that packet is the Digest for those days plus an apology. It ships a second action whose output is byte-for-byte what the first one already produces, and whose identity changes silently with the Project control.
- **Completed work regardless of the Project constraint**, with the section stating it is not Project-filtered. Rejected: honest, but it drops unrelated completions into a Project-specific review, and hand-stripping them is work the user came here to avoid.
- **Completions only, never Notes**, leaving the Digest to cover Notes. Rejected: it breaks superset-by-construction — the property that keeps two renderings from ever disagreeing — and forces two pastes into the one prompt this is assembled for.
- **Interleaving completions with Notes under each day heading.** Rejected reluctantly: it reads best, but it requires re-rendering the Digest rather than embedding it verbatim, and a second serialisation of Notes would eventually describe a journal the user does not have.
- **Open Tasks in the packet**, as Standup Material carries them. Rejected: a review is a claim about what happened. Adding what is still owed makes it a status report, and makes it disagree with Tasks View the moment anything moves.
- **A Review surface with its own day range.** Rejected: History already owns the day axis, and two range controls in one app can disagree about which days the user means.
- **A dialog to read before copying.** Rejected for now: with generation deferred, there is nothing to read — the dialog would hold one button. The prose feature is where a surface earns its place.

## Consequences

- **ADR 0027 and ADR 0031 both still hold and are not amended.** The Digest remains the floor, Standup Material remains the day's complete rendering, and neither changes shape.
- **Review Material contains the Filter's Digest verbatim**, then a Completed section day-grouped under the same headings and running oldest-first, so the two can never disagree about the Filter's Notes. If they ever do, the Digest is right.
- **One top-level heading names the range**, in the same words the Filter control reads. Because the artifact exists only under `Any`, it needs no Project line.
- **History gains a second Copy action**, labelled so the two outputs cannot be confused, and each copy says which of the two landed on the clipboard. Under a named Project or Unfiled it is present but disabled, stating the rule rather than disappearing.
- **A range with neither Notes nor completions copies nothing** and says so. A range whose only content is completed work is a real range and is not refused.
- **The bullet renderers and the day-grouping helper are now shared by three renderings.** They are extracted from `standup-post.ts` rather than copied, with Standup Material's output unchanged.
