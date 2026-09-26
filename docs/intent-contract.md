# The intent contract, measured

Observing will one day take what the user asked their AI tools for and put it
in the journal. How many Notes a day of that should become is not decided yet
(#264). This page is the week of measurement that decides it (#263): each
tool's own configuration appends one JSON line per prompt to a plain file, and
nothing else happens.

The app ships nothing for this. No command, no Settings, and no Note, and
nothing touches the journal database. The file sits outside the journal and is
yours to read and delete. Why the tools push lines instead of the app reading
their session files is ADR 0044. Claude Code, Codex and opencode each push it
from their own configuration, and the contract is the same line for all three.

## The entry

One JSON object per line, appended to `~/intent.jsonl`. To use another file,
change the path in all three snippets. Its directory must already exist.

The file holds every prompt verbatim, including anything pasted into one, so
the snippets create it readable by you alone (`umask 077` in the shell ones, an
explicit mode in opencode's, both landing on 600, as
`~/.claude/history.jsonl` is). That only applies when they create it. If the
file already exists, run `chmod 600 ~/intent.jsonl`.

```json
{"tool":"claude-code","session":"0f3c…","turn":"8a21…","at":"2026-09-24T09:12:40Z","cwd":"/Users/me/work/acme-api","client":"claude-desktop","line":"add retry to the webhook sender"}
```

| Field | What it is |
| --- | --- |
| `tool` | `claude-code`, `codex` or `opencode`. |
| `session` | The tool's own session id (Claude Code, opencode) or thread id (Codex). Turns with the same value are one session. |
| `turn` | The tool's turn id: Codex's `turn_id`, Claude Code's `prompt_id` (which Claude Code sends from v2.1.196), and opencode's user message id. It is `null` when the tool sends none. |
| `at` | When the snippet ran, in UTC and to the second. Seconds, not milliseconds: `jq`'s `fromdate`, which every query below uses, rejects a fractional second. |
| `cwd` | The working directory the tool reported. It is a path, never a Project. A snippet cannot know the journal's Projects, and Project identity will belong to Project Mappings (#262), which a rename will rewrite along with Notes. |
| `client` | What started the session, or a subagent (see below). |
| `line` | The prompt the user submitted, verbatim. |

**Interactive or not: no tool gives an interactive share.** None has a
documented "a person typed this" flag, and #264 should not expect a number.
`client` records the closest signal each one gives, as-is:

- Claude Code: `$CLAUDE_CODE_ENTRYPOINT`, an undocumented environment variable.
  **It cannot answer the question on this machine.** Every session here runs
  in the desktop app, and all 128,536 entrypoints recorded locally are
  `claude-desktop`. A prompt a tool started and a prompt the user typed look
  the same. So #264 gets no interactive share for Claude Code, including for
  the one-prompt sessions #263 asked about. It is recorded anyway in case the
  week includes a `cli` or `sdk-*` session.
- Codex: the payload's `agent_type`, which Codex sets only when a subagent sent
  the prompt. `null` means the thread's own prompt, which is not the same as a
  typed one: a `codex exec` prompt looks identical.
- opencode: `"subagent"` when the session has a parent, which is how opencode
  marks a prompt that went to a child session, whichever tool created it.
  `null` is a root session. opencode adds no client signal, so the desktop app
  and the TUI look alike, exactly as `claude-desktop` and `cli` do above.

**A subagent's prompt is not the user's prose, in any of the three.** opencode
makes that plainer than the others: the text it hands a child session is
written by the runtime, opening `You are a subagent spawned by another session.`
as the four subagent entries in this week's file all do. So #264 should read
`client` as a filter, not as a source of intent.

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
shows `hooks stable true` from 0.147.0). Add this to `~/.codex/config.toml`,
then trust it:

```toml
[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
timeout = 5
command = '''p=$(cat 2>/dev/null); (umask 077; printf '%s' "$p" | jq -c '{tool: "codex", session: .session_id, turn: .turn_id, at: (now | todate), cwd: .cwd, client: .agent_type, line: .prompt}' >> "$HOME/intent.jsonl") >/dev/null 2>&1 & exit 0'''
```

**A hook added to `config.toml` does not run until it is trusted**, and until
then the file just stays quiet, which looks like a quiet week. Trust it in the
review the Codex TUI shows at startup, or in `/hooks`. `codex exec` never asks,
so do this in the TUI. Then submit one prompt and check that a `codex` line
lands in the file. Codex trusts a hash of the command (`trusted_hash` under
`[hooks.state]`), so editing the command, such as changing the path, switches
it off again until it is trusted again.

Codex skips hooks marked `async` ("async hooks are not supported yet"), so
this command backgrounds the write itself. It reads the payload first, then
hands the write to a background process and exits. Codex runs it with your account's
shell and `-c`, and it behaves the same under `sh` and zsh. `zsh -c` still
reads `~/.zshenv`, and anything that prints goes into the model's context on
every prompt, so keep `~/.zshenv` silent.

`notify` is not used. It fires after the agent has answered, which would put
Codex's `at` later than Claude Code's and count turns where Claude Code counts
prompts. Codex allows only one `notify` program, so the snippet would also have
to chain whatever already runs there. And Codex's own source calls it legacy
and marks it for removal.

## opencode

**Emits the prompt the user submitted, on the prompt-admission hook: one entry
per prompt, before the agent answers it**, at the same point in the exchange as
the other two. Nothing from the agent's side is recorded.

This one is a plugin file, not a shell command, because opencode has no
command hook. Put it at `~/.config/opencode/plugins/intent.js`, which opencode
discovers on its own: no entry in `opencode.json`, no install, and no restart
when you save it, which the running service did on this machine without being
asked.

```js
// The intent contract: one JSON line per prompt, appended to ~/intent.jsonl.
// Nothing else happens here: no Note, no journal, no request to any app.
// Docs and the other two tools' snippets: docs/intent-contract.md
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const FILE = join(homedir(), "intent.jsonl")

// The prompt hook is not an exactly-once boundary, so a message id is written once.
const written = new Set()

export default {
  id: "intent.contract",
  async setup(ctx) {
    await ctx.session.hook("prompt", async (event) => {
      if (written.has(event.messageID)) return
      written.add(event.messageID)
      // A session that cannot be read costs the entry its cwd and client, never the prompt.
      const session = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
      try {
        const entry = {
          tool: "opencode",
          session: event.sessionID,
          turn: event.messageID,
          at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          cwd: session?.location?.directory ?? null,
          client: session?.parentID ? "subagent" : null,
          line: event.prompt.text,
        }
        appendFileSync(FILE, JSON.stringify(entry) + "\n", { mode: 0o600 })
      } catch {
        // A lost entry is the only symptom, and opencode is never delayed or broken by it.
      }
    })
  },
}
```

**It is a plain default export, with no import of opencode's own types.**
`@opencode/plugin` is published, at 2.0.18 here, and is what the official
plugin docs import, but nothing on this machine has it installed and opencode
does not supply it to a plugin: the load fails with `Cannot find package
'@opencode/plugin'`. Installing a package to satisfy a type that the object
already satisfies is a cost this snippet does not need to carry.

To see it work, submit one prompt and read the last line:

```bash
tail -n 1 ~/intent.jsonl | jq -c '{tool, session, turn, cwd, client}'
```

Four things the hook does that are worth knowing:

- **The admission hook is the right seam, and it is quiet where it should be.**
  It runs once per prompt, before the model call, and it does not run for
  synthetic messages, shell messages, compaction or move controls, so none of
  those land in the file.
- **The text is the prompt as typed, before attachments and skills are
  resolved**, which is why a line holds prose and no file paths. A later hook
  could still rewrite that text before it is persisted, and then the entry
  would differ from what the session kept.
- **It is not an exactly-once boundary.** A retried admission returns the
  original without rerunning the hook, but concurrent submissions can run it
  more than once, so the snippet skips a message id it has already written. The
  id is marked before the write, so a failed write is not retried either, which
  costs nothing: a file that cannot be written will not become writable inside
  one prompt.
- **It does not run in the background, unlike the shell ones.** It costs one
  local session read and one synchronous append inside prompt admission, and it
  swallows its own errors, so a failure delays nothing and prints nothing.

The `cwd` is the session's own location, so a session in a worktree records the
worktree, as Claude Code's does. The agent is not recorded, because the contract
carries the same seven fields for every tool; `ctx.session.get` returns it if a
later decision ever needs it.

## What all three snippets promise

- They work whether or not the app is running, because nothing in them talks
  to it.
- They never break or delay the tool. The shell ones hand the write to a
  background process and exit 0, and opencode's appends inline and swallows its
  own errors; none of the three prints anything, including when `jq` is missing,
  the payload is malformed, the session cannot be read or the file's directory
  does not exist. In those cases the entry is lost without a word, and a quiet
  file is the only symptom.
- The two shell ones are POSIX `sh` plus `jq`. macOS ships `/usr/bin/jq` from 15
  onwards. The opencode one is a plugin file and needs nothing beyond the node
  built-ins it imports, which is the one place this contract is not portable
  shell: opencode has no command hook to be portable in.

**Concurrent appends do cost entries, and have already.** Two prompts written at
the same instant can interleave, because the shell snippets append from a
process each. In four days of this week, 2 of 386 lines do not parse: one
7,760-character Claude Code prompt, a pasted `<agent-message>`, was split
across two lines and both halves were lost. That is half a percent, and the
queries below skip those lines rather than fail on them. opencode cannot
interleave with itself, since it appends from one process, though a
`--standalone` run is a second one.

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

# entries by client (Codex and opencode: subagent vs thread; not an interactive share)
jq -rR 'fromjson? | [.tool, (.client // "none")] | @tsv' "$F" | sort | uniq -c

# working directories
jq -rR 'fromjson? | .cwd' "$F" | sort | uniq -c | sort -rn

# what one day reads like (change the date)
jq -rR "fromjson? | select($DAY == \"2026-09-24\") | [(.at | fromdate | localtime | strftime(\"%H:%M\")), .cwd, .line] | @tsv" "$F"
```

Once the report is on #264, remove all three snippets and delete the file. It
holds every prompt verbatim, including anything that was pasted into one.
