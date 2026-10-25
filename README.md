# Towerglow

<p align="center">
  <img src="src/client/assets/towerglow_image.png" width="480" alt="Towerglow: towers on a dark grid with their windows lit, one glowing amber with two rings around it, and an astronaut at its foot">
</p>

Towerglow draws your Claude Code and Codex sessions as a living 3D city, in a
browser tab on your own machine. Every project you work in is a tower; its
windows light up while agents read, edit and run commands in it, and every
commit rings around it. A second view, the colony, shows the same data as a
small space colony with an astronaut for each session.

It works by reading the files the two command-line tools already leave on
your disk. Out of the box it is an observatory and nothing more: it makes no
network connections, calls no model, and writes nothing outside its own
folder.

Turn on its optional CEOs and it also runs your backlog: you plan the work
for all your projects in one meeting, answer the questions up front, and
Towerglow works through the list on its own, in the order you set, while
keeping part of your quota free for you. See
[Plan the work, then let it run](#plan-the-work-then-let-it-run).

Towerglow is an independent project, not affiliated with Anthropic or OpenAI.

Towerglow in two and a half minutes, on a set of made-up projects. It is
narrated, and GitHub starts it muted:

https://github.com/user-attachments/assets/5b28bb8e-ae2e-4452-b99b-ac9f0f0b80eb

## Two modes

Towerglow starts as a read-only observatory. An optional module, the CEOs,
adds two AI advisors that can also start work in your projects. It is off
unless you start with `--ceo`.

| | Observatory (default) | With the CEOs (`--ceo`) |
| --- | --- | --- |
| Network | None. The server listens on `127.0.0.1` only | Your own `claude` and `codex` CLIs talk to Anthropic and OpenAI, as they do when you use them. Workers reach your git remote where you tick push, and the web where you tick web |
| Model calls | Never | When you ask something, and the workers you approve |
| Your projects | Never written. File contents are never read | The CEOs can read your code; workers you approve edit it, commit and push |
| Your plan's quota, or API credit | Untouched | Used, within limits you set |

What the observatory reads, shows and stores is in [PRIVACY.md](PRIVACY.md).
What turning on the CEOs implies, and how to keep it under control, is in
[docs/ceo-mode.md](docs/ceo-mode.md). Read that page before using `--ceo`.

## Plan the work, then let it run

This is the most useful thing the CEOs do. An agent you start on a task
usually stops at the first open question and waits for you. Here the
questions are asked first, all together, and the work runs afterwards without
you.

1. **Hold a planning meeting.** Start with `--ceo`, open **Planning** and
   write, in your own words, what you want done in each project and which
   project comes before which. There is no form to fill in, and you can
   attach your to-do files. One of the CEOs chairs the meeting.
2. **Answer its questions.** The chair reads the code of each project and
   asks what a session would otherwise stop to ask: the scope, what "done"
   means, your conventions, what not to touch, how to check the result. Then
   it writes a briefing for each task, meant to carry everything a worker
   needs to finish without asking.
3. **Check the order and set what to keep free.** The plan lists the tasks
   of each project and ranks the projects from what you wrote; you can still
   move one up or down. You choose how much of your plan's 5-hour and 7-day
   usage to keep for yourself: 30% and 20% unless you change it. An API key
   has no usage windows: the cap there is an amount in dollars per 24 hours,
   `--ceo-budget`, set when you start.
4. **Approve.** You read every briefing first, and decide for each project
   whether its worker may commit, push and read the web (the web is off until
   you tick it). For each task you can change the tool, the model and the
   effort: how hard the model thinks, which is the tool's own default until
   you raise or lower it. Nothing starts before your yes.
5. **It runs.** Towerglow starts the tasks itself, in your order: one worker
   per project, up to two projects at a time (you can set one to four), the
   next task as soon as one ends. It paces itself on your quota: a task that
   would eat into what you kept free waits, and starts when the usage window
   has room again. Leave Towerglow running, and your machine awake, and the
   queue keeps going through the night.

It stops for you only where it has to:

- A worker that still has a question stops and asks it in the panel. Only its
  project waits, the others go on, and your answer resumes the same session.
- A task that fails, or runs past its time limit (15 to 60 minutes, by its
  size), stops the queue of its project. Nothing is retried on its own. The
  worker is told its limit, and to run only the part of a long test suite
  that covers its change, saying what it left out.
- A task that reaches what you kept free while it runs is stopped, waits for
  the usage window to have room, and starts again on its own in the same
  session. If that happens to the same task twice in a row, it stops
  restarting and waits for you: it does not fit in a window as planned.
- No worker starts in a project where you are working yourself.

On macOS a desktop notification tells you when the plan needs you, and
**Reports** keeps what each worker did, with its full log. This is real work
on your repositories, paid with your quota or your API credit: the rest is in
[The CEOs in short](#the-ceos-in-short).

## Board, Reports and Outcomes

Planning is one of four panels the CEOs bring. The other three follow a piece
of work through three moments: deciding it, reading how it went, and seeing
what it changed.

**Board: ask, and decide.** Ask either CEO a question in your own words
("where am I wasting tokens?"), or run one of five ready analyses: session
report, development trend, token waste, structural improvements, quota and
spend. You choose how deep it goes: *fast* answers in a few lines, *standard*
is the normal report, *deep* also opens your code. A CEO answers only when
you ask, and each answer shows what it cost. An answer may end with up to
four **proposals**, each a piece of work for one project. The card shows the
project and the whole task a worker would be told, and you accept or reject
it. Accepting starts a worker in that project, which edits the code without
committing or pushing it, and then a second opinion on what it did. With
`--no-execute` accepting starts nothing.

**Reports: how each job went.** Every piece of work you accepted is here,
from a proposal or from a plan: what was asked, the worker's one line on what
it did, how long it took, its tool calls and its cost.

- *read the outcome* opens the worker's full account.
- *agent's feedback* is the second opinion. The session that normally works
  in that project is continued from a copy and asked for objections, not for
  approval; the row says at a glance whether it agrees or **objected**. If
  there was no session to continue, a fresh one checks the premises against
  the repository instead, and the row says so (*premise check*). A proposal
  always gets a second opinion; for the tasks of a plan it is a box to tick
  in Planning, and it doubles the cost.
- *session log* opens a terminal window with everything the session did, and
  *open* shows each document the worker wrote. Both are for macOS.
- *delete* erases that job for good, after a second click. A job still
  running cannot be deleted. *start over* erases every finished job at once
  (a copy goes to `~/.towerglow/ceo/archive/`).

**Outcomes: what it changed.** A job that got done and a job that helped are
two different facts. For each job this panel compares your sessions in that
project in the 14 days before and the 14 days after, on five figures: cost
per session, weighted tokens per line, cache read, output share and tool
calls per turn. It is careful about what it claims: a figure appears only
with at least three sessions on each side (until then it says how many are
missing), and a change under 15% is not called better or worse. You can then
*ask the CEO what else could explain this*: it is asked to find another
cause for the change, not to take the credit, and the answer says whether it
could. *delete* erases one outcome and *delete all* every outcome, each after
a second click; the jobs stay in Reports and an erased outcome is not measured
again.

## Quick start

You need macOS or Linux, [Node.js](https://nodejs.org) 22.18 or newer, and
Claude Code and/or Codex installed and used at least once: Towerglow shows
the sessions they record.

```bash
git clone https://github.com/seniqs-as/towerglow.git
cd towerglow
npm install
npm run build
node bin/towerglow.mjs start
```

`start` prints the address to open, with an access token in it:

```
  TOWERGLOW
  open:      http://127.0.0.1:7317/?t=...
```

The token is created on the first start, kept in `~/.towerglow/token`, and
stays the same across restarts. It keeps other programs on your machine from
reading the page's data. To open the page without copying it:

```bash
open "http://127.0.0.1:7317/?t=$(cat ~/.towerglow/token)"      # macOS
xdg-open "http://127.0.0.1:7317/?t=$(cat ~/.towerglow/token)"  # Linux
```

Stopping, restarting, running in the background and every option are in
[docs/running.md](docs/running.md).

## What you see

The page opens on the **city**: one tower per project, windows lit by the
work, a light scene that runs anywhere. **V** (or the button beside Settings)
switches to the **colony**, the full 3D view with many more polygons, and
back.

![The city view: wireframe towers on a dark grid, two of them lit amber with a status badge above the project name, and the quota bars at the top right](src/client/assets/towerglow_screenshot.png)

Keys in the page: drag to move, scroll to zoom at the cursor, **C** frames the
whole map. In the colony, **H** frames the ship, **P** cycles the planet, **T**
the time of day and **O** orbits. With the CEOs, **E** walks you up the ramp
into the ship, where the CEOs sit at their desk: walk up to it (WASD or the
arrows) and the planning panel opens; **E** or the hatch takes you back out.

The legend button explains every colour and sign of the view on screen; the
settings button holds the tower spacing, the quality presets, the planet and
the sky. A red cross on a session's badge means it stopped at its usage limit
and is waiting for you: a session refused at the limit is not started again
when the limit resets. The cross stays until the session goes on, and its
hover says when the limit resets. The info button on a tower's name, or on
the badge of a session working there, opens its card: how tall the tower is
and what that counts, and what the project took, in total and month by
month: the tokens, the hours the agents worked and your own, estimated from
when you send messages and never counted in two projects at once, and which
models and efforts the agents' hours ran on. How the hours are counted, and
what they miss, is in
[PRIVACY.md](PRIVACY.md#a-projects-hours). On macOS, clicking a session brings its
terminal window to the front; a worker of the CEOs has no window of its own,
so the click opens one that follows what it is doing, read-only.

## Privacy in short

- **It reads** the session records and transcripts of Claude Code
  (`~/.claude`) and Codex (`~/.codex`), the branch and reflog of your
  projects' git repositories, and the names of the files and folders in your
  projects, to size the towers. It never reads the contents of your project
  files, nor the text of Claude's replies.
- **It shows**, in a page served only to your own machine, metadata: project
  names, session titles, which tools run on which files, token counts, commit
  subjects. Flags like `--redact-paths`, `--no-titles` and
  `--no-commit-text` hide more.
- **It writes** only `~/.towerglow`. It changes `~/.claude/settings.json`
  only if you run `towerglow statusline install`, and puts it back with
  `towerglow statusline uninstall`.
- **It sends** nothing. No telemetry, no update checks, no fonts or scripts
  from the internet.

Details, and the exact list of what reaches the page, in
[PRIVACY.md](PRIVACY.md).

## Quota bars (optional)

Claude Code hands your 5-hour and 7-day usage to its status line command and
writes it nowhere else. To show it, Towerglow can sit in front of your status
line:

```bash
node bin/towerglow.mjs statusline install    # backs up settings.json first
node bin/towerglow.mjs statusline uninstall  # puts your status line back
```

Your own status line keeps running inside the bridge, and what it prints is
still what you see. Codex's usage comes from its own files and needs nothing.

## The CEOs in short

With `--ceo`, two advisors join the city, one for each tool: you can ask
them about your sessions and spending (the **Board**), plan work with them in
a meeting (**Planning**), read how the accepted work went (**Reports**) and
what it changed afterwards (**Outcomes**). The panels are described in
[Board, Reports and Outcomes](#board-reports-and-outcomes).

They run through your own `claude` and `codex` command-line tools, on
whatever those are signed in with: a subscription or an API key (see
[Subscription or API key](#subscription-or-api-key)). Towerglow itself never
stores or sends a credential. A model is called only when you ask something,
or to run work you approved. What you should know first:

- **The model provider sees your code.** The CEOs can read the projects in
  the city, and workers work on them directly.
- **Accepted work changes your repositories.** By default a worker commits
  and pushes to the branch the repository is on. You can untick both, per
  project, before approving a plan, and you see everything a worker will be
  told before you say yes.
- **Workers are sandboxed.** Each Claude worker runs in Claude Code's OS
  sandbox: its commands write only in the project, cannot read a fixed list
  of credential folders (`~/.ssh`, `~/.aws` and the like) and reach no
  network, except `git fetch`, `git pull` and `git push` when push is ticked.
  Inside the project they run without asking, and can change or delete files
  there. A worker reads the web only where you ticked web for its project.
- **The sandbox stops writes and the network, not reads.** A worker's
  commands can read other files on your disk, including a credential kept
  outside those folders, such as a token in `~/.npmrc` or a `.env` file of
  another project.
- **It uses your quota.** A reserve, a cap on each CEO call and a quota
  ceiling keep it in bounds, but workers are real sessions and cost what a
  session costs. On an API key it spends money instead, behind fewer guards.

The CEOs need Claude Code 2.1.285 or newer and/or Codex; on Linux the
workers' sandbox also needs `bubblewrap` and `socat`. To try them as advisors
only, with nothing ever started:

```bash
node bin/towerglow.mjs start --ceo --no-execute
```

Everything else, including what each process is allowed to do, is in
[docs/ceo-mode.md](docs/ceo-mode.md).

### Subscription or API key

The observatory needs neither: it calls no model, and shows your sessions
however they are paid for.

The CEOs work with both. Towerglow starts your own `claude` and `codex` and
hands them its environment, so they use what they would use in your
terminal: your plan's login, or an API key when one is set
(`ANTHROPIC_API_KEY` for Claude Code, `CODEX_API_KEY` for Codex). A key pays
for everything Towerglow starts, the CEOs' answers as much as the workers:
there is no setting for the workers alone. Towerglow sees that the variable
is set, says so when it starts, and caps that tool in dollars instead of by
your plan's quota.

**For the tasks of an approved plan, we suggest an API key.** Asking a CEO a
question is you using the tool. A plan's tasks start one after another with
nobody at the keyboard, which is closer to automation, and both vendors
point automation at API keys:

- **Anthropic** lets `claude -p` run on a plan and counts it against the
  plan's limits, but describes plan login as "designed to support ordinary
  use of Claude Code", with limits that "assume ordinary, individual usage".
  Its Consumer Terms allow automated access only with an API key, or where
  Anthropic explicitly permits it. See
  [Claude Code: legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
  and the [Consumer Terms](https://www.anthropic.com/legal/consumer-terms).
- **OpenAI** lets `codex exec` run on a ChatGPT login, and its documentation
  says that "API keys are still the recommended default for automation". See
  [Codex: authentication](https://developers.openai.com/codex/auth).

Neither page says where a queue of unattended workers stops being ordinary
use: that is the vendor's call, not ours. This is how we read those pages on
12 October 2026, not legal advice, and terms change, so read them for your
own case. An API key also bills by the token, and the spending guards are
fewer on one: read
[Subscription or API key](docs/ceo-mode.md#subscription-or-api-key) before
you set it.

## Development

```bash
npm test               # node --test
npm run typecheck      # server and client
npm run check:deps     # the runtime dependency tree must be exactly {ws}
npm run check:bundle   # the client bundle must contain no way out to the network
npm run check:passive  # the server must build without src/server/ceo/
npm run probe:worker   # a worker's rules, tried on the real claude (calls the model: a few cents)
```

The server is Node with a single runtime dependency, `ws`; the client is
three.js, bundled with Vite. The CEO module lives entirely in
`src/server/ceo/` plus four panels in `src/client/ui/` and the probe in
`scripts/`, and the observatory builds and runs without it.

## Security

How Towerglow protects your data, and its known limits, are in
[SECURITY.md](SECURITY.md), together with how to report a vulnerability.

## Credits and licence

Towerglow is released under the [MIT licence](LICENSE), copyright Seniqs AS.

The colony scene comes from
**[Bot Crossing](https://github.com/Station-Sciences/bot-crossing)** by
Jarren Rocks (MIT). Three of the four 3D models are built from CC0 asset packs
by **[Kay Lousberg](https://kaylousberg.com)** and are not covered by the MIT
licence: see [src/client/assets/CREDITS.md](src/client/assets/CREDITS.md).
Full notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
