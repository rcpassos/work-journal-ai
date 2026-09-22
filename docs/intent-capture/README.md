# AI-tool intent capture

These snippets collect a week of local measurements for issue [#263](https://github.com/rcpassos/work-journal-ai/issues/263). They append directly to a plain JSON Lines file. They do not call Work Journal, write Notes, or touch its database. The app ships none of this.

The shared record has the tool name, the tool's session or thread ID, a turn ID when the tool provides one, a UTC `timestamp` for when the hook ran, the working directory, the user's text, and an `interactive` value when the tool exposes enough information to identify it. It contains no Project name. Each event is one physical JSON line; embedded line breaks in prompt text are JSON-escaped.

## Install

The script uses POSIX `/bin/sh` and `jq` to parse and encode JSON without corrupting quotes, backslashes, or line breaks. If `jq` is unavailable or any write fails, the script exits successfully and prints nothing.

Copy the script somewhere stable and private:

```sh
mkdir -p "$HOME/.config/work-journal"
cp docs/intent-capture/capture-intent.sh "$HOME/.config/work-journal/capture-intent.sh"
chmod 700 "$HOME/.config/work-journal/capture-intent.sh"
```

By default, the output file is `$HOME/work-journal-intent.jsonl`. To choose another location, set `WORK_JOURNAL_INTENT_FILE` in the environment inherited by both tools, or change the `log_file` assignment near the top of the script. The script creates the parent directory and makes a new file owner-readable and owner-writable only.

The file contains the text of your prompts. Keep it in a private location and out of version control.

## Claude Code

Claude Code's `UserPromptSubmit` event fires once per submitted prompt, before Claude processes it. The snippet records the event's `prompt`, `session_id`, and `cwd`, including an empty prompt string if one is provided. This event does not provide a turn ID or say whether the session is interactive, so `turn_id` and `interactive` are `null`.

`SessionEnd` is deliberately not used. It provides session metadata, a reason, and a transcript path, but no prompt text. Reading that transcript would reintroduce the undocumented session-file parsing this experiment avoids.

Add this event to `~/.claude/settings.json`, merging it into any existing `hooks` object. Replace `/Users/YOU` with your home directory:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/bin/sh",
            "args": [
              "/Users/YOU/.config/work-journal/capture-intent.sh",
              "claude-code"
            ],
            "async": true
          }
        ]
      }
    ]
  }
}
```

`async: true` lets Claude continue without waiting for the file append.

## Codex

Codex's `notify` command runs for `agent-turn-complete`, once per completed turn. Its JSON payload includes `thread-id`, `turn-id`, `cwd`, `input-messages`, and an optional `client`. In the current Codex implementation, `input-messages` is taken from the model's retained conversation input and may repeat prompts from earlier turns. The snippet records only the final user-message string, the latest prompt in that history, so earlier prompts are not counted again. It stores the raw `client`; `interactive` is `true` for `codex-tui` and `null` when the payload does not establish interactivity.

Add this line to `~/.codex/config.toml`, replacing `/Users/YOU` with your home directory:

```toml
notify = ["/bin/sh", "/Users/YOU/.config/work-journal/capture-intent.sh", "codex"]
```

Codex appends its notification JSON as the final command argument and launches the command without waiting for it. If `notify` is already configured, update that existing command or call this script from its wrapper rather than adding a duplicate TOML key.

## Reading the file

Each line is one hook event, not a proposed Note. Claude records a prompt at submission; Codex records the latest user message when the turn completes, because that is when `notify` fires. `timestamp` is when the local handler starts, in UTC. Use the session or thread ID to group turns. The week of real use and its reading belong to the user; record the results on issue #264 before deciding what a day of intent should become.

References: [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Codex configuration reference](https://developers.openai.com/codex/config-reference), [Codex turn handling](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs), and the [Codex notify payload implementation](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/legacy_notify.rs).
