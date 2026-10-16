# Privacy

What Towerglow reads, what it shows, what it stores and what it sends. The
first part is the observatory, which is all there is unless you start with
`--ceo`. The CEOs change the picture, and the last section says how.

## The short version

Towerglow runs entirely on your machine. It reads the records that Claude
Code and Codex already keep on your disk, turns them into metadata (who is
working where, with which tools, at what cost), and shows them in a page that
only your own machine can open. It makes no network connection of its own,
has no telemetry and checks for no updates.

## What it reads

Every read of session data goes through an allow-list
(`src/server/paths.ts`): a file that is not on the list cannot be opened by
the code that reads sessions.

**Claude Code** (`~/.claude`, or `--claude-dir`):

- `sessions/<pid>.json`: the registry of live sessions (id, folder, status).
- `projects/<folder>/<session>.jsonl`: the transcripts. Each line is parsed in
  memory, and only this is kept: the names of the tools called and their
  target (a file path, the first word of a shell command), the model, token
  counts, the length of your prompts (never their text), the session title
  Claude Code generates, its "while you were away" summary, durations and
  cost figures, when the conversation was compacted, and when a turn was
  refused at a usage limit (the time, and the reset the refusal declares as
  a number; its wording is not read). The text of Claude's replies and of its
  thinking is never extracted.
- `~/.claude.json`: the list of your projects, and the name of your plan
  (for example "max 5x"), nothing else.
- Nothing else in `~/.claude` is on the allow-list. Separately, `settings.json`
  is read to know whether the optional status line bridge is installed.

**Codex** (`~/.codex`, or `--codex-dir`):

- `sessions/.../rollout-*.jsonl`: the session logs. Kept: model, token usage,
  rate limits, context and when it was compacted (only the time: the
  compaction record holds the conversation and is never parsed), turn start
  and end, whether a turn was refused at the usage limit (its error code,
  never its message), the binary name of commands, the
  paths and line counts of file changes, and the **first line of your last
  prompt**, which Codex sessions use as their title.
- `session_index.jsonl`: thread names. `config.toml`: only the project paths.
  `logs_2.sqlite`: opened read-only, for the process id of each session.
- `auth.json` and `history.jsonl` are explicitly refused.

**Your projects:**

- `.git/HEAD` and the end of `.git/logs/HEAD` (the reflog): the branch, and
  the subject of each commit, checkout or reset. Author names and emails are
  dropped. Git itself is never run.
- The names of the files and folders in each project, to size its tower and
  to say on its card how many there are: at most 20,000 files and 10 levels
  deep, skipping hidden folders, `node_modules` and build folders, never
  following symlinks. **The contents of your files are never read.**

## What reaches the page

The page is served on `127.0.0.1` and needs the access token: nothing leaves
your machine. What the server sends to it, built field by field in a single
place (`src/server/parse/redact.ts`) with a length cap on every string:

- projects: name, file and folder count, branch, last commit subject (the
  folder path stays in the server);
- sessions: label, title, the "while you were away" summary, status, model,
  token counts, context used and when it was last compacted, when it stopped
  at a usage limit and when that limit resets, durations, the tool in use and
  its target;
- for each tool call: the tool's name and target, as above; for a shell
  command, only its first word;
- usage: token counts, and your quota windows when they are known.

Flags to show less:

| Flag | What it hides |
| --- | --- |
| `--redact-paths` | Project names, session labels and file paths are replaced by short hashes inside the server. Also turns off the summary. It is pseudonymisation, not encryption, and it does not hide titles, commit subjects, branch names or tool names |
| `--no-titles` | Session titles, including the first line of your Codex prompts |
| `--no-recap` | The "while you were away" summary |
| `--no-commit-text` | Commit subjects (hash, branch and time remain) |
| `--no-cmd-names` | The first word of shell commands |
| `--exclude <text>` | Projects whose path contains the text: not listed, not followed |

## What it stores

Everything goes in `~/.towerglow` (or `--state-dir`). Folders are created
readable only by you (`0700`), files likewise (`0600`).

| File | What it holds |
| --- | --- |
| `token` | The access token of the page |
| `layout.json` | Which plot of the city each project has |
| `prefs.json` | Names you gave projects, and the ones you hid |
| `history.json` | One row of numbers per finished session (ids, tokens, durations, cost; no text). Rows are kept 30 days, then folded into monthly totals kept 12 months |
| `statusline/` | Only if you installed the status line bridge: see below |

It never writes into your transcripts, the session registry or the Codex
databases.

## The status line bridge (optional)

Claude Code passes your usage limits only to its status line command. If you
run `towerglow statusline install`:

- `~/.claude/settings.json` is backed up to `~/.towerglow/backups/`, and its
  `statusLine` entry is pointed at `~/.towerglow/statusline-bridge.sh`;
- your previous status line command keeps running inside the bridge, and its
  output is what you see;
- the bridge saves the JSON Claude Code hands it (it includes the folder,
  session id, model and cost) under `~/.towerglow/statusline/`, and Towerglow
  reads only the usage windows and the context percentage from it.

`towerglow statusline uninstall` puts your previous `statusLine` back and
removes the bridge; if your status line is no longer the bridge, it leaves
`settings.json` alone. Nothing is installed unless you run the command.

## What it runs

Nothing in the background. On macOS, and only when you click in the page,
Towerglow may run `ps` to find a session's terminal, `osascript` to bring that
terminal forward or open a new Terminal window, and `open` to show a project
folder. A session without a terminal of its own opens in a window running
`towerglow watch`, which prints its transcript and only reads it. macOS asks
for your permission the first time. `--no-focus` turns all of this off.

## What it sends

Nothing. The server makes no outbound connection, and the page connects only
back to the server that served it. A check in the build (`npm run
check:bundle`) fails if the client bundle contains a way out to the network.

## With the CEOs

Starting with `--ceo` adds two advisors that run through your own `claude`
and `codex` command-line tools. Those tools send data to Anthropic and
OpenAI, under the terms you accepted when you started using them:

- what you ask, and a brief built from the metadata above (sessions, projects,
  quota, history, the most-touched file paths);
- the code of your projects, which the advisors can read, and that workers
  work on directly;
- in a planning meeting, your notes and any files you attach, in full;
- the notes Claude Code keeps for a project (its memory folder), when a worker
  of that project opens them;
- for a project where you ticked web: what its worker searches for and the
  pages it reads. The sites it opens receive the request from your machine;
- whatever else a worker reads. Its commands cannot read the folders listed
  in [docs/ceo-mode.md](docs/ceo-mode.md#the-sandbox) (the usual credential
  folders, your other sessions), but they can read other files your user can
  read.

To write a worker's rules, Towerglow lists the names of the folders in
`~/.claude/projects` and looks whether the project has a notes folder. It
opens no file there.

Towerglow itself handles no credential. With `--ceo` it checks whether an
API-key variable is set in its environment, to choose which spending guard
applies, and never stores, shows or sends its value.

They also store their plans, decisions and the outcome of each job under
`~/.towerglow/ceo/`, and the CLIs keep their own transcripts as usual. The
full picture, including what each process may do, is in
[docs/ceo-mode.md](docs/ceo-mode.md).
