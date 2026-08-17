---
name: todokeeper
description: Use when a repo's deferred-work file (TODOS.md, BACKLOG.md, todos/) needs auditing, splitting, archiving, or a staleness sweep — measures it, finds entries the codebase has moved on without, finds referents that no longer exist, and separates finished work from live work. Use before archiving or restructuring one, and when asked whether a TODO file is stale, too big, or still true.
---

# Todokeeper

A deferred-work file fails in four ways, and only one of them is visible by
looking at it:

1. It grows until nobody reads it. **Visible** — the file is long.
2. It fills with finished work that reads as pending. Invisible.
3. Entries stay open after the code they describe changed underneath them. Invisible.
4. Entries name files, symbols and flags that no longer exist. Invisible.

Three scripts measure the invisible three. **They report evidence and refuse to
rule** — every verdict in this skill is yours to make by reading, and the most
common way to misuse this tool is to treat a bucket label as a decision.

## Run the measurement first, always

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/measure.mjs"     # size, completed mass, section inventory
node "${CLAUDE_PLUGIN_ROOT}/scripts/stale.mjs"       # entries the repo moved on without
node "${CLAUDE_PLUGIN_ROOT}/scripts/dead.mjs"        # referents that no longer exist
```

All three take `--root <dir>` and `--json`. `stale.mjs` takes `--min-days N` to
raise the gap that counts as suspect.

**Never eyeball the numbers.** The reason `measure.mjs` exists is that a
maintainer estimated one repo's completed mass at 1.6% when it was 12.4% — wrong
by a factor of eight, and the estimate was the argument for leaving the file
alone. Run the command, quote the number.

## Configure per repo, not per convention

Zero config works when the file is `TODOS.md` and completions live under a
`## Completed`-style heading. Everything else goes in `.todokeeper.json` at the
repo root:

```json
{
  "targets": ["TODOS.md", "todos"],
  "splitThresholdBytes": 50000,
  "completedHeadings": ["completed", "done", "shipped", "archived"],
  "inlineDoneMarkers": ["✅", "— SHIPPED", "~~", "[x]", "DONE:"],
  "entryStyles": ["bullet"],
  "ignore": ["node_modules", "dist", "vendor"]
}
```

`targets` accepts files or directories. Every key is optional and overrides one
default; an unknown key is an error, not a silent no-op, and so is a wrongly
typed value. `completedHeadings` and `inlineDoneMarkers` take at most 100
entries of at most 64 characters — they hold words, and an unbounded word list
is a real cost, not a stylistic one.

**No key takes a regex** — `.todokeeper.json` ships inside the repo being
scanned, and a regex from an untrusted file can hang the run unstoppably.
`completedHeadings` holds literal words matched at the *start* of a heading
(optionally after `recently` / `previously` / `already`). `entryStyles` is any
of `bullet`, `numbered`, `bold-lead`; a blockquote prefix is stripped before the
style applies, so `> - **…**` archives parse with no config.

Reach for config when the first run looks wrong, and let the first run tell you
which key: 0% completed mass on a file that obviously holds finished work means
the heading's word is missing from `completedHeadings`; a section that reads as
0 entries means `entryStyles` does not name how this repo writes an entry.

## What the three reports mean

### measure — two numbers that diverge

**Size** decides whether splitting is on the table. **Completed mass** decides
whether splitting is worth anything. A large file that is mostly live work gains
almost nothing from an archive split; a large file that is mostly archive gains
the whole win. They are different questions and the second is the one people
guess at.

`inline done N marker(s) OUTSIDE any completed section` means completions are
recorded in place rather than moved. When that count is high, the completed-mass
percentage understates the archive and the file's real problem is that finished
work is interleaved with pending work — a different repair than splitting.

### stale — the code moved, the note did not

- **SUSPECT** — referents changed after the entry last did. Read the entry. This
  is evidence, not a verdict, and the false-positive rate is high by design: a
  note about a permanent constraint survives every refactor of the file it names
  and is still true.
- **REFERENT MISSING** — the entry names a path that is not there.
- **cold** — nobody touched the entry and nobody touched what it names. Not
  stale. Fine.
- **no path referent** — the blind half. An entry that describes its subject in
  prose cannot be dated by this method at all, so a large count here means the
  sweep covered less than it appears to.

### dead — tombstones, and why a plain grep fails

Grepping the repo for each referent and calling a hit PRESENT is wrong in one
specific recurring way: **when a thing is removed, the removal is explained in a
comment that names it.** On the first repo this ran against, every one of the
naive check's hits was a tombstone.

So hits are tiered. **COMMENT-ONLY is the finding to read by hand** — every
occurrence sits inside a comment, which usually means the thing is gone and the
comment says why. DOC-ONLY means described but not used. ABSENT means gone.
PATH-NOT-SCANNED means the path sits under an ignored directory and this tool
never looked, which is not the same as absent.

## Acting on it

### Splitting

Split only when `measure.mjs` says the threshold is crossed. Below it, one file
costs less than keeping two in sync.

**A split is relief, not a fix.** Expect the open half to stay over the threshold
too — measured across four repos split in one pass, all four did.

Before cutting, **check the completed section is current**. In two of those four
repos it was missing its newest entries, and the gaps fell inside the range a
"keep the most recent N" rule would have kept — so the cut would have archived
recent work and kept older work. Diff the section against the merged PRs since
its newest entry and write the missing entries first.

Then: **one commit, never two.** An entry deleted from the open file that lands
in the archive in a later commit is invisible across two diffs and obvious inside
one.

### Archiving

**Archive, never prune — and extract on the way out.** Completed entries carry
the reversed decisions and the don't-build-this constraints. Per entry, ask *does
this constrain future work?* If yes, lift it as an imperative into the repo's own
CLAUDE.md (or equivalent standing-instructions file) and leave the narrative in
the archive as provenance.

A repo with no standing-instructions file has nowhere to lift rules TO. Decide
where they go **before** archiving. An archive pass that moves entries without
extracting their rules is a silent regression: nothing verifies this step, and
the loss shows up months later as a re-litigated decision.

### Restructuring

If the file needs reorganising rather than splitting, **sort it the way this repo
already sorts it.** Surveyed across a set of unrelated repos, most sort by domain
(area of the codebase) and some sort by priority. None sorted by kind-of-entry.
A taxonomy imported from elsewhere reads as tidy to whoever imported it and as
noise to everyone else.

Sorting by kind is worth proposing only when one file is genuinely answering
several different questions at once, and then it is a proposal, not a default.

## Non-goals — stated, because an unstated limit reads as coverage

**It does not judge whether an entry is still true.** Every script reports
evidence; the reading is yours. SUSPECT means "the code changed", never "the note
is wrong".

**It does not expire anything.** A stale-but-open entry and a deliberately
long-lived one look identical to every check here. Nothing distinguishes them and
nothing should — that is a reading judgement.

**It does not fire below the threshold, and that is correct.** A 9KB deferred-work
file with a 30% archive is a healthy file. Do not split it.

**It cannot see an entry whose subject is prose.** Both stale and dead work from
backticked referents. An entry that names nothing in backticks is invisible to
both, and that is a large share of a typical file — the `no path referent` count
is how much.

**A repo-wide rename or restructure blinds it.** `git log -S` finds when a phrase
last changed; moving a file rewrites every entry's history at once, so for some
months afterwards recent churn says nothing about any individual entry. Check
whether such a commit is in range before trusting a clean sweep.

**An entry that names its FIX rather than its problem inverts every signal.**
"Add `.github/workflows`" reports REFERENT MISSING while the entry is open and
correct, and would report PATH-EXISTS the moment it is done. Read the direction
of the sentence before believing the bucket.

**Referent classification is heuristic and its residue is one-directional.** Line
citations, elided paths, package internals and branch names are filtered; a
slash-separated list of identifiers, and a path into a library the repo does not
depend on, are not. Both land in REFERENT MISSING. The error is always a false
alarm a human dismisses, never a missing referent reported as present.

**Dependency names are read from `package.json` and `composer.json` only.** A
Rust, Go or Python repo gets no dependency filter, which costs a few extra
entries in a bucket a human reads anyway and affects nothing else.

**Comment detection does not parse string literals**, so a needle inside a quoted
string after a `//` is misread as commented. That biases toward reporting a live
referent as COMMENT-ONLY — a false alarm rather than a hidden tombstone.

**Nothing outside the repository is read, including a deliberate symlink.**
`.todokeeper.json` ships inside the repo being scanned, so it is treated as
untrusted: a `targets` entry that resolves out of the tree through `..` or a
symlink is skipped and named on stderr. If a repo genuinely keeps its
deferred-work file elsewhere and symlinks to it, this refuses to measure it —
run the scripts where the real file lives.

**Config takes no regex, so entry and heading matching is only as flexible as
the lists allow.** A pattern from a file that ships inside the scanned repo can
hang the run with nothing able to interrupt it, and screening patterns by shape
does not work — a 34-character pattern with no groups and no alternation defeats
it. So `entryStyles` names three shapes and `completedHeadings` holds literal
words. A repo that marks entries some fourth way cannot be configured into
working; it needs a new style added to `ENTRY_STYLES` in `lib.mjs`.

**A heading that opens with a completed word is read as an archive**, even when
it means something else — `## Done criteria` counts as completed. Anchoring
keeps `## Not completed` out; it cannot keep this out. Check the heading list a
run reports before trusting its completed mass.

**The word-list caps bound the config, not the file.** `completedHeadings` is
lowercased once per word per heading, so 100 words of 64 characters is the
ceiling on one half of a multiplication whose other half — how many headings the
target file holds — nothing here bounds at all. Measured: a 489KB file of 50,000
headings against a full list of U+0130 takes 7.1 seconds, 130× under the 64MB
size cap and still slow. And the cap counts
code units rather than cost: a full list of Turkish dotted capital İ runs ~40×
slower than the same list in ASCII (602ms against 5,000 headings, versus 14ms).
Non-ASCII stays allowed because Greek and German heading words are the point of
a word list; sub-second is the ceiling, not the typical.

**A target over 64MB is skipped, and the skip changes the numbers.** Reading a
file this tool does not control costs several times its size in memory, so an
oversized one would end the process rather than the read. When a target is
skipped it is named on stderr and again in the report, and every figure —
total size, completed mass, the threshold verdict — is incomplete by that file.
Do not read a report with an `UNREAD` line as a measurement. The cap bounds one
file, not the set: several targets each just under it still sum past memory.

**Control characters are stripped from the human-readable reports, so what you
read is not byte-identical to the repo.** Headings, entry leads, source lines
and commit subjects are all written by whoever can commit, and an ESC in any of
them would be executed by your terminal rather than shown — for a tool that
exists to print findings, that means a hostile repo could redraw a `SUSPECT`
line to look clean. C0 and C1 are removed at every print sink; tab, newline and
carriage return survive. Only control characters go: Greek, German and emoji
are untouched. Use `--json` if you need the exact bytes — it escapes them
rather than stripping them.

**`dead.mjs` reads the repo into memory and stops at 256MB.** When it stops it
says how many files it skipped, and `ABSENT` is then incomplete by that many
files. Narrow `ignore` and re-run rather than reading a truncated report as a
clean one.
