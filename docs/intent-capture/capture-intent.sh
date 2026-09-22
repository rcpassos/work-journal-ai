#!/bin/sh
# Collect one user-prompt event as one JSON Lines record for a local measurement.
# Configure jq and the output path in docs/intent-capture/README.md.

exec >/dev/null 2>&1
umask 077

tool=${1-}
case "$tool" in
  claude-code)
    ;;
  codex)
    payload=${2-}
    [ -n "$payload" ] || exit 0
    ;;
  *)
    exit 0
    ;;
esac

home=${HOME:-.}
log_file=${WORK_JOURNAL_INTENT_FILE:-"$home/work-journal-intent.jsonl"}
[ -n "$log_file" ] || exit 0

timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ') || exit 0
log_directory=$(dirname "$log_file") || exit 0
mkdir -p "$log_directory" || exit 0

case "$tool" in
  claude-code)
    jq -c --arg timestamp "$timestamp" '
      select(.hook_event_name == "UserPromptSubmit")
      | select((.session_id | type) == "string")
      | select((.prompt | type) == "string")
      | {
          tool: "claude-code",
          session_id: .session_id,
          turn_id: null,
          timestamp: $timestamp,
          cwd: (.cwd // null),
          text: .prompt,
          interactive: null
        }
    ' >>"$log_file" || :
    ;;
  codex)
    printf '%s\n' "$payload" | jq -c --arg timestamp "$timestamp" '
      select(.type == "agent-turn-complete")
      | select((.["thread-id"] | type) == "string")
      | select((.["turn-id"] | type) == "string")
      | select((.["input-messages"] | type) == "array")
      | (
          [.["input-messages"][] | select(type == "string")]
          | if length > 0 then .[-1] else "" end
        ) as $text
      | {
          tool: "codex",
          thread_id: .["thread-id"],
          turn_id: .["turn-id"],
          timestamp: $timestamp,
          cwd: (.cwd // null),
          text: $text,
          interactive: (if .client == "codex-tui" then true else null end),
          client: (.client // null)
        }
    ' >>"$log_file" || :
    ;;
esac

exit 0
