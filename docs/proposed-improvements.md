# Proposed improvements

Suggestions received from users, what Towerglow does today, and the change
each one would lead to. Nothing on this page is implemented yet.

## 1. Stop when a planned task turns out bigger than planned

Received on 2026-10-14, as a question on the launch post: does CEO mode stop
and ask when a backlog item turns out bigger than planned, or push through?

**What Towerglow does today.** A planned task stops for three reasons, and
its size is not one of them:

- An open decision. The worker's rules (`rules()` in
  `src/server/ceo/planWork.ts`) tell it to stop with `status: "question"`
  when the briefing does not settle a decision it must take, and also not to
  ask about details a careful engineer would just decide. More work than
  expected, with no open decision, is not a reason to stop.
- The time limit: 15, 30 or 60 minutes, from the size the chair gave the task
  (`src/server/ceo/planDesk.ts`). The worker is told its limit. Past it the
  task fails and the queue of its project stops; nothing is retried on its
  own. Since the worker commits as it goes, a task cut this way can leave
  partial work committed.
- The quota. A task that reaches what the user kept free twice in a row stops
  restarting and waits for the user.

So a worker that finds a much larger job than the briefing describes keeps
going until its time limit.

**Proposed change.**

- Add a rule to the worker: if, once it has read the code, the task is
  clearly larger than its size or than the briefing assumes (it will not fit
  in its time limit, or it reaches well beyond what the briefing describes),
  stop early with `status: "question"`, before starting the large change. The
  question says what it found, proposes a split into smaller tasks with a size
  for each, and recommends which part to do first.
- Use the existing `question` status rather than a new one: the pause, the
  panel and the resume in the same session already work for it.
- Later, optionally: when the user accepts a proposed split, add the new tasks
  to the project's queue in the plan instead of only resuming the session.
  This needs changes in `src/server/ceo/plan.ts` and
  `src/server/ceo/planDesk.ts`.
- Cover the new rule in `test/planWork.test.ts`, and add it to the list of
  reasons a task stops in the README (*Plan the work, then let it run*) and in
  [ceo-mode.md](ceo-mode.md).
