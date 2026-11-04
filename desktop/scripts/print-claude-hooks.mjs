#!/usr/bin/env node
/**
 * Prints the Claude Code hook configuration for SMOI (FR-10.07). It does NOT edit any file:
 * merge the printed "hooks" block into ~/.claude/settings.json yourself.
 *
 *   node desktop/scripts/print-claude-hooks.mjs            (port 47821)
 *   node desktop/scripts/print-claude-hooks.mjs --port 50000
 *
 * The secret is not printed into the config. Each hook reads it from the SMOI_HOOK_SECRET
 * environment variable when it runs, so settings.json never holds it.
 *
 * Each hook:
 *   - pipes Claude Code's hook input (stdin) to SMOI with curl;
 *   - gives up after 2 seconds (-m 2, FR-10.08), so a closed SMOI never slows Claude Code;
 *   - always exits 0 (|| true), so SMOI being closed never shows as a hook error.
 */
const i = process.argv.indexOf('--port');
const port = i > 0 ? Number(process.argv[i + 1]) : 47821;
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('--port must be a number from 1024 to 65535');
  process.exit(1);
}

const command = (route) =>
  `curl -s -o /dev/null -m 2 -X POST -H "Content-Type: application/json" ` +
  `-H "X-SMOI-Hook-Secret: $SMOI_HOOK_SECRET" --data-binary @- http://127.0.0.1:${port}/claude/${route} || true`;

const hook = (route) => [{ type: 'command', command: command(route), timeout: 5 }];

const config = {
  hooks: {
    UserPromptSubmit: [{ hooks: hook('start') }],
    Stop: [{ hooks: hook('done') }],
    Notification: [{ matcher: 'permission_prompt', hooks: hook('waiting') }],
  },
};

console.log(JSON.stringify(config, null, 2));
