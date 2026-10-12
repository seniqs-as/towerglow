# Running Towerglow

How to start, stop and check the server, and every option it takes. Commands
are run from the folder you cloned.

## Requirements

- macOS or Linux. On Linux everything works except the macOS conveniences
  (bringing a terminal forward, opening folders, desktop notifications).
  Windows is not supported.
- Node.js 22.18 or newer: the server runs its TypeScript sources directly.
  If Node comes from a version manager such as nvm, a non-interactive context
  (a LaunchAgent, cron, `bash -c`) may not find `node`: use its absolute path
  there.
- Claude Code and/or Codex, used at least once: Towerglow shows the sessions
  they record. A tool that is not installed is skipped.
- For the CEOs (`--ceo`): Claude Code 2.1.285 or newer. On Linux the workers'
  sandbox also needs `bubblewrap` and `socat`; without them a worker refuses
  to start rather than running unsandboxed.

## Install

```bash
git clone https://github.com/seniqs-as/towerglow.git
cd towerglow
npm install
npm run build
```

`npm run build` builds the page the server hands to your browser. Run it
again after updating, or the browser keeps getting the old page.

## Start

In the foreground, with the output in front of you:

```bash
node bin/towerglow.mjs start          # the observatory alone, fully offline
node bin/towerglow.mjs start --ceo    # with the CEOs: read docs/ceo-mode.md first
```

It prints a banner and stays attached to the terminal: **Ctrl+C** stops it,
and closing the window stops it too.

In the background, so it survives closing the window:

```bash
(umask 077 && mkdir -p ~/.towerglow/logs)
nohup node bin/towerglow.mjs start > ~/.towerglow/logs/server.log 2>&1 &
```

The server keeps no log of its own: everything goes to its output, so a
background start without the redirection loses it.

## Open the page

The banner names the address to open:

```
  TOWERGLOW
  open:      http://127.0.0.1:7317/?t=<token>
  claudeDir: /Users/you/.claude
  state:     /Users/you/.towerglow
  city:      12 towers, 2 live sessions
  providers: claude + codex
  ceo:       off
  mode:      observatory
  network:   no outbound connections
```

`start` does not open a browser. The token is created on the first start,
kept in `~/.towerglow/token` and reused, so the address stays the same across
restarts. To open it without copying:

```bash
open "http://127.0.0.1:7317/?t=$(cat ~/.towerglow/token)"      # macOS
xdg-open "http://127.0.0.1:7317/?t=$(cat ~/.towerglow/token)"  # Linux
```

Once the page has loaded, the token disappears from the address bar, so it
does not end up in a screenshot or your history. That tab remembers it, so
reloading works; a new tab needs the full address again. For a bookmark,
create it by hand with the full address.

With `--ceo` the banner also says which model the CEOs use, the quota ceiling,
and whether accepted work starts (`mode: EXECUTIVE`) or not (`mode: advisor`,
with `--no-execute`). A `billing:` line appears for each tool that an API key
in your environment puts on pay-as-you-go billing: see
[Subscription or API key](ceo-mode.md#subscription-or-api-key).

## Stop and restart

```bash
pkill -f towerglow.mjs                  # by name
kill "$(lsof -ti tcp:7317)"             # or by port
```

Both ask the server to shut down cleanly, which also stops the processes the
CEOs started. Avoid `kill -9`: it skips that and leaves them behind.

To restart, stop, wait a second, and start again. The server does not look
for a free port: if 7317 is still taken it exits with `EADDRINUSE`.

## Check

```bash
curl -s http://127.0.0.1:7317/healthz
```

The answer has `"ok":true` and `"redactionClamps":0`. That counter belongs
to the single point every piece of data passes through on its way to the
page: anything other than zero means a string had to be cut.

```bash
node bin/towerglow.mjs doctor
```

prints the versions, the folders Towerglow uses, the token's file permissions
and how many live Claude Code sessions it finds.

## Options

`node bin/towerglow.mjs start [options]`:

| Option | Default | What it does |
| --- | --- | --- |
| `--port <n>` | `7317` | The port, on `127.0.0.1`. Also `TOWERGLOW_PORT` |
| `--state-dir <path>` | `~/.towerglow` | Where this copy keeps its state. Also `TOWERGLOW_STATE_DIR` |
| `--claude-dir <path>` | `~/.claude` | Where Claude Code keeps its sessions |
| `--codex-dir <path>` | `~/.codex` | Where Codex keeps its sessions |
| `--providers <list>` | `claude,codex` | Which tools to watch |
| `--warmup-bytes <n>` | 8 MiB | How much of each transcript to read at start; `0` shows only what happens from now on |
| `--exclude <text>` | | Skip projects whose path contains the text. Repeatable |
| `--redact-paths` | off | Replace project names and paths with short hashes |
| `--no-titles` | | No session titles |
| `--no-recap` | | No "while you were away" summary |
| `--no-commit-text` | | No commit subjects |
| `--no-cmd-names` | | No command names for shell tools |
| `--no-focus` | | Never run `ps`, `osascript` or `open` (macOS) |
| `--ceo` | off | Turn on the CEOs. See [ceo-mode.md](ceo-mode.md) |
| `--no-execute` | | With `--ceo`: advice only, accepted work never starts |
| `--ceo-model <alias>` | `sonnet` | Claude's model for standard depth (fast uses `haiku`, deep `opus`) |
| `--ceo-codex-model <model>` | your Codex default | Codex's model |
| `--ceo-quota-max <pct>` | `85` | No CEO call or new worker above this usage |
| `--ceo-max-call <usd>` | `2.00` | Cap on a single CEO call, enforced while it runs |
| `--ceo-budget <usd>` | `10.00` | 24-hour cap, for a tool on an API key |
| `--ceo-every <time>` | `30s` | How often the planner checks the plan (minimum `10s`) |
| `--no-notify` | | With `--ceo`: no macOS notification when a plan stops |

What each privacy option hides exactly is in [PRIVACY.md](../PRIVACY.md).

## Other commands

```bash
node bin/towerglow.mjs statusline install    # show Claude Code's quota (backs up settings.json)
node bin/towerglow.mjs statusline uninstall  # put your own status line back
node bin/towerglow.mjs statusline status
node bin/towerglow.mjs watch <session-id> --provider claude|codex --cwd <dir> [--once]
node bin/towerglow.mjs doctor
node bin/towerglow.mjs version
```

`watch` follows a session's transcript in the terminal, read-only. It is what
opens when you ask for the terminal of a session that has none, such as a
CEO's worker; `--once` prints a finished session's whole log and stops.

## Two copies side by side

Two copies of Towerglow must never share a state folder: the first one to
save its city layout would move the other one's towers. Give the second its
own folder and port:

```bash
node bin/towerglow.mjs start --state-dir ~/.towerglow-test --port 7318
```

## Troubleshooting

**`EADDRINUSE`**: something already listens on 7317. Find it with
`lsof -nP -iTCP:7317 -sTCP:LISTEN`, stop it, or use `--port`.

**`command not found: node`**: your shell did not load your Node version
manager. Use the absolute path of `node`.

**The page still shows an old version**: run `npm run build` again, then
reload with the cache bypassed.

**Clicking a session does nothing, or reports error -1743 (macOS)**: the
terminal you started Towerglow from needs permission to control Terminal or
iTerm2: System Settings, Privacy & Security, Automation.

**The city is empty**: Towerglow shows sessions Claude Code and Codex have
recorded. Run `doctor` to see which folders it reads and what it finds there.
