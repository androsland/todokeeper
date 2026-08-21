# todokeeper

A Claude Code plugin that keeps a repo's deferred-work file honest.

`TODOS.md` fails in four ways, and only one of them is visible by looking at it:

| | failure | visible? |
|---|---|---|
| 1 | it grows until nobody reads it | **yes** — the file is long |
| 2 | it fills with finished work that reads as pending | no |
| 3 | entries stay open after the code beneath them changed | no |
| 4 | entries name files and symbols that no longer exist | no |

todokeeper measures the invisible three, and **reports evidence rather than
ruling**. Nothing here decides that an entry is wrong; it tells you which entries
have stopped agreeing with the repo, so you can go and read those.

## Install

```
/plugin marketplace add androsland/todokeeper
/plugin install todokeeper
```

Two skills load from it. Ask Claude to audit, split, or sweep the TODO file and
`todokeeper` loads. Ask what to work on next — or to "fix everything in
TODOS.md" — and `next` loads instead: it partitions the entries by whether they
are actually pending, shows the evidence for each call, and takes one ruled item
to a PR. It is deliberately not a burn-down; the reasoning is in the skill.

## The three scripts

They run standalone too — plain Node, no dependencies, nothing to build.

```bash
node scripts/measure.mjs      # size, completed mass, section inventory
node scripts/stale.mjs        # entries the repo moved on without
node scripts/dead.mjs         # referents that no longer exist
```

All three accept `--root <dir>` and `--json`; `stale.mjs` also takes
`--min-days N`.

### measure — two numbers that diverge

Size decides whether splitting is *on the table*. Completed mass decides whether
splitting is *worth anything*. A big file that is mostly live work gains almost
nothing from an archive split; a big file that is mostly archive gains the whole
win.

The second number is the one people guess at, and the guesses are bad. This
script exists because one estimate came in at 1.6% against a measured 12.4% —
wrong by a factor of eight, and it was the argument for leaving the file alone.

It also counts completions recorded *in place* (`✅`, `— SHIPPED`, `~~struck
through~~`) outside any completed section, because a repo that never adopted a
`## Completed` heading reads as 0% archive and isn't.

### stale — the code moved, the note did not

Two commit dates per entry:

```
git log -S"<the entry's distinctive phrase>" -1 -- <todos path>   when the ENTRY last changed
git log -1 -- <path the entry names>                              when its REFERENT last changed
```

An entry whose referents have churned since the entry itself last moved is
**SUSPECT** — the code it describes was edited and nobody revisited the note.
The inverse is reported too: untouched entry, untouched referents is not stale,
it is **cold**, and telling the two apart is the point.

### dead — tombstones, and why grep gets this backwards

The obvious check is to grep the repo for each backticked referent and call a hit
PRESENT. That check is wrong in a specific, recurring way:

> **When a thing is removed, the removal is explained in a comment that names
> the removed thing.**

So the grep finds the referent, inside the comment saying why it is gone, and
reports it alive. On the first repo this ran against, *every* hit the naive check
scored as present was a tombstone.

Hits are therefore tiered — `CODE`, `COMMENT-ONLY`, `DOC-ONLY`, `ABSENT` — and
**COMMENT-ONLY is the finding the script exists for.**

## Configuration

Zero config works when the file is `TODOS.md` with a `## Completed`-style
heading. Otherwise, `.todokeeper.json` at the repo root:

```json
{
  "targets": ["TODOS.md", "todos"],
  "splitThresholdBytes": 50000,
  "completedHeadings": ["completed", "done", "shipped", "archived"],
  "inlineDoneMarkers": ["✅", "— SHIPPED", "-- SHIPPED", "~~", "[x]", "DONE:"],
  "entryStyles": ["bullet"],
  "ignore": ["node_modules", "dist", "vendor"]
}
```

**A key given here REPLACES its default; it does not extend it.** The block
above is an example, and `completedHeadings` and `ignore` in it are both
deliberately shorter than what ships — copy those two lines and you get a
narrower list, silently. `inlineDoneMarkers` above is the full shipped default,
and it is written out precisely because the earlier five-item version of this
block dropped `-- SHIPPED` from anyone who pasted it.

`targets` takes files or directories; `ignore` takes literal names and
repo-relative paths, never globs — see [what gets scanned](#what-gets-scanned).
Every key is optional; an unknown key is
an error rather than a silent no-op, and so is a value of the wrong type — a
`splitThresholdBytes` given as a string used to pass silently and report every
file as under the threshold. `completedHeadings` and `inlineDoneMarkers` hold at
most 100 entries of at most 64 characters each; these are words, and the bound
is [a real one](#limits-of-the-safety-checks).

**No key takes a regex, deliberately** — see [the safety limits](#limits-of-the-safety-checks).
`completedHeadings` is a list of literal words matched case-insensitively at the
*start* of a heading, optionally after `recently` / `previously` / `already`, so
`## Recently shipped` counts and `## Not completed` does not. `entryStyles` is
any of `bullet` (`-`, `*`, `+`), `numbered` (`1.`, `2)`) and `bold-lead`
(`**Bold lead.** …` with no bullet); a leading blockquote marker is stripped
first in every case, so a `> - **…**` archive parses without configuration.

**Let the first run pick the key.** 0% completed mass on a file that plainly
holds finished work means the heading word is missing from `completedHeadings`.
A section reading as 0 entries means `entryStyles` does not name how this repo
writes an entry.

## What gets scanned

**`.gitignore` is honoured, by asking git.** When the root is a git work tree,
the file set comes from `git ls-files --cached --others --exclude-standard` —
so every `.gitignore` at every depth applies, along with `.git/info/exclude` and
your global excludes file. Nothing here parses gitignore syntax; git does, and
the reports say which enumeration ran:

```
Enumeration: git — .gitignore, .git/info/exclude and your global excludes all applied.
```

This used to be a plain directory walk, and the gap it left was not theoretical.
Measured on one real repo — a client project whose `interview/` directory holds
recordings, transcripts and a customer CSV export, protected by a single
`.gitignore` line — the walk read **149 of those files** on default config and
the git enumeration reads **0**. Any repo whose personal data, `.env` files or
credentials are kept out of git by `.gitignore` alone was in the same position.
It is also why `ignore` needs no pattern support: `*.log` and `.env.*` are
`.gitignore`'s job, and it does them correctly.

**Outside a git work tree it falls back to the directory walk, and says so.**
A non-git root, a missing git binary, a root below the work tree's toplevel, or
a listing past the 64MB buffer all take the same branch:

```
Enumeration: directory walk — this root is not a git work tree, so .gitignore was
NOT consulted and ignored files WERE read. `ignore` in .todokeeper.json is the only
exclusion in effect here.
```

That is a downgrade, not an error — but it is announced every run, because a
report that does not say which mode it ran in is claiming a coverage it may not
have.

**`ignore` is literal, and takes two shapes.** A bare name (`node_modules`)
matches that segment at any depth, files as well as directories — which is how a
repo keeps `.env` or `SESSION.md` out of the scan without inventing a directory
for it. A name containing a `/` (`web/test-results`) matches that repo-relative
path and everything under it, anchored at the root, so `other/test-results/` is
untouched. The path form is new; before it, a multi-segment entry was compared
against basenames, matched nothing at any depth, and sat in `.todokeeper.json`
reading exactly like protection.

**A shape that cannot match is now an error rather than silence.** A glob, an
absolute path, a backslash, `..`, an empty string or a padded string is rejected
at load with a message naming the entry and the reason. What no validator can
see is a well-formed entry naming a path that does not exist: `web/test-resluts`
passes every check and excludes nothing.

**A symlink is never followed, in either mode.** Git tracks a symlink as a blob
holding its target string and lists it exactly like a regular file, so the
enumeration is handed links as readily as files — and following one leaves the
file set the two paragraphs above just described. A link pointing into a
gitignored directory is not itself gitignored, so it passes every filter and
hands back the bytes `.gitignore` was keeping out; a link pointing outside the
repo breaks the "nothing outside the repository is read" contract below. Both
are dropped. The cost is real and is the accepted trade: a repo that reaches a
genuine doc through a symlink does not get that file scanned, and is told
nothing about it.

**`ignore` REPLACES the defaults, it does not merge with them.** Restate the
defaults you still want.

Four things this does not cover, stated so the section is not read as more than
it is. Personal data that was never gitignored and never named in `ignore` is
still scanned, and nothing can detect it — there is no property that separates
such a file from source. A tracked file matched by a `.gitignore` pattern is
still tracked, so git lists it and so does this. A symlink is skipped silently,
so a file you expected in the scan can be absent with no line saying why. And
the enumeration bounds what this tool READS; it is not a security boundary for
anything else on the machine.

## What it does NOT do

An unstated limit reads as a claim of coverage, so:

- **It does not judge whether an entry is still true.** SUSPECT means "the code
  changed", never "the note is wrong". A note about a permanent constraint
  survives every refactor of the file it names and remains correct. The
  false-positive rate is high by design.
- **It does not expire anything.** A stale-but-open entry and a deliberately
  long-lived one are indistinguishable to every check here.
- **It does not fire below the threshold.** A 9KB file with a 30% archive is
  healthy. Splitting it makes two files to keep in sync and buys nothing.
- **It cannot see an entry whose subject is prose.** `stale` and `dead` both work
  from backticked referents; an entry with none is invisible to both. The
  `no path referent` count reports how much of the file that is — on real repos
  it runs from a third to a half.
- **A repo-wide rename blinds it.** `git log -S` dates a phrase by when it last
  changed; a restructure rewrites every entry at once, so for months afterwards
  churn says nothing about any individual entry.
- **An entry naming its FIX rather than its problem inverts every signal.**
  "Add `.github/workflows`" reports REFERENT MISSING while it is open and
  correct.
- **An entry naming a HYPOTHETICAL referent reports its absence forever.** "So a
  `src/pages/privacy.astro` added tomorrow gets a CSP hash check and nothing
  else" names a file that does not exist, should not exist, and whose absence is
  the point of the sentence. It is not the inversion above — the absence tracks
  nothing, so resolving the entry never clears it — and nothing is
  misclassified: the string is a path and genuinely is not there. Measured
  across 11 real deferred-work files, 14 of 87 distinct missing-path referents
  are posited rather than real. **It is not detectable**: an indefinite article
  before the referent fires on 8 of 126 missing and 5 of 1,138 present, and
  structure is anti-diagnostic, because a hypothetical path is written to be
  plausible and so fits the tree exactly as well as a file that really was
  deleted. This is no reason to dismiss the bucket — a deleted file reads the
  same way and is what PATH-MISSING is for — and it says nothing about a
  referent that exists somewhere other than this tree.
- **Dependency names come from `package.json` and `composer.json` only** — a
  Rust, Go or Python repo gets no dependency filter. The cost is bounded to extra
  entries in a bucket a human reads.
- **Comment detection does not parse string literals**, so a needle in a quoted
  string after a `//` reads as commented.
- **CRLF is normalised on read; classic-Mac bare CR is not.** `\r\n` becomes
  `\n` before anything parses, so a Windows `core.autocrlf=true` checkout and a
  repo pinning `*.md text eol=crlf` in `.gitattributes` both parse identically to
  an LF one. A file whose lines end in a bare `\r` and no `\n` is one line to
  every splitter here, and nothing detects that — it will report one section and
  0% completed mass. What it will not do is stay quiet about it: any target that
  parses to no headings prints `0 headings matched` to stderr and names bare CR
  as a cause. A lone `\r` inside heading or entry text on an otherwise-LF file is
  left exactly as written, because this tool measures the file rather than edits
  it.
- **`measure.mjs` reports two sizes on a CRLF file, and they are different
  questions.** The size shown is the file **on disk**, which is what the split
  threshold is compared against and what `ls` agrees with. Every percentage is
  taken over the normalised text, which is one byte per line smaller. On an LF
  checkout the two are equal and only one is printed.

Every residual error is one-directional: a false alarm a human dismisses, never a
dead referent reported as alive.

### Limits of the safety checks

Everything todokeeper reads — the config, the deferred-work file, the source it
greps, the commit log it dates entries from — is written by whoever can commit
to the repo being scanned, not by you. It is treated as untrusted input
throughout. Each guard, and what it does not cover:

- **Nothing outside the repository is read.** A `targets` entry that resolves
  out of the tree — through `..` or through a symlink — is skipped, with the
  path named on stderr. This also refuses a legitimate setup: a repo that
  deliberately symlinks `TODOS.md` to a shared file elsewhere will not be
  measured. Run todokeeper where the real file lives instead.
- **No regex is accepted from config, which is why the config knobs are lists.**
  A regex from an untrusted file can burn an unbounded run inside V8 with
  nothing *in Node* able to interrupt it — a blocked event loop runs no timer,
  no signal handler and no abort:
  `^.*.*.*.*.*.*.*.*.*.*.*.*ZZZZ$` is 34 characters, has no groups and no
  alternation, and runs past eight seconds against an ordinary bullet line,
  because the pattern is tested against every line of the file. An earlier
  version screened patterns for the textbook `(a+)+` shape; that example passed
  the screen, and so would the next one, because recognising catastrophic
  backtracking from pattern shape cannot be done in general and V8 offers no
  timeout. **What it costs is a wasted run, not a wedged machine.** This bullet
  used to say "no way to interrupt it", full stop, and that was wrong: measured,
  an OS SIGINT terminates a V8-blocked Node process in 4ms, so Ctrl-C works. The
  ban stands on the wasted run, which is harm enough — it just is not the harm
  that was written here. **The cost is real:** `entryStyles` covers only the three entry
  shapes it names, so a deferred-work file that marks entries some other way is
  not parseable here at all — that is a missing style to add, not a config to
  write.
- **The word lists are bounded at 100 entries of 64 characters.** Removing the
  regex did not remove the cost: `completedHeadings` is lowercased once per word
  per heading, so its cost is `headings × Σ(word lengths)` — two
  attacker-controlled dimensions multiplying. Measured, 500 words of 10KB
  against 5,000 headings took **8.7 seconds**; the same 500 words at 10
  characters took **0.167**. The string length is the whole cost and the item
  count is nearly free, which is why the per-word cap is the real fix and the
  item cap is only a second wall. `targets` and `ignore` are deliberately left
  unbounded — one resolves each entry once, the other becomes a Set, and neither
  multiplies against anything.
- **Entries and distinct referents are capped at 5,000 each, because those two
  counts multiply against the byte caps rather than sitting beside them.**
  `dead.mjs` makes one pass over every file in its 256MB read budget *per*
  distinct referent, so its cost is `referents × scanned-bytes`. Measured here,
  linear in both: at 18MB of corpus, 100/200/400/800 referents cost
  0.25/0.40/0.70/1.36s; at 400 referents, 10/20/40/80MB cost
  0.36/0.71/1.41/2.86s — a constant of 9.03e-5 s per referent per MB that
  predicted 8.5s for 5,000 referents against 18MB where the measurement was
  8.13s. Both factors cleared every cap that already existed and their product
  did not: a target at the 64MB `TARGET_CAP` holds roughly **655,000** referents,
  which against a 256MB corpus is about **4.2 hours** of pegged CPU from a
  `TODOS.md` that looks entirely ordinary. `stale.mjs` has the same shape by a
  different mechanism — one `git log -S` child process per distinct entry needle,
  with nothing bounding entry count, **and** a second child per distinct resolved
  referent path, which the entry cap does not bound at all (one entry naming
  1,200 resolving referents spawned 1,201 children). `MAX_REFERENTS` caps that
  second dimension too. The cap is set from measurement, not taste:
  across the six largest real deferred-work files on hand the most any one holds
  is **1,219** distinct referents and **195** entries, so 5,000 is 4.1× and 25.6×
  the observed maxima. Hitting it is announced on stderr **and** in the report,
  because a truncated scan that printed like a complete one would call a live
  referent `ABSENT`.
- **The cap bounds the count, not the cost, and cannot tell hostile from large.**
  5,000 referents against a 256MB corpus is still ~115 seconds and nothing here
  shortens that, and a `stale.mjs` run that actually reaches the entry cap
  measured **39 seconds** against a one-commit repo — more against real history,
  because each `git log -S` child's own cost grows with the log it searches.
  Bounded is not fast, and neither figure is a promise. A genuinely huge
  deferred-work file is truncated in exactly the way an attack is, and the
  announcement is the entire remedy. It also does
  nothing for the headings dimension, which multiplies against `completedHeadings`
  instead and has its own standing entry in `TODOS.md`.
- **`ignore` and `.gitignore` are both attacker-controlled, and a
  `PATH-NOT-SCANNED` verdict now says which side put it there.** Both files ship
  inside the repo being audited, so one commit can delete a file an entry names
  *and* exclude that file's directory; the referent then reports
  `PATH-NOT-SCANNED` instead of `PATH-MISSING` — verified, not theorised. That
  is an honestly-labelled bucket, not a fabricated clean result, but
  `PATH-NOT-SCANNED` reads as "out of scope" and a reader scans past it. So a
  referent excluded by anything that is *not* one of todokeeper's own defaults is
  listed by name in both `dead.mjs` and `stale.mjs`, under a heading that says
  the audited repo excluded it, and tagged `(.todokeeper.json)` or `(.gitignore)`
  so the reader opens the right file. **This does not detect the suppression** —
  it cannot know intent, and it fires identically on a repo that legitimately
  ignores its own `fixtures/`. It only refuses to let the cases print the same
  way. Honouring `.gitignore` widens this surface on purpose: reading a repo's
  secrets was the worse of the two failures, and the disclosure is what keeps
  the trade visible.
- **That cap counts code units, not cost, so the real ceiling is a range.** A
  full 100 × 64 list against the same 5,000 headings costs 14ms in ASCII, 20ms
  in German, ~71ms in Greek or Cyrillic, 143ms in astral characters, and
  **602ms** in U+0130 (Turkish dotted capital İ) — a ~40× spread, because V8
  drops off its fast Latin1 lowercasing path above Latin1 and off even the ICU
  path for U+0130's special-casing exception. Non-ASCII is **not** rejected: a
  Greek or German heading word is a legitimate config and is most of the reason
  to prefer a word list over a pattern. So the honest worst case a hostile
  config can buy here is 602ms, not the 14ms an ASCII-only benchmark implies —
  sub-second and linear, which is why the cap is where this stops.
- **Control characters are stripped from everything printed for a human to
  read.** The reports quote headings, entry leads, matched source lines and git
  commit **subjects** — all of them bytes someone else wrote — and an ESC in
  any of them is executed by your terminal rather than displayed. For a tool
  whose whole output is findings that matters more than usual: cursor and erase
  sequences let a repo redraw a `SUSPECT` line to look clean, and on terminals
  honouring OSC 52 the same primitive writes to your clipboard. The
  commit-subject path needs no edit to the deferred-work file at all — an
  ordinary commit to any file it happens to reference, with the payload in the
  subject. So C0 and C1 are removed at every print sink. **This strips control
  characters, never a character set** — Greek, German and emoji pass through
  untouched, for the same reason non-ASCII is legal in the word lists.
- **Tab, newline and carriage return are layout in a body and forgery on a
  report line**, so there are two sinks rather than one. A multi-line quote
  keeps them; every single-line print — a filename, a heading, a config value, a
  commit subject — escapes them, along with the bidi overrides (U+202A–U+202E,
  U+2066–2069), which are format characters rather than control characters but
  reorder a line just as effectively. Without that split a bare carriage return
  is enough to forge a clean-looking finding, with no ESC involved at all. The
  split is a convention held by whoever writes the next `console.log`: nothing
  lints it, and a single-line report built with the body-sink helper compiles,
  reviews and ships.
- **`--json` escapes those bytes rather than stripping them** — its output is
  safe to `cat`, and a parser still decodes the escape back to the repo's
  original codepoint, which is the fidelity the flag exists for. This was
  documented as needing no handling at all, on the grounds that
  `JSON.stringify` escapes control bytes by itself. It escapes **C0 and nothing
  else**: measured, ESC and NUL come out escaped, but DEL emits a raw `0x7F`
  and every C1 codepoint emits its raw UTF-8 form (`U+009B` → `0xC2 0x9B`) —
  precisely the range the human-readable strip was extended to cover. One
  codepoint was tested and the result generalised to a range.
- **Nothing outside the repository is read — and that now includes
  `package.json` and `composer.json`.** Every other path went through the
  containment check; these two had only a size cap. `package.json` is
  git-trackable as a symlink, so `package.json -> ../outside/anything` ships in
  a clone with no config involved: measured, an external `dependencies` key
  reclassified an in-repo referent and dropped it out of `dead.mjs`'s report,
  and `package.json -> /dev/zero` read **3.9GB resident in ten seconds** and was
  still climbing when the timeout killed it. A device or fifo reports size 0, so
  no size cap can bound it — every read is now gated on the path resolving
  inside the tree *and* on it being a regular file.
- **A target file over 64MB is skipped rather than read.** `readFileSync` has
  no ceiling below V8's 537MB string limit and the allocation fails long before
  it: measured, a 53.7MB file parses correctly in 1.54s while holding **490MB
  resident** — about 9× the file — so a few hundred MB exits with
  `FATAL ERROR: Reached heap limit` and a native stack, which is a crash rather
  than an error message. The cap sits ~247× above the largest real
  deferred-work file seen (259KB). A skip is announced on stderr **and** in the
  report itself, because it changes the total, the completed mass and the
  threshold verdict — a skipped file counted as measured produces a number that
  is simply wrong. `.todokeeper.json`, `package.json` and `composer.json` get
  the same treatment at 1MB, plus the containment and regular-file checks
  above. **What it does not cover:** it bounds one file,
  never the set — five 63MB targets still sum past memory, and nothing totals
  them. And a byte cap is not a memory cap; the ~9× amplification is a property
  of one V8 on one machine.
- **`dead.mjs` reads the repo into memory and stops at 256MB.** Past that it
  reports how many files went unscanned, and its `ABSENT` verdicts are incomplete
  by exactly that many files. Narrow `ignore` and re-run rather than reading the
  truncated result.

Four things these guards do **not** cover. The path check resolves and then
reads, so a symlink swapped in between the two calls wins the race — an attacker
who can do that already has write access to the same tree. A heading that
begins with a completed word but means something else (`## Done criteria`) is
read as an archive; the anchor stops `## Not completed`, not this. The size cap
bounds bytes, not work: measured, a 489KB file of 50,000 headings against a full
100 × 64 word list of U+0130 takes **7.1 seconds** — 130× under the size cap and
still slow, because the cost is `headings × Σ(word lengths)` and only the config
half of that multiplication is bounded. And a `package.json` that is rejected
for any reason — oversize, resolving outside the tree, or not a regular file —
is skipped **silently**: the dependency filter simply stops applying, which
costs a few extra entries in a bucket a human reads, but unlike the target skips
nothing says it happened. That last one is deliberate and it is a real
trade-off, because the same silence covers the ordinary case of a repo that has
no `package.json` at all.

## Splitting and archiving

The skill carries the procedure. The parts worth knowing before you start:

- **A split is relief, not a fix.** Across four repos split in one pass, all four
  open halves stayed over the threshold.
- **Check the completed section is current before you cut.** In two of those
  four it was missing its newest entries, and the gaps fell inside the range a
  keep-the-most-recent-N rule would have preserved — so the cut would have
  archived recent work and kept older work.
- **One commit, never two.** An entry deleted from one file and added to another
  in a later commit is invisible across two diffs and obvious inside one.
- **Archive, never prune — and extract on the way out.** Completed entries carry
  the reversed decisions. Lift the ones that constrain future work into the
  repo's standing-instructions file; leave the narrative behind as provenance.
  Nothing verifies this step, which is exactly why it is written down.

## Tested against

Astro/TypeScript, Next.js/TypeScript and Python repos, ranging from 2KB to 147KB
of deferred work, with completed sections written four different ways. The
smallest were used to confirm it correctly does **nothing**.

```bash
node test/smoke.mjs      # 132 checks, no dependencies, ~1.5s
```

The suite builds a throwaway git repo, executes **every** branch of the
referent classifier, and runs all four scripts end to end. That shape is not
arbitrary: a rename applied to one branch of `classifyReferent` and missed on
the branch twelve lines above it shipped past `node --check`, which parses
without resolving identifiers, and crashed on every repo whose deferred-work
file names a glob. The suite fails on that bug; `node --check` does not.

One phase scans source rather than behaviour: the four `scripts/*.mjs` and the
suite itself must carry no literal control byte outside tab, newline and
carriage return. In a tool whose subject is control characters, a stray one is
invisible in every diff view and silently changes what it matches. It found a
literal ESC in its own explanatory comment on its first run. It covers those
five files only — not the skills, the README or any config — and nothing runs it
for you. It is also blind to the bidi overrides it teaches the reports to
escape: those are format characters, not control characters, and four literal
ones reached `lib.mjs` while that very escaping was being written.

**It checks that verdicts are well-formed, not that they are right.** A change
that reclassified every symbol as prose would pass. Correctness is still
established by diffing `--json` output against real repos — and when you do
that, do not discard stderr: four crashed runs once read as four empty files.
It also skips both count caps on purpose, since reaching them costs 8.2s and
39s; nothing here would notice if a cap were removed.

## License

MIT
