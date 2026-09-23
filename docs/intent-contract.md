# The intent contract, measured

Observing will one day take what the user asked their AI tools for and put it
in the journal. How many Notes a day of that should become is not decided yet
(#264). This page is the week of measurement that decides it (#263): each
tool's own configuration appends one JSON line per prompt to a plain file, and
nothing else happens.

The app ships nothing for this. No command, no Settings, and no Note, and
nothing touches the journal database. The file sits outside the journal and is
yours to read and delete. Why the tools push lines instead of the app reading
their session files is ADR 0044.

## The entry

One JSON object per line, appended to `~/intent.jsonl`. To use another file,
change the path in both snippets. Its directory must already exist.

The file holds every prompt verbatim, including anything pasted into one, so
the snippets create it readable by you alone (`umask 077`, so mode 600, as
`~/.claude/history.jsonl` is). That only applies when they create it. If the
file already exists, run `chmod 600 ~/intent.jsonl`.

```json
{"tool":"claude-code","session":"0f3c…","turn":"8a21…","at":"2026-09-24T09:12:40Z","cwd":"/Users/me/work/acme-api","client":"claude-desktop","line":"add retry to the webhook sender"}
```

| Field | What it is |
| --- | --- |
| `tool` | `claude-code` or `codex`. |
| `session` | The tool's own session id (Claude Code) or thread id (Codex). Turns with the same value are one session. |
| `turn` | The tool's turn id: Codex's `turn_id`, and Claude Code's `prompt_id`, which Claude Code sends from v2.1.196. It is `null` when the tool sends none. |
| `at` | When the snippet ran, in UTC and to the second. |
| `cwd` | The working directory the tool reported. It is a path, never a Project. A snippet cannot know the journal's Projects, and Project identity will belong to Project Mappings (#262), which a rename will rewrite along with Notes. |
| `client` | Who sent the prompt, as far as the tool says (see below). |
| `line` | The prompt the user submitted, verbatim. |

**Interactive or not.** Neither tool has a documented "a person typed this"
flag. `client` records the closest signal each one gives, as-is:

- Claude Code: `$CLAUDE_CODE_ENTRYPOINT`, an undocumented environment variable.
  **It cannot answer the question on this machine.** Every session here runs
  in the desktop app, and all 128,536 entrypoints recorded locally are
  `claude-desktop`. A prompt a tool started and a prompt the user typed look
  the same. So #264 gets no interactive share for Claude Code, including for
  the one-prompt sessions #263 asked about. It is recorded anyway in case the
  week includes a `cli` or `sdk-*` session.
- Codex: the payload's `agent_type`, which Codex sets only when a subagent sent
  the prompt. `null` means the thread's own prompt.

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
            "command": "{ umask 077; jq -c '{tool: \"claude-code\", session: .session_id, turn: .prompt_id, at: (now | todate), cwd: .cwd, client: env.CLAUDE_CODE_ENTRYPOINT, line: .prompt}' >> \"$HOME/intent.jsonl\"; } 2>/dev/null; exit 0"
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

**Emits the prompt the user submitted, on `UserPromptSubmit`: one entry per
prompt, before the agent answers it**, the same event and moment as Claude
Code. Nothing from the agent's side is recorded.

Needs Codex's lifecycle hooks, which are on by default (`codex features list`
shows `hooks stable true` from 0.147.0). Add this to `~/.codex/config.toml`:

```toml
[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
timeout = 5
command = '''p=$(cat 2>/dev/null); (umask 077; printf '%s' "$p" | jq -c '{tool: "codex", session: .session_id, turn: .turn_id, at: (now | todate), cwd: .cwd, client: .agent_type, line: .prompt}' >> "$HOME/intent.jsonl") >/dev/null 2>&1 & exit 0'''
```

Codex skips hooks marked `async` ("async hooks are not supported yet"), so
this command backgrounds the write itself. It reads the payload first, then
hands the write to a background process and exits. Codex runs it through your
login shell (`$SHELL -lc`), and it behaves the same under `sh` and zsh.

`notify` is not used. It fires after the agent has answered, which would put
Codex's `at` later than Claude Code's and count turns where Claude Code counts
prompts. Codex allows only one `notify` program, so the snippet would also have
to chain whatever already runs there. And Codex's own source calls it legacy
and marks it for removal.

## What both snippets promise

- They work whether or not the app is running, because nothing in them talks
  to it.
- They never break or delay the tool. The write happens in the background, the
  snippet exits 0, and it prints nothing, including when `jq` is missing, the
  payload is malformed or the file's directory does not exist. In those cases
  the entry is lost without a word, and a quiet file is the only symptom.
- They are POSIX `sh` plus `jq`. macOS ships `/usr/bin/jq` from 15 onwards.

Two prompts written at the same instant could in principle interleave on a very
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
