# Claude Code notifications: setup

SMOI can tell you when a Claude Code session on this PC finishes a long run, or is blocked
waiting for your permission (FR-10). Claude Code's hooks call a small listener inside the SMOI
desktop app. SMOI never edits your Claude Code settings: you add the hooks yourself.

## What SMOI learns

Only that a session started a run, finished it, or is waiting, plus the session's id. The hook
sends Claude Code's whole hook input, but SMOI keeps only `session_id` and `hook_event_name` and
throws away everything else (your prompt, messages, paths) without logging it.

## 1. Choose a secret

Generate a random secret of at least 16 characters, for example in PowerShell:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

Set it as a **user** environment variable, so both SMOI and Claude Code's hooks can read it,
and keep it out of `settings.json`:

```powershell
[Environment]::SetEnvironmentVariable('SMOI_HOOK_SECRET', '<your secret>', 'User')
# Optional, only if port 47821 is taken:
[Environment]::SetEnvironmentVariable('SMOI_HOOK_PORT', '47821', 'User')
```

Restart SMOI, and open a new terminal for Claude Code, so both see the variable. In SMOI,
**Settings > Claude Code** should say "Listening for Claude Code hooks on 127.0.0.1:47821".

## 2. Print the hook config

```bash
node desktop/scripts/print-claude-hooks.mjs            # or: --port 50000
```

It prints:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "curl ... /claude/start || true", "timeout": 5 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "curl ... /claude/done || true", "timeout": 5 }] }],
    "Notification": [{ "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "curl ... /claude/waiting || true", "timeout": 5 }] }]
  }
}
```

## 3. Merge it into `~/.claude/settings.json`

Add the three entries under `"hooks"`. If you already have hooks for these events, add SMOI's
entry to the existing array instead of replacing it. Then run `/hooks` in Claude Code to check
they are loaded.

Each hook gives up after 2 seconds (`curl -m 2`) and always exits 0 (`|| true`), so Claude Code
is never slowed down or shown an error when SMOI is closed.

## 4. Try it without Claude Code

```bash
SMOI_HOOK_SECRET=<your secret> bash desktop/scripts/claude-hook-demo.sh waiting
SMOI_HOOK_SECRET=<your secret> bash desktop/scripts/claude-hook-demo.sh long   # set the threshold to 0 first
SMOI_HOOK_SECRET=<your secret> bash desktop/scripts/claude-hook-demo.sh bad
```

## What SMOI does

| Event | SMOI |
| --- | --- |
| Run finished after at least the threshold (default 3 min) | Celebrates, with a bubble showing the duration |
| Run finished sooner, or SMOI never saw it start | Nothing |
| Waiting for permission | The attention pose and a pink bubble that stays until dismissed. Repeats within a minute are collapsed. |

Both are notification categories in **Settings > Notifications**, so they can be turned off or
given a priority. Normal priority is held during quiet hours, and high priority shows anyway.
**Settings > Claude Code** turns the whole feature off.

## Troubleshooting

- "Not listening: SMOI_HOOK_SECRET is not set": SMOI was started before the variable was set.
  Restart it.
- "Port 47821 is in use": set `SMOI_HOOK_PORT` to another port, then reprint the config with
  `--port` and merge it again.
- Nothing happens: run `claude --debug` and look for the hook commands, or run the demo script.
