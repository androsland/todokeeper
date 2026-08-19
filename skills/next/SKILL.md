---
name: next
description: Use when asked to work through a deferred-work file — "fix everything in TODOS.md", "clear the backlog", "what should I do next from TODOS.md", "prepare a command to resolve these". Partitions the entries by whether they are actually pending, shows the evidence for each call, and takes ONE ruled item through to a PR. Use before starting any sweep of a TODOS.md, and whenever a deferred-work file has grown past the point where someone will read it end to end.
---

# Working a deferred-work file

**There is no "fix everything" for this file, and the reason is measurable, not
stylistic.** A mature deferred-work file is not a queue. A large fraction of its
entries exist specifically to record that something will **not** be built — so a
command that worked the list top to bottom would implement the things the file
says not to.

Counted by hand on the repo this skill ships in, 2026-08-19, at 43 live entries:

| | count | what it is |
|---|---|---|
| Decided — do not build | 19 | three carrying a bolded prohibition — `**Do not "fix" this by following the link**`, `**Do not turn it into an error**`, `**Do not file a heuristic for it**` — and one already shipped as a named non-goal in the README |
| Ready — fix named, bounded | 6 | "a one-line character-class change", "the fix is one line: …", "widening the file list is trivial" |
| Real work, design owed | 9 | the fix is known in shape but not designed, or is blocked on a caller |
| Measurements, nothing to build | 9 | a stated limit with no remedy owed |

Six of the 43 were ready. **That ratio is the whole design of this skill.** Your
job is not to burn down a list; it is to find the item that is genuinely ready
and take it all the way, without touching the 19 that are load-bearing.

Treat the table as an illustration with a date on it, not a live figure — it was
counted by hand and nothing recounts it. It drifts toward understating the ready
fraction, because decided entries accumulate faster than ready ones are resolved.
Run the partition on the file in front of you; do not carry these numbers to it.

## Step 1 — measure before you read

Run the audit first, always. Never open the file and start forming opinions from
prose — the numbers tell you which file you are in, and they take seconds.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/measure.mjs"   # size, completed mass, live count
node "${CLAUDE_PLUGIN_ROOT}/scripts/stale.mjs"     # entries the repo moved on without
node "${CLAUDE_PLUGIN_ROOT}/scripts/dead.mjs"      # referents that no longer exist
```

All three default to the enclosing git repo; pass `--root <dir>` to audit a
different one.

Read `measure` first. **If completed mass is 0.0%, stop and check stderr** — a
file that parsed to no headings reports exactly that, and every count below it
is then wrong in the same direction. Fix the parse before triaging anything.

`stale` and `dead` are inputs to the partition, not verdicts. A REFERENT MISSING
entry is a strong hint that an entry is finished or obsolete; a SUSPECT entry is
a hint that the code moved. Both are hints. Neither is a disposition.

## Step 2 — partition, and quote your evidence

Read every live entry. Put each in exactly one bucket:

- **DECIDED** — the entry records a choice not to build. Signals: a bolded
  prohibition, "deliberate", "rejected", "permanent", "not built because", "left
  because", "stated as a non-goal in <file>", or a stated revisit condition
  ("revisit if a non-JS repo becomes a primary consumer") that has not occurred.
- **READY** — the fix is named, bounded, and nothing is owed before starting.
  "The fix is one line: X." "Widening the list is trivial."
- **DESIGN OWED** — the problem is real and the remedy is not yet decided, or is
  blocked on something named in the entry ("every caller indexes the returned
  array").
- **OBSERVED** — a measured limit with no remedy owed. Often the most valuable
  entries in the file. They are not work.

**Quote the sentence that put each entry in its bucket.** A partition without
per-entry evidence is unauditable, and this is the step where being wrong is
expensive in one direction only: a DECIDED entry misfiled as READY becomes a PR
implementing something the repo already ruled against.

### Never classify by prose shape, and never automate this step

Do not grep for "deliberate". Do not write a regex over entry text. Do not add a
disposition-detecting rule to any script.

This is not caution, it is a repeated result. The tool this skill ships with has
lost the "infer it from how the text looks" bet twice: once trying to detect a
*hypothetical* referent from an indefinite article and from path structure —
which fired on 8 of 126 missing referents and 5 of 1,138 present ones, and is now
a shipped non-goal — and once reporting git branch names as missing paths because
shape alone said they were paths. A disposition is a fact about intent. It is
carried in the prose but it is not recoverable *from* the prose, and a classifier
that is right most of the time is worse here than one that does not exist,
because it launders a guess into a bucket label somebody then acts on.

The partition is a **proposal with citations**. A human rules on it. That is the
only mechanism in this skill that is sound.

## Step 3 — propose one item, and stop

Present the four buckets with counts, then name **one** READY item and why it is
the one: smallest surface, unblocks others, or a defect rather than an
improvement. Say what you would change and roughly how large the diff is.

Then stop and wait for a ruling. Do not proceed on silence, and do not proceed on
your own partition.

If READY is empty, say so plainly and offer the best DESIGN OWED item as a design
conversation instead. An empty READY bucket on a healthy file is a normal
outcome, not a failure of the sweep.

## Step 4 — take the ruled item all the way

Follow the repo's own conventions rather than any imported by this skill. Read
its `CLAUDE.md`, its `CONTRIBUTING.md`, and the header of the deferred-work file
itself — many carry their own rules about how entries are written and retired.

Whatever the repo's flow is, three things hold:

1. **Update the deferred-work file in the same commit as the work.** An entry
   resolved by a change that does not retire it will be re-triaged next time.
   Move it to the completed section in the repo's own format; do not delete it.
2. **File what the work surfaced,** as new entries, in that same commit. A fix
   that reveals two adjacent problems and records neither has traded one known
   defect for two unknown ones.
3. **Run the repo's tests and its gate**, if it has them, before opening
   anything.

Then stop. Opening the PR is the end of the job; merging is not yours.

## What this skill does NOT do

An unstated limit reads as a claim of coverage, so:

- **It does not fire on a file that is a decision log.** A deferred-work file
  whose entries are all DECIDED and OBSERVED is a healthy, finished artifact —
  several repos keep one deliberately, as the record of what was ruled out and
  why. There is nothing to work. Report the partition and stop; proposing an item
  from such a file manufactures work that the repo explicitly does not want.
- **It cannot see a blocker that lives outside the repo.** An entry waiting on a
  vendor, an upstream release, a decision nobody has made, or a person, reads
  identically to one nobody has got to. Nothing in the file, the git history, or
  the referent verdicts separates "nobody has done this" from "nobody can do this
  yet" — so READY means "nothing *in the entry* blocks it", never "this is
  actionable today". Expect the human ruling to reject items for reasons the
  partition could not have known, and do not argue with those rejections.
- **It cannot tell whether a DECIDED entry is still correctly decided.** An entry
  that says "revisit if a non-JS repo becomes a primary consumer" looks the same
  whether or not that has happened. Surfacing revisit conditions to the human is
  the most this can do; checking them is not automatable and is not attempted.
- **It resolves one item per run, on purpose.** It is not a burn-down and it does
  not track progress across runs. Two invocations of this skill share nothing but
  the file.

## When the file is not like the one above

The partition assumes entries that argue with themselves. Many deferred-work
files are a flat list of terse one-liners — "fix the login redirect", "bump the
node version" — with no dispositions expressed at all.

**Say which case you are in, in your first sentence.** On a terse file nearly
everything lands in READY, the partition adds almost nothing, and the useful
output is different: `stale` and `dead` become the primary signal, because an
entry naming a file that no longer exists is the strongest evidence you have that
a one-line task is already done. Lead with those, not with buckets.

The failure to avoid is running the dense-file procedure over a terse file and
reporting a confident partition built on prose that was never there.
