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

Then ask Claude to audit, split, or sweep the TODO file, and the skill loads.

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
  "completedHeadingPattern": "^(recently\\s+)?(completed|done|shipped)\\b",
  "inlineDoneMarkers": ["✅", "— SHIPPED", "~~", "[x]", "DONE:"],
  "entryPattern": "^\\s*(>\\s?)*[-*]\\s",
  "ignore": ["node_modules", "dist", "vendor"]
}
```

`targets` takes files or directories. Every key is optional.

**Let the first run pick the key.** 0% completed mass on a file that plainly
holds finished work means `completedHeadingPattern` missed the heading. A section
reading as 0 entries means `entryPattern` does not match how the repo writes a
bullet — blockquoted archives (`> - **…**`) are the usual culprit, which is why
the default allows them.

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
- **Dependency names come from `package.json` and `composer.json` only** — a
  Rust, Go or Python repo gets no dependency filter. The cost is bounded to extra
  entries in a bucket a human reads.
- **Comment detection does not parse string literals**, so a needle in a quoted
  string after a `//` reads as commented.

Every residual error is one-directional: a false alarm a human dismisses, never a
dead referent reported as alive.

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

## License

MIT
