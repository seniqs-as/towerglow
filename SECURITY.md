# Security

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: the
**Security** tab of this repository, then **Report a vulnerability**. Include
what you found, how to reproduce it and what it exposes. We will acknowledge
the report and keep you informed while we fix it.

## What Towerglow protects, and from whom

Towerglow runs as your own user and reads files your own user can already
read. Its job is to keep that data on your machine and in your hands.

**Other machines.** The server listens on `127.0.0.1` only. There is no
option to listen anywhere else.

**Web pages open in your browser.** A page from another site cannot read
Towerglow's data:

- the data travels only over a WebSocket that requires the access token, and
  refuses any browser origin other than Towerglow's own page;
- HTTP requests must name `127.0.0.1` or `localhost` as their host, which
  defeats DNS-rebinding tricks;
- every response carries a strict Content Security Policy, and the page loads
  nothing from the internet.

**Other users on the same machine.** The token lives in `~/.towerglow/token`,
in a folder readable only by you. The page itself and `/healthz` (a few
counters) are served without the token; they contain none of your data.

**What it does not protect against:** software running as your own user. It
can read `~/.claude` and `~/.codex` directly, and `~/.towerglow/token` too.

## Safeguards in the observatory

- **Read-only on your data.** Session data is read through an allow-list,
  default-deny, so a file nobody listed cannot be opened. The contents of
  your project files are never read. Transcripts, the session registry and
  the Codex databases are never written.
- **One door to the page.** Everything the page receives is built field by
  field in one place (`src/server/parse/redact.ts`), with a length cap on
  every string, and every event passes the same check again on its way out.
  If a string ever had to be cut there, `/healthz` reports it.
- **Nothing leaves.** The server opens no outbound connection. The build
  checks that the client bundle contains no way out to the network, and that
  the server's runtime dependencies are exactly one package, `ws`.
- **Commands only on your click.** On macOS, bringing a terminal forward or
  opening a folder runs `ps`, `osascript` or `open`, only when you click,
  with arguments passed as arguments, never pasted into a shell. A Terminal
  window opened to follow a session gets every value quoted and the session
  id validated. `--no-focus` turns all of it off.
- **Writes stay in one folder.** `~/.towerglow`, private to you. The only
  file written outside it is `~/.claude/settings.json`, and only by
  `towerglow statusline install` or `uninstall`: backed up first, written to
  a temporary file, checked, and restored if the result is not valid JSON.
- **Model text is never HTML.** Answers from the CEOs are drawn as text,
  never parsed as HTML; a link stays words and an image its description.
- **Transcripts reach your terminal clean.** `towerglow watch` strips control
  characters from everything it prints, so an escape sequence in a fetched
  page or a command's output cannot drive your terminal.

## The status line bridge

Once installed, Claude Code runs `~/.towerglow/statusline-bridge.sh` every
time it draws the status line, and Towerglow may rewrite that script when its
version changes. Whoever can write into `~/.towerglow` can therefore change
what runs: keep that folder private, as Towerglow creates it.

## With the CEOs

Starting with `--ceo` changes the picture: your own `claude` and `codex`
tools send data, including code, to their providers, and workers you approve
change your repositories and can push. The guards are real:

- no process is started with a permission bypass, and none loads your MCP
  servers;
- the CEOs themselves cannot edit, run commands or use the web, and are never
  handed your home folder to read;
- you see a proposal's full task, and every briefing of a plan, before you
  approve anything;
- every Claude worker runs in the OS sandbox: its shell writes only in the
  project, reaches no network unless push is ticked, and cannot read a fixed
  list of credential folders. Inside that boundary its commands run without
  asking; the git boxes you leave unticked are denied by name, and with
  commit unticked the shell cannot write in the project's `.git`. No worker
  starts where you are working;
- a worker reads the web only in the projects where you ticked web, through
  Claude Code's two web tools, and its shell stays offline;
- of your Claude Code data a worker reads one folder, the notes kept for its
  own project, and writes none: your other sessions' transcripts and the
  other projects' notes are denied;
- a second opinion cannot change anything;
- Reports opens only documents inside the project (`.md`, `.markdown` or
  `.txt`, checked on the file itself after following links), and showing a
  project folder never launches it.

So are the limits. Read [docs/ceo-mode.md](docs/ceo-mode.md) before using it.

## Known limits

- `--redact-paths` replaces names with short unsalted hashes: someone who can
  guess your folder names can confirm them. It hides, it does not encrypt.
- Project ids are unsalted hashes of their paths, for the same reason.
- With the CEOs and push ticked, a worker's `git fetch`, `git pull` and
  `git push` run outside its sandbox and can reach any host.
- A worker's shell runs any command inside its project, so it can delete or
  overwrite files there. The sandbox bounds what a command reaches, not which
  commands run.
- The sandbox stops writes and the network, not reads. A worker's commands
  can read files outside its project, anywhere your user can, except the
  folders listed in [docs/ceo-mode.md](docs/ceo-mode.md#the-sandbox). That
  list is fixed: a credential kept anywhere else, such as a token in
  `~/.npmrc` or a `.env` file of another project, can be read. A worker that
  was manipulated could copy such a file into the project and, with push
  ticked, commit and push it, or with web ticked put it in an address it
  asks for.
- With web ticked, a worker reads pages written by anyone while it may commit
  and push, and every address it asks for is a way out. It is told that a
  page is information and not an instruction; nothing enforces that.
- The token is never rotated on its own. To get a new one, stop Towerglow,
  delete `~/.towerglow/token` and start again.
- Windows is not supported: session discovery does not work there.
