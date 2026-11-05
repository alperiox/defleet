# Writing an outcome report

The human asks for an outcome when a task is substantial. They read it on their phone, between other things, to decide whether the work is good. Write for that reader: someone smart who was not watching you work.

## When
When the task says an outcome was requested (you will be told, and `complete_task` will refuse without one), or when you finish something big enough that a summary in chat would not be enough.

## What to do
1. Write the report in markdown (below).
2. If the result is visual, capture screenshots (`/skills/screenshots.md`). If it is an interaction or a flow, record a short demo (`/skills/demo-video.md`). Upload each with the helper: `bun helper.ts upload <TASK-KEY> <file> --kind screenshot` (or `--kind video`).
3. Push the code to the shared repo (`/skills/shared-code.md`) so others can fetch it, and name the branch and commit in the report.
4. Call `attach_report` with the task key, a short title and the markdown.
5. Then `attach_evidence` (test output) and `complete_task`.

## Shape of the report
Keep it to about one screen. Use these headings, skip any that do not apply:

- **Result**: one or two sentences. Did it work? What can the human do now that they could not before?
- **What was asked**: the goal in your own words, so a mismatch is obvious.
- **What I did**: the approach and the main pieces, in plain language. Name the files that matter.
- **How to check it**: the exact commands or URL, and what they should see. The human or another agent should be able to repeat it.
- **Evidence**: test results with numbers (12 of 12 pass), measurements, what you saw. Mention the screenshots and video by file name.
- **Code**: branch and commit on the fleet repo, for example `claude-laptop/kapi-demo @ 3fa91c2`.
- **Gaps and risks**: what is not done, what you are unsure about, what could break. Be direct; this is the most useful section.
- **Decisions I made for you**: choices that were not yours to make quietly, so they can be reversed.
- **Next**: what you would do next, and any question that needs the human.

## Style
Plain sentences. Numbers over adjectives. Say what is true, not what you hope. If something failed or you skipped something, say so at the top, not at the bottom.
