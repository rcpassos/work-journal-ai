# A session is for sequencing, not for state

> Amended: the count below is out of date. There are nine headless modules now: History, Tasks View, Import (the sweep), the Tray Count, Observe, Task Alerts, Work Summary, Tray Observing and the Yesterday Digest. Each one argued its way in as the last consequence asks: it orders overlapping reads, or it starts and stops around an asynchronous subscription. The rule is unchanged. Also, `askAboutTaskAlerts` is called by the Task Creation window and by the Task Editor through the Tasks View session. Settings only reads the permission and never asks for it.

Four surfaces in the app are headless sessions — History, Tasks View, the sweep, the tray count — and the shape is good enough that its absence started to read as a defect. It is not. A session earns its interface by holding **sequencing**: which of two overlapping reads may reach the screen, what a change re-reads, what a failure leaves behind, what happens in which order. A surface that holds only the value of its own controls is a view, and it keeps its state in React where it already lives.

Settings, the Capture window and the Task Creation window are views. They stay views.

## Considered options

- **A session per surface, for symmetry.** Rejected. `SettingsView` is form state with optimistic writes: every handler sets a value, writes it, and puts the old one back if the write fails. There is one read on mount, one focus listener, one close listener, and one derived rule — Import shows as the user's wish less whatever macOS is withholding — which already has tests. A session would restate `useState` as fields on a hand-rolled observable and gain nothing that could be asserted afterwards which cannot be asserted now.
- **A session for the two resident panels**, on the grounds that a commit is four ordered steps with three failure policies. Rejected: four awaits in one function, each carrying the comment that says why, is where that sequence is clearest. The rules underneath it — `decideKeystroke`, `markerPrefix`, `applyPrediction`, `askAboutTaskAlerts` — are extracted and tested already, which is the part that was worth extracting.
- **Counting `useState` and `useEffect` as the test.** Rejected as the trap that produced this ADR. `SettingsView` has fourteen and five; `HistoryView` has fewer of both and needs its session badly. The number says how many controls a view has, not how much order there is to get wrong.

## Consequences

- **The question to ask about a new surface is what it sequences, not how big it is.** If the answer is "nothing — it shows values and writes them back", it is a view.
- **A rule shared by two surfaces is extracted on its own, not by giving each of them a session.** `src/journal/task-alerts.ts` is the example: one function, one rule, used by the Task Creation window, the Task Editor and Settings, and it settled that question without any of the three changing shape.
- **A view is still tested through the DOM, and that is not a failure.** `SettingsView.test.tsx` presses controls because what a control reads and what pressing it means are genuinely decided in the view. Fifteen tests over jsdom is the right cost for that; moving them to Node would mean inventing an interface for them to cross.
- **Sessions stay rare enough to mean something.** Four is the count because four surfaces have sequencing worth naming. A fifth should have to argue for itself the same way.
- **This does not defend view size.** `SettingsView` is 842 lines and most of it is markup. If it becomes hard to read, the answer is more sub-components in the same file or beside it — not a module behind an interface.
