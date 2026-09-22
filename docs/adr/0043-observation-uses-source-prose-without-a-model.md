# Observation uses source prose without a model

Observe turns a selected source event about work that happened into an Observed Note. Its Body is already a short line of the user's own prose about their work — for example, a commit subject. It has no missing narrative to infer, so the automatic layer stores that line, the event's instant, and its source identity directly.

The application does not call a model to decide whether an event becomes a Note, rewrite its Body, or add context. Source selection and later Project mapping are explicit user choices; an observed line stays attributable to its source and useful as a record in its own right. This follows [ADR 0015](0015-task-management-does-not-depend-on-ai-or-a-network.md): task management works locally without AI, and likewise source prose does not need a model to make it a Note.

Consequently, Observe is a deterministic recording path. It works without model access, does not infer work from a path or surrounding context, and never invents a Body the user did not write.
