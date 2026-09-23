# The intent contract, measured

Observing will one day take what the user asked their AI tools for and put it
in the journal. How many Notes a day of that should become is not decided yet
(#264). This page is the week of measurement that decides it (#263): each
tool's own configuration appends one JSON line per turn to a plain file, and
nothing else happens.

The app ships nothing for this. No command, no Settings, and no Note, and
nothing touches the journal database. The file sits outside the journal and is
yours to read and delete. Why the tools push lines instead of the app reading
their session files is ADR 0044.

## The entry

One JSON object per line, appended to `~/intent.jsonl`. To use another file,
change the path in both snippets. Its directory must already exist.

```json
{"tool":"claude-code","session":"0f3c…","turn":"8a21…","at":"2026-09-24T09:12:40Z","cwd":"/Users/me/work/acme-api","client":"claude-desktop","line":"add retry to the webhook sender"}
```

| Field | What it is |
| --- | --- |
| `tool` | `claude-code` or `codex`. |
| `session` | The tool's own session id (Claude Code) or thread id (Codex). Turns with the same value are one session. |
| `turn` | The tool's turn id: Codex's `turn-id`, and Claude Code's `prompt_id`, which Claude Code sends from v2.1.196. It is `null` when the tool sends none. |
| `at` | When the snippet ran, in UTC and to the second. |
| `cwd` | The working directory the tool reported. It is a path, never a Project. A snippet cannot know the journal's Projects, and Project identity will belong to Project Mappings (#262), which a rename will rewrite along with Notes. |
| `client` | What started the session, as far as the tool says (see below). |
| `line` | The user's own text for the turn, verbatim. |

**Interactive or not.** Neither tool exposes a documented "a person typed
this" flag. `client` is the closest signal each one gives, recorded as-is and
not turned into a guess:

- Claude Code: `$CLAUDE_CODE_ENTRYPOINT`, such as `claude-desktop`, `cli` or
  `sdk-ts`. It is an environment variable Claude Code sets for the processes it
  starts. It is not in the hook payload, and it is not documented as stable.
- Codex: the payload's `client` field, when Codex sends one, otherwise `null`.

The reading decides which `client` values count as a person typing.

## Claude Code

**Emits the prompt the user submitted, on `UserPromptSubmit`: one entry per
prompt, before Claude answers it.** Nothing from Claude's side of the
conversation is recorded.

Add this to `~/.claude/settings.json`. If `hooks` already exists, add the
`UserPromptSubmit` entry beside the events already there:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "async": true,
            "command": "{ jq -c '{tool: \"claude-code\", session: .session_id, turn: .prompt_id, at: (now | todate), cwd: .cwd, client: env.CLAUDE_CODE_ENTRYPOINT, line: .prompt}' >> \"$HOME/intent.jsonl\"; } 2>/dev/null; exit 0"
          }
        ]
      }
    ]
  }
}
```

`async` makes Claude Code carry on without waiting. The command must print
nothing, because on this event Claude Code adds a hook's stdout to the prompt.

`SessionEnd` is not used. Its payload has a session id, a working directory, a
reason and a transcript path, and no prompt text. The only way to get text from
it would be to open the transcript, and reading that is the parsing this
contract exists to refuse.

## Codex

**Emits the user's messages for the turn, on `notify`. Codex fires `notify`
when a turn completes (`agent-turn-complete`), so this is one entry per turn,
written after the agent has answered.** A turn that carried more than one
user message joins them with newlines. The agent's reply
(`last-assistant-message`) is not recorded.

Codex runs a single `notify` program and appends the event's JSON as its last
argument. So the snippet records the entry and then runs whatever `notify`
already held, with the arguments it had. Put the old array's items after
`"sh"`:

```toml
notify = ["/bin/sh", "-c", '''
for p; do :; done
(printf '%s' "$p" | jq -c 'select(.type == "agent-turn-complete") | {tool: "codex", session: ."thread-id", turn: ."turn-id", at: (now | todate), cwd: .cwd, client: .client, line: (."input-messages" | join("\n"))}' >> "$HOME/intent.jsonl") >/dev/null 2>&1 &
[ $# -gt 1 ] && exec "$@"
exit 0
''', "sh"]
```

With an existing notifier it would end, for example,
`''', "sh", "/path/to/notifier", "turn-ended"]`. With nothing after `"sh"`,
only the entry is written. Codex's source calls `notify` its legacy
notification, so an upgrade during the week could stop the Codex entries. A
quiet day of `codex` lines is worth checking against `codex --version`.

## What both snippets promise

- They work whether or not the app is running, because nothing in them talks
  to it.
- They never break or delay the tool. The write happens in the background, the
  snippet exits 0, and it prints nothing, including when `jq` is missing, the
  payload is malformed or the file's directory does not exist. In those cases
  the entry is lost without a word, and a quiet file is the only symptom.
  Chained after an existing notifier, the Codex snippet exits with that
  notifier's status instead, which Codex ignores.
- They are POSIX `sh` plus `jq`. macOS ships `/usr/bin/jq` from 15 onwards.

Two turns written at the same instant could in principle interleave on a very
long line. Reading skips any line that does not parse.

## Reading the week

After a week, report these on #264. Days are local days:

```bash
F="$HOME/intent.jsonl"
DAY='(.at | fromdate | localtime | strftime("%Y-%m-%d"))'

# entries a day
jq -rR "fromjson? | $DAY" "$F" | sort | uniq -c

# sessions a day
jq -rR "fromjson? | [$DAY, .tool, .session] | @tsv" "$F" | sort -u | cut -f1 | uniq -c

# prompts per session: how many sessions had 1, 2, 3, … entries
jq -rR 'fromjson? | [.tool, .session] | @tsv' "$F" | sort | uniq -c | awk '{print $1}' | sort -n | uniq -c

# entries by client (the interactive share)
jq -rR 'fromjson? | [.tool, (.client // "none")] | @tsv' "$F" | sort | uniq -c

# working directories
jq -rR 'fromjson? | .cwd' "$F" | sort | uniq -c | sort -rn

# what one day reads like (change the date)
jq -rR "fromjson? | select($DAY == \"2026-09-24\") | [(.at | fromdate | localtime | strftime(\"%H:%M\")), .cwd, .line] | @tsv" "$F"
```

Once the report is on #264, remove both snippets and delete the file. It holds
every prompt verbatim, including anything that was pasted into one.
