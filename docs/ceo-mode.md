# The CEOs

The CEOs are an optional module. They are off unless you start Towerglow with
`--ceo`, and without them Towerglow is a read-only observatory that makes no
network connections (see [PRIVACY.md](../PRIVACY.md)). This page explains
what changes when you turn them on, so you can decide with the facts in hand.

## What they are

Two advisors, one for each tool you use: a Claude CEO and a Codex CEO. They
see what the observatory sees, and they work through four panels:

- **Board**: ask them about your sessions, your projects and your spending,
  or run one of their analyses. They answer, and may propose a piece of work
  for a project, which you accept or reject.
- **Planning**: a meeting with one of them in the chair. You write what you
  want done; the chair reads the code, asks you questions and writes a plan:
  tasks per project, each with a briefing. Once you approve the plan,
  Towerglow runs its tasks, one project at a time.
- **Reports**: every piece of work you accepted, with what the worker did, a
  second opinion on it, and the full log.
- **Effect**: how a project went in the weeks after a job, with the numbers
  before and after, and a judgement you can ask the CEO for.

In the colony they sit at a desk inside the ship (**E** walks you in), and
the workers they start appear on their project's plot like your own sessions.

## How they run

The CEOs need Claude Code 2.1.285 or newer and/or Codex. On Linux the
workers' sandbox needs `bubblewrap` and `socat`; without them a worker does
not start.

Towerglow does not talk to any model itself. It starts your own `claude` and
`codex` command-line tools, which use your existing login and your plan's
quota. Towerglow never stores, shows or sends an API key. The processes it
starts inherit its environment, so if your environment points those tools at
an API key, they use it; Towerglow looks only at whether such a variable is
set, to know which spending guard applies. Which of the two to use, and what
changes with a key, is in [Subscription or API key](#subscription-or-api-key).

`--ceo` also turns on **executive mode**: accepting a proposal, or approving a
plan, starts real work. Start with `--ceo --no-execute` to have the advice
without that: accepting then starts nothing.

## When a model is called

Only when you do something:

| You | Calls |
| --- | --- |
| Ask a CEO a question, or run an analysis | One call to that CEO; asking both is one call each |
| Write a message in the planning meeting | One call, and at most three: a resumed meeting that fails is restarted once, and a turn stopped by the spending cap is allowed one short wrap-up |
| Accept a Board proposal (executive mode) | A worker session in the project, and a second opinion on its work |
| Ask for a judgement in Effect | One call |
| Approve a plan | Its tasks start one by one, each as a worker session |

There is no background analysis and no timer that asks a CEO anything. The
planner that starts the tasks of an approved plan checks every 30 seconds
(`--ceo-every`) and never calls a CEO, but each task it starts is a worker
session that uses your quota. An approved plan stays approved across
restarts: if you start again with `--ceo`, its queued tasks resume. **Pause**
in the planning panel stops them.

## What the model provider sees

Through your CLIs, Anthropic and OpenAI receive:

- **Your question**, and a **brief** built from what the observatory knows:
  live sessions (model, project, status, tokens), projects (name, file count,
  branch), quota, seven days of history per project, the most-touched file
  paths and short notes the CEO keeps about past work. The brief has a size
  cap (2,000 to 9,000 characters depending on depth).
- **Your code.** The Claude CEO can read every project shown in the city (up
  to 24), on every call, and anything it opens is sent. Never your home
  folder itself, nor a folder that contains it: having run `claude` once in
  `~` would otherwise have handed it everything under `~`. The Codex CEO runs in
  Codex's read-only sandbox, which limits what it can change, not what it can
  read. Hiding a project in the city takes it out of the brief and out of the
  folders the Claude CEO is given.
- **In a planning meeting**: your notes, the full text of any files you attach
  (up to 8 files of 64 KiB), and the folder path of each project.
- **Workers** receive their briefing and work on the code directly. A second
  opinion either continues from a copy of the session that worked in the
  project (so that session's context is processed again) or starts a fresh
  read-only session there.

## What each process is allowed to do

No process is started with a permission bypass: no
`--dangerously-skip-permissions`, no `bypassPermissions` mode, no
`danger-full-access` sandbox.

| Process | Edits files | Runs commands | Network |
| --- | --- | --- | --- |
| A CEO answering, the meeting chair, the Effect judge | No. Claude: editing tools denied. Codex: read-only sandbox | No. Claude: shell denied. Codex: read-only sandbox | Claude: web tools denied |
| Worker for an accepted **Board proposal** | Yes, in the project (Claude: `acceptEdits` mode; Codex: workspace-write sandbox) | Claude: only the allow-list below, with commit and push off, inside the OS sandbox; anything else fails at once instead of waiting for an approval. Codex: within its sandbox | None: the sandbox gives the shell no network, and the web tools are denied. Codex: off |
| Worker for a **planned task** | Yes, in the project | Claude: only the allow-list below, with the git boxes you ticked, inside the OS sandbox. Codex: within its sandbox | Claude: none, except `git push` and `git pull` when push is ticked. Codex: on when push is ticked |
| Second opinion | No. Claude: plan mode. Codex: read-only sandbox | No | Not granted by Towerglow |

The allow-list of a worker (for a planned task you can read and edit it in
the planning panel):

- common test runners: `npm test`, `npm run`, `npx`, `node --test`,
  `node --check`, `pytest`, `cargo test`, `go test`, `make test`, `php -l`,
  `composer test`, `phpunit`;
- the project's own commands, proposed by the chair from the repository or
  added by you. Commands that would open everything are refused: shell
  operators, `sudo`, `rm`, `curl`, `ssh`, `git` itself, inline code
  (`node -e`, `python -c`) and the like;
- git: `status`, `diff` and `log` always, since they only read; `pull`,
  `add` and `commit` when commit is ticked; `push` only when push is ticked.
  A worker from a Board proposal never commits or pushes: for Claude the
  commands are denied by name; Codex has no per-command rules, so for its
  worker the prompt says it, and its sandbox has no network to push with.

The list decides what may start, not what it can reach: `npm run` and `npx`
run whatever scripts and packages they are given, and a worker can edit
`package.json` or a `Makefile` before running them. Claude Code also approves
read-only commands such as `ls`, `cat` or `date` on its own. What a command
can reach is the sandbox's to decide.

### The sandbox

Every Claude worker runs in Claude Code's OS sandbox (Seatbelt on macOS,
bubblewrap on Linux), which Towerglow turns on for each one:

- shell commands, and everything they start, write only inside the project
  and the temporary folder, and reach no host on the network;
- they cannot read credential folders (`~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/.config/gh`, `~/.netrc`, `~/.docker`, `~/.kube`), nor Towerglow's,
  Codex's or your other sessions' data. The Read tool, which lives outside
  the sandbox, is denied the same paths, and the web tools are denied;
- the model cannot ask to run a command outside the sandbox, and a
  repository's own Claude settings cannot open exceptions;
- if the sandbox cannot start, the worker does not start, rather than running
  without it.

With push ticked, `git push` and `git pull` run outside the sandbox: they need
your SSH keys and the network. So a worker manipulated into editing
`package.json` and running it can change the project, but cannot leave it or
reach the network, unless you ticked push and it uses `git` to do so.

This was checked with the real `claude`, not only in tests: inside the
sandbox a request to the network failed, a write to the home folder failed, a
write in the project succeeded, reading `~/.ssh` failed, an interpreter not on
the list was refused, and with push ticked a `git push` went through.

No MCP server of yours is loaded in the CEOs, the second opinions or the
workers: they run outside the sandbox.

## What happens to your repositories

- **Commit and push are ticked by default**, for each project in a plan. The
  push goes to the branch the repository is on, not necessarily `main`.
  Untick push, or commit, in the planning panel before you approve; the boxes
  cannot change while a task runs. A project without git never commits or
  pushes. Keeping to that branch is an instruction in the worker's prompt:
  the permission it gets allows `git push`.
- **You see everything before you say yes.** A proposal's card shows the
  project its worker would run in and the full task it would be told; accept
  stays off until the task is on screen. In Planning, each task still to
  start shows its briefing in full.
- **One worker per project** at a time.
- **Workers wait for you**: none starts in a project where you have a
  session that is working, waiting for an answer, or was active in the last
  5 minutes. A planned task waits its turn; accepting a proposal there tells
  you why its worker cannot start yet.
- **A failed task stops its project's queue.** There are no automatic
  retries: you retry or skip it from the panel.
- **A worker that needs something stops and asks.** A question becomes a
  card in the panel, and your answer resumes the same session. A command it
  was refused is listed, and "allow and resume" adds it to the project's
  commands.
- **Your own sessions are never written into.** A second opinion works on a
  copy of a session, never on the session itself.

## Limits on spending

| Guard | Default | What it does |
| --- | --- | --- |
| `--ceo-quota-max` | 85% | No CEO call and no new worker while any usage window is at or above it |
| Reserve | 30% of the 5-hour window, 20% of the 7-day one | A planned task starts only if its expected cost leaves the reserve free. While tasks run, a window reaching the reserve stops them and pauses the plan. Work from Board proposals and second opinions does not start past the reserve either, and is stopped on it. Set in the planning panel |
| `--ceo-max-call` | $2 | Stops a CEO, chair or judge call while it runs, once its estimated cost passes the cap |
| `--ceo-budget` | $10 per 24 hours | The cap for a tool on an API key, in place of the quota ceiling and the reserve. For a tool on its plan it is ignored once Towerglow has read that plan's usage windows |
| Parallel workers | 2 (up to 4) | How many planned tasks run at once, on different projects |
| Time | | A CEO call stops after 3 minutes of silence or 10 minutes in all; a worker after 5 minutes of silence, or 15 to 60 minutes depending on the task's size (20 for proposal workers and second opinions) |

Workers and second opinions have no per-call cost cap: they are full
sessions, and the reserve is what stops them.

Costs are shown as a share of your plan's usage windows, not in dollars, since
a subscription does not bill by the token.

## Subscription or API key

Both work, and Towerglow does not choose. Every process it starts is your own
`claude -p` or `codex exec`, started with Towerglow's environment, and it uses
the credential that tool would use in your terminal:

- **Claude Code** uses an `ANTHROPIC_API_KEY` from the environment whenever
  there is one, ahead of your plan's login; without it, the login.
- **Codex** uses a `CODEX_API_KEY` from the environment, or the key you gave
  `codex login --with-api-key`; without them, your ChatGPT login.

To run the CEOs on a key and keep your own terminals on your plan, set the
key only in the shell you start Towerglow from. It then pays for everything
Towerglow starts: the CEOs' answers, the meeting, the workers and the second
opinions. There is no setting for the workers alone.

The credential also decides which of the vendor's terms and data policies
cover what the CEOs send: the plan's with a login, the API's with a key.

This was checked in the code and against the two tools' documentation. It
was not run end to end on an API key.

### Which one for planned work

We suggest an API key for the tasks of an approved plan. A question to a
CEO, a turn of the meeting, a proposal you accept: each is one thing you
did, answered once. An approved plan is different: its tasks start one after
another, for hours, with nobody at the keyboard. Both vendors point that
kind of use at API keys, without forbidding it on a plan:

- **Anthropic.** `claude -p` on a plan is supported: "When you're signed in
  with your Claude plan [...], `claude -p` and Agent SDK usage still draw
  from your plan's usage limits"
  ([Help Center](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans)).
  But plan login "is designed to support ordinary use of Claude Code and
  other native Anthropic applications", and "Advertised usage limits for Pro
  and Max plans assume ordinary, individual usage of Claude Code and the
  Agent SDK"
  ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
  The [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), which
  cover Free, Pro and Max, do not allow access "through automated or
  non-human means, whether through a bot, script, or otherwise", except with
  an API key "or where we otherwise explicitly permit it".
- **OpenAI.** `codex exec` "reuses saved CLI authentication by default", so
  it runs on a ChatGPT login
  ([Non-interactive mode](https://developers.openai.com/codex/noninteractive)).
  For automation the same documentation says: "Use API key authentication
  for programmatic Codex CLI workflows, such as CI/CD jobs", and "API keys
  are still the recommended default for automation"
  ([Authentication](https://developers.openai.com/codex/auth)).

Neither page says where a queue of unattended workers stops being ordinary
use. That is the vendor's call, and Anthropic "reserves the right to take
measures to enforce these restrictions and may do so without prior notice".
This is how we read those pages on 12 October 2026. It is not legal advice,
and terms change: read them for your own case and your own plan.

### What changes with a key

The guards above were built around a plan's usage windows, and work billed
by the token moves none. When it starts with `--ceo`, Towerglow looks at its
own environment, the one its processes inherit, and treats a tool as billed
by the token when one of these is set:

- for Claude Code: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or one of the
  switches `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
  `CLAUDE_CODE_USE_FOUNDRY`;
- for Codex: `CODEX_API_KEY`.

`start` then says which guard holds:

```
  billing:   claude by the token (ANTHROPIC_API_KEY is set): no quota gates, capped at 10.00 USD per 24h
```

For that tool, know this before you set a key:

- **No quota ceiling and no reserve.** A plan's windows are moved by your own
  terminals, never by keyed work, so Towerglow does not gate on them, even
  with your terminals on a plan and its bars on screen. `--ceo-budget` takes
  their place: no CEO call and no worker starts once the last 24 hours have
  cost that much, or leave less room than `--ceo-max-call`.
- **The budget stops the next start, not the work in flight.** A worker that
  is running is stopped only by its time limit, and one worker can cost more
  than the whole budget: three planned workers were once measured at $107 of
  list price in seventeen minutes.
- **Codex work is not counted.** The budget adds up the cost each tool
  declares when a call ends. Claude Code declares one; `codex exec` does not,
  so on a Codex key only the time limits apply.
- **Planned tasks of that tool run one at a time.** The planner prices a task
  in points of a usage window before running several together. Without a
  window the price stays unknown, and a task of unknown cost runs alone.
- **A key Towerglow cannot see is not known to it.** One set outside its
  environment (an `apiKeyHelper` or the `env` block in Claude Code's
  settings, `codex login --with-api-key`) leaves the tool treated as on its
  plan. `--ceo-budget` then holds only while no usage window is on record for
  that tool: one left from when you were on a plan, even expired, switches it
  off. Set the key in the shell you start Towerglow from, and check the
  `billing:` line.

So on a key, set a spending limit on the key itself, in the vendor's
console. It is the one cap that does not depend on what Towerglow can see.
The dollar figures Towerglow labels `list` are then Claude Code's own
estimate of what you are billed, not a comparison.

## What is stored

Under `~/.towerglow/ceo/`, readable only by you:

- `plan.json`: the meeting (your notes and the full text of attachments, the
  minutes, questions and answers), the plan, its tasks and their git rules;
- `jobs.json`: the last 50 jobs, with what the worker and the second opinion
  wrote (up to 20,000 characters each), cost and the documents written;
- `proposals.json`, `memory.json` (up to 24 one-line notes per CEO about past
  work), `spend.json` (the last 24 hours of calls);
- `archive/` and `plans/`: what "start over" cleared;
- `claude/` and `codex/`: the CEOs' working folders.

The CLIs also keep their own transcripts of every CEO conversation and worker
session, as they do for yours. Towerglow keeps its own folder out of the city.

On macOS, when a plan stops and needs you, a desktop notification names the
project. `--no-notify` turns it off.

## Before you turn it on

1. **Commit or stash your work**, and consider letting workers run on a
   branch: the push goes to whatever branch the repository is on.
2. **Start with `--ceo --no-execute`.** You get the analyses, the proposals
   and the planning meeting, and nothing is ever started.
3. **Untick push** in the planning panel wherever you want to review before
   anything leaves your machine.
4. **Read the briefings and the allowed commands** of each project in the
   planning panel, and the full task on a proposal's card.
5. **Keep the reserve** at a level that leaves room for your own work. On an
   API key there is no reserve: set a spending limit on the key instead.
6. **Hide the projects** you do not want the CEOs to read.
7. **Read Reports** after each job: the worker's account, the second opinion
   and the full log are there.

## Known limits

Said plainly, so that nothing comes as a surprise:

- The reserve is checked before work starts and on every new usage reading,
  so a worker can cross the line by what it spends between two readings
  before it is stopped.
- With push ticked, `git push` and `git pull` run outside the sandbox, and can
  reach any host a worker points them at.
- Claude's file tools are outside the OS sandbox: they edit inside the project
  on their own (`acceptEdits`), and outside it only where Claude Code itself
  allows, such as its own memory folder for the project.
- Codex workers have Codex's own sandbox instead (writes in the project,
  network only when push is ticked), with no per-command list: "no commit"
  is an instruction in their prompt.
- One planning message can cost up to three calls.
- On an API key the reserve and the quota ceiling do not exist, `--ceo-budget`
  does not stop a worker that is running and does not count Codex work, and
  Towerglow knows a tool is on a key only from its own environment. See
  [What changes with a key](#what-changes-with-a-key).
