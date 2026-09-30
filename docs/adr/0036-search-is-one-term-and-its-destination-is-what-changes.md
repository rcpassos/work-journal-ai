# Search is one term, and its destination is what changes

A Search finds a record anywhere in the journal by what its own text says, and
takes the reader to where that record already lives. That is the whole of the
term. Where it lands belongs to the section it was opened in, not to the word:
in History the Filter moves to the day the Note is filed under; in Tasks View
the Task is focused in its list, switching to Completed Tasks if that is where
it sits. One term with two destinations, not two terms.

## Why

ADR 0004 put the History destination in the decision itself — "Search moves the
Filter rather than narrowing it" — which reads, thirty ADRs later, as though
moving a Filter were part of what a Search *is*. It is not. Tasks View has no
Filter and is not going to get one: it organises prospectively, by state and by
schedule read off the clock, and there is nothing there to move. If the
destination were part of the term, Tasks would need a second word.

There is no good second word. Search's own _Avoid_ line already rejects Query,
find, and filter by text, which exhausts the plausible synonyms; what remains is
a compound like Task Search, and a term that is another term with a scope prefix
is not a second term — it is evidence of the first one.

What ADR 0004 actually decided survives the generalisation intact, and it is the
part worth keeping: results are a distinct arm of the section's state, so the
list and the results are never both on screen; results do not re-run as the
journal changes; Escape belongs to the results while they are up. All three
describe the shape of a way in, and none of them mentions a Filter.

The line this contradicts is itself the argument for it. Tasks View is defined
as having "no arbitrary filters or Search", which groups Search with filters —
the exact category error ADR 0004 was written to prevent. A filter narrows what
is on screen and stays; a Search replaces it and then leaves. That Tasks View
has no filters is a domain rule and remains one. That Tasks View has no Search
was a fact about what had been built.

## Consequences

- **A Search belongs to the section it is opened in and searches only that
  section's record.** Notes in History, Tasks in Tasks View. Not a scope the
  reader picks — there is no control for it, and one result list mixing the two
  record types would have no single destination to send the reader to.
- **The destination is said per record type, and is the only part that differs.**
  A Note result moves the Filter to its Journal Day; a Task result focuses the
  Task where it already sits. Neither is a second concept: both are the reader
  arriving at the record in the context that section reads it in.
- **A result is labelled with its place in that section's terms** — a Note with
  the day it is filed under, a Task with the state it is in.
- **Matching is one rule, not one per record.** A case-insensitive substring of
  the record's own single line of text — Body for a Note, Task Description for a
  Task — with the non-ASCII case-folding limit ADR 0004 already recorded. A term
  that matched differently in two places would be two terms wearing one name.
- **ADR 0004 keeps its title and every word of its reasoning.** It decided
  something about History, and all of it is still true of History. This narrows
  what that title claims about the *term*, not what it decided about the section.
- **CONTEXT.md changes only when a Search actually reaches Tasks View.** At that
  point the Tasks View entry loses "or Search" and keeps "no arbitrary filters",
  and Search's definition sheds the Filter from its opening clause. Until then
  the glossary describes History's Search, because that is the only one there is.

## Extension for Task Details (#276)

Task Details extends the matching rule above beyond a Task's single-line
Description: Search matches a case-insensitive literal substring in either Task
Description or Task Details, returning each Task once. Notes still match only
Body. This supersedes the single-line restriction for Tasks while retaining the
existing matching semantics, case-folding limit, ordering and destinations.
