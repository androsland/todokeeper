# TODOS

Deferred work for todokeeper itself. It is also the plugin's own test fixture —
run the three scripts against this repo and they should report something sane. Note
that all seven of its PATH-MISSING referents name something outside this repo rather
than something missing from it — a hypothetical page whose absence is the clause's
whole point, plus manifests, a module specifier and paths quoted from other repos as
evidence. The tool has no way to tell a quoted example from a claim, and that is the
point of the hypothetical-referent entry below, not a defect in the file. Where a
quoted path can move into a fenced block without costing the sentence, it has — the
scoring table below is fenced for exactly that reason. (measured 2026-08-19)

## Referent classification

- **A slash-separated list of identifiers still reports as a missing path.**
  A backticked run like `col_one/col_two/col_three` — one test repo used the
  shape for a set of database columns — is not a path, but lands in
  REFERENT MISSING because it has slashes and no extension. The
  general fix — "no ancestor directory of this path exists, so it is probably not
  a path" — was rejected because it also suppresses `.github/workflows`, which is
  a genuine true positive in a repo that has no CI yet. A softer confidence tier
  rather than suppression is the shape of the real fix.
  (measured against a second test repo, 2026-08-16)

- **A path into a library the repo does not depend on cannot be recognised.**
  `next/font` in a repo with no Next.js dependency is indistinguishable from a
  missing directory. `isDependencyPath` only knows declared dependencies, and
  something referenced purely as a comparison is declared nowhere.
  (measured, 2026-08-16)

- **Dependency names are parsed from `package.json` and `composer.json` only.**
  Cargo.toml, go.mod, requirements.txt and pyproject.toml are not read, so a
  Rust, Go or Python repo gets no dependency filter at all. Deliberate — the
  parsing surface outweighs the payoff, and the cost is bounded to extra entries
  in a bucket a human reads. Revisit if a non-JS repo becomes a primary consumer.
  (decided, 2026-08-16)

- **A referent the sentence never claimed exists still reports as missing, and
  nothing separates it from one that really was deleted.** "So a
  `src/pages/privacy.astro` added tomorrow gets a CSP hash check and nothing
  else" posits a page that does not exist, should not exist, and whose absence
  is the point of the clause — and it lands in PATH-MISSING and REFERENT MISSING
  like any other. It is **not** the fix-inversion non-goal: there the referent's
  absence tracks the entry's open/closed state, so the signal is inverted but
  real, whereas here the referent is expected to be absent in both states and
  resolving the entry never clears it. It is **not** the residue paragraph
  either: the string IS a path, correctly typed and correctly reported absent,
  so no confidence tier in `classifyReferent` reaches it — a tier ranks how
  likely a string is to be a path, and this one certainly is. Measured across 11
  deferred-work files on hand: 126 missing-path occurrences, 87 distinct, across
  8 repos — **14 of the 87, in four unrelated repos**, are posited rather than
  real (a page someone might add, an illustrative placeholder, benchmark fixture
  paths, filenames in a described upload).
  **Detection was tried and does not work.** An indefinite article before the
  referent fires on 8 of the 126 missing and 5 of the 1,138 present — an article
  is a fact about English, not about modality — and only one of those 8 is this
  shape. Tightening to article-plus-addition-verb ("a … added") scores 1 of
  126 and 0 of 1,138: precision 1.0 at a recall of the single instance that
  suggested the rule, which is a sample wearing a spec's clothes. The structural
  cue is worse, because it is anti-diagnostic — scoring deepest existing
  ancestor plus same-extension siblings:

  ```
  hypothetical page      src/pages        + 3
  renamed-away file      src/lib          + 85
  deleted file           src/lib/media    + 19
  ```

  **A hypothetical path is written to be plausible, so by construction it fits
  the tree exactly as well as a file that really was deleted.** Shipped as a
  named non-goal in SKILL.md and README.md instead of a heuristic.
  (measured across 11 deferred-work files, 2026-08-18)

- **A call that carries its own arguments is still searched for literally.**
  A referent written `safeField()` now searches for the call site; one written
  t('errors.exportFailed') — 34 of the 2,878 referents in the files on hand — is
  compared whole, and an interpolation like ${...} around a call (4) is not a
  name at all. Deliberate: the quoted argument is exactly what makes such a
  referent specific, and widening it to the bare callee would search a repo for
  t( , which matches every translated string in it. Revisit only with a case
  where the argument is noise rather than the point.
  (measured across 11 deferred-work files, 2026-08-19)

- **A bare name and its call form are still two referents.** The needles differ —
  `buildFileIndex` against buildFileIndex( — so a file naming both gets a row for
  each and the two `named by` lists never merge. The one place they DO merge is
  where the file already writes the opening-paren form itself, which the strip
  turns into the same string; that is one referent in the corpus. Collapsing the
  general case needs a symbol identity that a text scan does not have.
  (measured, 2026-08-19)

- **The needle is a substring, so a qualified call answers for the bare one.**
  Searching for max( also matches Math.max( ; import_customers( matches
  public.import_customers( ; resize( matches cv2.resize( . All three are in the
  corpus, all three were read by hand, and in all three the match names the
  symbol the entry meant — a schema-qualified call and a method call are the same
  function. What it cannot rule out is a same-named function in an unrelated
  module: that reports CODE for a symbol the entry's own repo really did delete,
  which is the false-negative direction this tool exists to avoid. Ruling it out
  needs per-language name resolution. It is a widening of a limit the scan
  already had, not a new one — the empty-paren form was a substring test too.
  (measured, 2026-08-19)

## Comment detection

- **`scanFile` does not parse string literals.** A needle inside a quoted string
  following a `//` on the same line — a URL in code is the common case — is
  misread as commented. Errs toward reporting a live referent as COMMENT-ONLY,
  which is a false alarm rather than a hidden tombstone, so it is tolerable but
  not correct. A real fix needs a per-language tokenizer.
  (known at design time, 2026-08-16)

## Line endings

- **`sections` and `entries` trust their caller for line endings, and nothing
  enforces it.** (found fixing the CRLF defect, 2026-08-19) `normaliseNewlines`
  runs inside `readTargetMeta`, which is the boundary every script reads targets
  through, so the three CLIs are covered. `scripts/lib.mjs` is also an importable
  module: anything that calls `sections` on bytes from its own `readFileSync`
  gets the original defect back — zero headings, and a report that looks
  measured. Stated in the `sections` docblock and nowhere else. A fix would be
  normalising defensively inside both parsers, which costs a second pass over
  every file and, worse, lets section byte counts disagree with the whole-file
  count `measure.mjs` takes its percentages against. Left as a documented
  contract deliberately; revisit if lib.mjs ever gains a consumer that is not
  one of these three scripts.

- **The 20-non-blank-line floor under the headingless warning is a judgement
  with nothing behind it.** (found fixing the CRLF defect, 2026-08-19) Below it
  `warnIfHeadingless` stays silent, because a short flat deferred-work file with
  no headings is an ordinary way to keep one and warning about it is how a
  warning gets ignored. Nothing calibrated the number against real repos, so a
  19-line file that failed to parse gets the silent 0% the warning exists to
  prevent. Both directions are tested; neither test says the boundary is in the
  right place.

- **Setext headings are named as a cause and still not parsed.** (found fixing
  the CRLF defect, 2026-08-19) A file whose headings are underlined with `===`
  or `---` yields none, so completed mass reads 0% and the archive sweeps as
  live work — the same failure CRLF produced, from a different cause, and now
  the only remaining one that a well-formed markdown file can hit. The warning
  names it and `README.md` carries it as a non-goal, which is honest but is not
  support. Supporting it means a second heading pass with a lookahead, and the
  cost is that `---` is also a thematic break and a front-matter fence.

- **The scanned corpus is never normalised, and only `indexOf` keeps that
  safe.** (found fixing the CRLF defect, 2026-08-19) `dead.mjs` reads repo files
  with a bare `readFileSync` — deliberately, since normalising every file in a
  large tree buys nothing when the needle is located with `line.indexOf` and
  displayed through `trim`. Verified rather than assumed at the time: the one
  regex in `scanFile` treats a trailing CR as the whitespace it is. That safety
  is a property of today's implementation, not of the read, so the next
  line-oriented pattern added there inherits the CRLF bug with no boundary to
  catch it.

- **The split threshold now compares a size no percentage uses.** (found fixing
  the CRLF defect, 2026-08-19) `measure.mjs` deliberately keeps two figures: the
  on-disk size, which answers "is this file big enough to split", and the
  normalised text length, which is the denominator of every ratio. On a CRLF
  repo they differ by one byte per line — about 1.4% on a 4,400-line file — so a
  file can cross the threshold on bytes that normalisation removes and that no
  reported percentage is taken over. Both are printed and labelled, which is the
  whole mitigation; nobody has argued the alternative assignment.

## Coverage

- **`entryStyles` names three shapes and a repo outside them cannot be
  configured into working.** A deferred-work file written as a table, or as a
  checklist inside a table cell, reports 0 entries per section while still
  measuring bytes correctly. Since config no longer takes a regex, the fix for a
  fourth shape is a new entry in `ENTRY_STYLES`, not a setting — deliberate, but
  it means every new shape is a release. `numbered` and `bold-lead` were added
  when the regex went away and are exercised only by hand.
  (2026-08-16, revised 2026-08-17)

- **`test/smoke.mjs` covers the branches, and exactly two answers.** It executes
  every `classifyReferent` branch and runs all four scripts end to end against a
  fixture, which is what a rename that broke the glob branch needed and did not
  have. The call-form phase added the first assertions that a verdict is
  CORRECT rather than merely well-formed: a live call reads CODE, a tombstoned
  one reads COMMENT-ONLY. Measured with the mutation this entry used to name —
  reclassifying both symbol returns as prose — the suite now fails 7 checks
  against 4 before, and 3 of that 4 were collateral, tripping only because the
  report empties. Every other verdict is still shape-checked only, so the tier
  ladder below CODE and every path verdict are caught only by diffing `--json`
  against real repos by hand, which is the step this entry has not yet
  replaced.
  It also skips both count caps deliberately — reaching them costs 8.2s and 39s,
  which is a benchmark, not a smoke test, so nothing would notice if a cap were
  deleted. (2026-08-16, narrowed 2026-08-17, narrowed 2026-08-19)

- **`suspect` is only as good as the git history it reads.** It was unexercised
  entirely until a repo with month-old entries was tested — the first test repo's
  entries were all written the same week, so the code path returned zero every
  time and looked like it worked.
  (2026-08-16)

- **Nothing checks what an archive split loses.** `measure.mjs` reports the
  threshold and recommends a split, and this file has now had one: 15 completed
  entries out to `TODOS-DONE.md`, the 5 most recent kept. The step that actually
  matters is the one no script performs — reading each archived entry for a
  constraint that still binds future work and lifting it somewhere a reader will
  meet it. That was done by hand into `CLAUDE.md`, and nothing verifies it, so a
  pass that moves the bytes and drops the rules looks exactly like one that does
  not. A checker would have to judge which prose is a constraint, which is the
  hypothetical-referent problem wearing different clothes, so the shape of any
  fix here is a prompt for the human rather than a heuristic. What `measure.mjs`
  can honestly add is the input to that judgement — how much completed mass a
  split would move, which it already computes.
  (2026-08-19)

## Triage

- **The partition in `skills/next/SKILL.md` quotes numbers from this file, and
  nothing keeps them true.** (writing the triage skill, 2026-08-19) The skill
  opens with 46 live entries split 19 decided / 7 ready / 10 design-owed / 10
  observed, because the ratio — seven of forty-six actually ready — is the entire
  argument for why it triages instead of burning down. That table was counted by
  hand on the day it was written and is already a snapshot: every entry this
  repo files or retires moves it, and no check compares it against
  `measure.mjs`'s live count. It degrades toward being wrong in the direction
  that weakens the argument rather than overstates it, since decided entries
  accumulate faster than ready ones get resolved. A shipped illustration that
  says "measured on the repo this was written in" and carries its date is the
  cheap version; recounting on every run is the expensive one and would put a
  classifier in the loop, which the skill exists to argue against.

- **Nothing separates a decided entry from one whose revisit condition has
  since fired.** (writing the triage skill, 2026-08-19) Several entries here
  are decided *conditionally* — "revisit if a non-JS repo becomes a primary
  consumer", "revisit only with a case where the argument is noise", "revisit
  if lib.mjs ever gains a consumer that is not one of these three scripts". The
  condition is prose about the world outside the repo, so no scan can evaluate
  it, and an entry whose trigger fired last month reads identically to one whose
  never will. Named as a non-goal in the skill. The most that is available is
  surfacing the revisit clause to whoever is triaging, which the skill does and
  which is not the same as checking it.

- **The archive step in `skills/todokeeper/SKILL.md` lifts attacker-writable
  prose into the audited repo's standing-instructions file, and says nothing
  about that.** (security review of the triage skill, 2026-08-20) That skill's
  archiving section tells an agent to read each completed entry, decide whether
  it constrains future work, and "lift it as an imperative into the repo's own
  CLAUDE.md". Entry text is written by whoever can commit, which this repo's
  threat model treats as untrusted — so the step turns repo prose into durable
  standing instructions for every later agent session, which is a longer-lived
  effect than the read-and-obey surface just closed in `skills/next/SKILL.md`.
  The two are adjacent, not the same: one is obeying text now, this is promoting
  text into a file whose whole purpose is to be obeyed later. The boundary
  paragraph written for the triage skill is the shape of the fix, reworded for a
  write rather than a read; it was kept out of that branch because the branch's
  theme was triage and a skill is executable behaviour.

- **Nothing detects that audited-repo text tried to direct the agent.**
  (security review of the triage skill, 2026-08-20) `skills/next/SKILL.md` now
  tells the agent that repo text addressing it is a finding to report rather
  than an instruction to obey, and names the unenforceability as a non-goal.
  That is honest but thin: the rule is followed by whoever reads it, nothing
  scans for the case, and nothing checks afterwards that the boundary held. A
  detector is not obviously buildable — the tool's own repeated result is that
  intent is not recoverable from prose shape, and an injected directive is a
  fact about intent, so a heuristic here would fail in the same way the
  hypothetical-referent detector did. Recording it because the gap is real, not
  because a scan is owed. Any fix that looks like a regex over entry text is the
  wrong one.

- **Step 2's inert-quoting rule is advisory, and the deterministic version needs
  the scripts to emit entry bodies.** (security review round 2, 2026-08-20) The
  triage skill now tells the agent to strip or flag non-printable characters
  before quoting entry text into chat or a PR body, and points at `--json` when
  the exact bytes matter. That is a rule the agent applies by eye, not the
  mechanical strip this repo's own constraint asks for — "send everything
  human-readable through the escaping helpers" means `safeField` and the JSON
  sinks, and Step 2's quoting reaches neither. The reason it cannot today is
  concrete: the agent reads entry prose straight from the file because no script
  emits an entry BODY — `dead.mjs` and `stale.mjs` emit leads and matched source
  lines, `measure.mjs` emits sizes and headings. Routing the quote through an
  escaped sink therefore means widening what the scripts print, which is a
  `scripts/` change and belongs to its own PR. Detection here is a byte test
  rather than an intent judgement, so unlike the classifier bets this repo has
  lost, it is genuinely mechanisable — that is the argument for doing it rather
  than declaring another non-goal.

## Untrusted input

- **A heading that opens with a completed word is read as an archive.**
  `## Done criteria` counts as completed and its entries drop out of every
  report. Anchoring keeps `## Not completed` out but cannot keep this out, and
  the retired regex behaved identically, so it is a standing limit rather than a
  regression. A fix needs a negative list or a second word check; neither has
  been designed, and the error understates live work rather than hiding it.
  (2026-08-17)

- **`isEntryStart` and `isCompletedHeading` are covered by a throwaway script,
  not a test.** 26 cases were run by hand against both, including a parity check
  against the regex they replaced across 15 headings. Nothing in the repo
  re-runs them, so the next edit to either has no net. Folds into the "nothing
  tests the scripts" entry above; noted separately because these two are now the
  only thing standing between a config and a misparse.
  (2026-08-17)

- **Containment refuses a legitimate setup.** A repo that deliberately symlinks
  `TODOS.md` to a shared file outside its tree is now unmeasurable. That is the
  intended trade — the same symlink is the no-config arbitrary-read vector — but
  an `allowOutsideRoot` opt-in with a loud banner would serve the honest case
  without reopening the silent one. Nobody has asked for it yet.
  (security review, 2026-08-17)

- **The target cap bounds bytes, not work.** `TARGET_CAP` stops a file large
  enough to end the process, but `isCompletedHeading` costs
  `headings × Σ(word lengths)` and nothing bounds the heading count. Measured:
  a 489KB file of 50,000 headings against a full 100 × 64 list of U+0130 takes
  **7.12s and peaks at 119MB** — 130× under the size cap. Deliberately left:
  the config half of that multiplication is capped, the file half is a repo's
  own content and a weaker threat than a config a contributor adds in a PR.
  (security review, 2026-08-17, narrowed from a wider entry the same day)

- **`TARGET_CAP` bounds one file, never the set.** `targets` may name a
  directory of five files, each 63MB, and nothing totals them the way
  `dead.mjs`'s `TOTAL_CAP` totals its repo-wide walk. No aggregate budget exists
  on the target side. Not built because no real deferred-work directory is
  within three orders of magnitude of this, and an aggregate cap needs a rule
  for WHICH file to drop — a choice with no obviously right answer.
  (security review, 2026-08-17)

- **A rejected `package.json` degrades the dependency filter silently.**
  `declaredDependencies` skips a manifest that is oversize, resolves outside the
  tree, or is not a regular file, and says nothing — it shares the existing
  catch-all path where a missing or unparseable manifest simply means the filter
  does not apply. The cost is the documented one (a few extra entries in a
  bucket a human reads), but unlike the target skips it is not announced, so a
  2MB `package.json` looks like a repo with no dependencies. Announcing it would
  also have to stay quiet for the ordinary no-manifest case, which is the same
  code path — that separation is the actual work, and it has not been done.
  (security review, 2026-08-17; widened 2026-08-17 when containment and
  regular-file checks joined the cap)

- **The control-byte scan covers five files and runs only when someone runs it.**
  `test/smoke.mjs` now asserts zero non-layout control bytes across the four
  `scripts/*.mjs` and itself, which closes the case that kept biting. It sees
  nothing else: `SKILL.md`, `README.md`, `.todokeeper.json` and any fixture are
  outside the list, and a control byte in a skill file is exactly as invisible in
  a diff view as one in source. Nor is anything wired to run the suite — no hook,
  no CI, no pre-commit — so the scan protects only the edits made by someone who
  runs `node test/smoke.mjs`. Widening the file list is trivial; wiring a trigger
  is executable behaviour and gets its own change.
  (self-review, 2026-08-17, narrowed the same day once the scan landed)

- **The control-byte scan is blind to the exact characters that landed in source
  while it was being written.** `testNoControlBytes` covers C0-minus-layout, DEL
  and C1. Bidi overrides (U+202A–U+202E, U+2066–2069) are *format* characters,
  not control characters, so the scan does not see them — and four literal ones
  went into `lib.mjs` during round 8, put there by the editing tool while writing
  the regex that escapes them, and found by a hand-run scan rather than the
  suite. `safeField` escapes them on OUTPUT; nothing checks for them in SOURCE.
  Widening the scan is a one-line character-class change and was deliberately not
  bundled with a security fix round. (self-review, 2026-08-17)

- **Nothing enforces `safeField` at a print sink that does not exist yet.**
  Every current single-line `console.log` in the four scripts routes through it —
  12 sites in `lib.mjs`, 9 in `dead.mjs`, 13 in `stale.mjs`, 5 in `measure.mjs` —
  but the split between `safe()` (multi-line-tolerant) and `safeField()` (single
  line, escapes CR/LF/tab/bidi) is a convention held by whoever writes the next
  line. No lint rule, no test, no wrapper type. The failure mode is silent: a new
  `${safe(heading)}` in a one-line report reads correctly in review and forges a
  report line at runtime. (self-review, 2026-08-17)

- **`stale.mjs` still classifies every referent occurrence, with no memoisation.**
  `dead.mjs` now caches `classifyReferent` on the raw string; `stale.mjs` calls
  `classifyReferent` per occurrence and only caches the git lookup that follows.
  The cost is bounded by `MAX_REFERENTS` on the git children, which is the
  expensive half, so the remaining exposure is index lookups on repeated
  non-resolving strings — measured at 0.65s per 30,000 in `dead.mjs`'s harness,
  and `stale.mjs` has no harness of its own. Left because the two scripts resolve
  through different call shapes and unifying them is a refactor, not a fix.
  (self-review, 2026-08-17)

- **The 256MB read budget in `dead.mjs` is a guess, not a measurement.** It was
  chosen to sit below a default Node heap; nothing measured what the scanned
  repos actually peak at, so the headroom is unknown in both directions. No repo
  has hit it, which also means the truncation path and its stderr warning have
  never run outside a synthetic test.
  (2026-08-17)

- **`MAX_ENTRIES` caps what is PROCESSED, never what is MATERIALISED.**
  `entries()` is eager — it does `body.split('\n')` and builds the whole array
  before the caller sees the first element — so both `dead.mjs` and `stale.mjs`
  allocate every entry in the file and then decline to process the ones past the
  cap. Measured on a 63.8MB target holding 2,163,704 entries, which is INSIDE
  `TARGET_CAP` and therefore admitted: peak RSS 1.24GB after the caps landed,
  roughly 19x the file. The skip message on `TARGET_CAP` tells the operator a
  target costs "several times its size", and 19x is not what a reader takes from
  that. The fix is making `entries()` a generator; it was not bundled with a
  security round because every caller indexes the returned array.
  (self-review, 2026-08-17; corroborated Medium — security review round 10,
  2026-08-17, the only finding it rated above Low)

- **`MAX_FROM` drops the tail, it does not sample.** A referent named by 5,000
  entries reports the first 64 and `+4936 more`. The count is honest and the
  selection is not representative: the 64 shown are the 64 that parsed first,
  which on a file ordered by topic means one section's worth. An operator
  chasing where a referent came from gets a biased slice with no marker saying
  so beyond the remainder count. Reservoir-sampling the list would fix the bias
  and cost the stable ordering that makes two runs diffable.
  (self-review, 2026-08-17)

- **`writeStdout` is a convention at two sinks, and nothing enforces it.**
  Identical shape to the `safeField` entry above. The `--json` sinks in all
  three scripts now flush before `process.exit`, but every other `console.log`
  is still async-on-a-pipe and safe only because a text report ends by falling
  off the end of the module. A future `process.exit()` added after any of them
  reintroduces the truncation, silently and with exit status 0. No lint rule,
  no wrapper, no test outside the one `dead.mjs` case.
  (self-review, 2026-08-17)

- **The pipe regression check covers `dead.mjs` only.** `stale.mjs` and
  `measure.mjs` carry the same pattern and are not exercised: pushing
  `stale.mjs` past 64KB needs ~400 entries at two `git log` spawns each, which
  is a benchmark rather than a smoke test. On a real 439-file repo `stale.mjs`
  DID cross the boundary (83,136 bytes) and `measure.mjs` did not (3,336), so
  the untested half is not the hypothetical half. Deleting `writeStdout` from
  either script still passes the suite. (self-review, 2026-08-17)

- **`writeStdout` cannot reject, so a genuine write failure still exits 0.**
  The promise has no reject path: any error reaching `process.stdout.write`'s
  callback is swallowed and the `process.exit(0)` behind it fires anyway. That
  is deliberate — it reproduces what `console.log` did, so `| head` closing the
  pipe does not become an unhandled rejection — but it means an `ENOSPC` on a
  `>` redirect produces a truncated document with a success status and no
  diagnostic, which is the exact shape of the bug the helper was written to fix.
  Narrow: the redirect target is the operator's choice and unreachable by a
  hostile repo, so it sits outside this tool's threat model. The fix is to
  distinguish EPIPE (swallow, as now) from every other write error (stderr line,
  non-zero exit). (security review round 10, 2026-08-17)

- **`test/smoke.mjs` builds an `sh -c` command by interpolation, not arguments.**
  `JSON.stringify` escapes `"` and backslash and leaves `$` and backticks alone,
  so the quoting is incidental rather than principled. Not exploitable: both
  interpolated values are internally generated — this repo's own script path and
  an `mkdtempSync` name — and this file never sees a third-party repo's content.
  Left because the shape is what matters, and the fix is one line:
  `sh -c '... "$1" ... "$2"' -- "$dead" "$root"`.
  (security review round 10, 2026-08-17)

## Enumeration

- **A symlink is dropped with no line saying so.** (security + privacy review of
  the enumeration change, 2026-08-19) Both reviewers independently found that
  the first cut of the git enumeration used `statSync`, which FOLLOWS a link —
  and git lists a tracked symlink exactly like a file, so a link into the
  gitignored tree bypassed the whole fix while the suite stayed green. Fixed
  with `lstatSync` + skip, matching what the Dirent-based walk always did. The
  residue is the skip itself: a repo that reaches a real doc through a symlink
  loses it from the scan and is told nothing. **Do not "fix" this by following
  the link and re-checking the target against `.gitignore`** — that is a second
  ignore evaluation written by us, on the resolved path, and getting it wrong
  fails in the direction that reads the file. If it is ever wanted, the shape is
  `git check-ignore` on the resolved target plus a containment check, and it
  needs its own canary test through a link.
- **The symlink tests do not run where symlinks cannot be created.** (same
  review, 2026-08-19) An unprivileged Windows account cannot make one, so phase
  8 prints a SKIP and covers nothing about links there. The skip is loud
  because the alternative — four checks silently not running — is
  indistinguishable from four checks passing.

- **A well-formed `ignore` entry naming a path that does not exist is still a
  silent no-op.** (found fixing the gitignore defect, 2026-08-19) `loadConfig`
  now rejects every shape that CANNOT match — glob, absolute, backslash, `..`,
  empty, padded — but `web/test-resluts` passes all of them and excludes
  nothing, which is the same failure one level in. It is detectable, unlike the
  shapes above: after `listFiles` has run, an entry whose `names` member matches
  no segment and whose `paths` member prefixes no path matched nothing, and a
  one-line stderr note naming it would close this. Not done here because the
  check belongs after enumeration rather than at config load, and wiring a
  load-time validator to a post-enumeration fact is a bigger change than the
  defect it closes. **Do not turn it into an error** — a repo legitimately
  carries an `ignore` entry for a directory it has not created yet, or one
  that exists only on another branch.

- **Only one of the five fallback branches is tested.** (found fixing the
  gitignore defect, 2026-08-19) `gitEnumerate` returns null — and the plain walk
  runs — on a non-git root, a missing git binary, a root below the work tree's
  toplevel, a listing past `GIT_LIST_BUFFER`, and any other git failure.
  `test/smoke.mjs` exercises the first only. The toplevel one is the one worth
  covering: it is reachable by an ordinary `--root web` on a monorepo, and it is
  the branch whose absence would be least visible, because the walk still
  produces a plausible-looking report. The other three need a doctored PATH, an
  800,000-file fixture and a fault injector respectively, and are not worth it.

- **`gitIgnoringPrefix` only knows about ignored paths that exist on disk.**
  (found fixing the gitignore defect, 2026-08-19) The ignored set comes from
  `git ls-files --others --ignored --directory`, which lists what is PRESENT
  and ignored. So a referent naming a gitignored file that has since been
  deleted reports `PATH-MISSING` rather than `PATH-NOT-SCANNED`. That is the
  literally true answer — the file really is gone — but the reason the tool
  gives for knowing it is not the reason it actually has, and if the parent
  directory still exists the prefix walk covers it while a fully-removed tree
  does not. `git check-ignore --stdin -z` over the unresolved referents would
  answer exactly, in one child process. Low value: the verdict is already
  correct in both cases.

- **The git listing is cached per root for the life of the process and never
  invalidated.** (found fixing the gitignore defect, 2026-08-19) Correct for
  three one-shot CLIs, and it is what keeps `dead.mjs` from shelling out four
  times for the same answer. Wrong the moment `lib.mjs` is imported into
  anything long-lived — a watcher, a language server, a test harness that
  mutates a fixture between calls — where it would serve a listing from before
  the mutation. Nothing warns. If that use ever arrives, key the cache on the
  index mtime or expose a reset.

- **Personal data that was never gitignored and never named in `ignore` is still
  read, and this is permanent.** (2026-08-19) Honouring `.gitignore` closes the
  case where a repo's only control was that one line — measured at 149 files on
  one real repo. It does nothing for a directory of client records that was
  simply committed, and there is no property of such a file that distinguishes
  it from source. Stated in `README.md` and `SKILL.md` as a non-goal rather than
  left to be inferred. **Do not file a heuristic for it** — a scanner guessing at
  which committed files are "personal" would be wrong in both directions and
  would make the honest limit above read as covered.

## Completed

The five most recent. Everything older moved to `TODOS-DONE.md` when this file
crossed the 50,000-byte split threshold the tool itself reports; the constraints
those entries still impose were lifted into `CLAUDE.md` on the way out.

- **A referent written as a call was answered with a fact about punctuation.**
  `safeField()` in this repo's own file reported ABSENT against 22 call sites, and
  `process.exit()` reported COMMENT-ONLY — a probable tombstone — because the only
  literal empty-paren `process.exit()` in the tree sits in a `lib.mjs` docblock
  while every real call carries an argument. One line explains it: `NOT_A_PATH`
  contains an open paren, so every call form leaves `classifyReferent` through
  that branch with its needle untouched, and the empty-paren strip that was
  already written for this sat on the final return, where a string containing
  parens can never arrive. Dead code reading as coverage.

  The strip now lives in `symbolNeedle` and both returns use it, and it keeps the
  OPENING paren: searching for safeField( matches the definition and every call
  site, where the bare name would match reopen for open. Measured across the 11
  deferred-work files on hand in 10 repos — 2,878 distinct referents, 86 of them
  call form in 9 of the 10: **31 verdicts change and every one is a call form.**
  COMMENT-ONLY 21 -> 4, ABSENT 16 -> 4, DOC-ONLY 2 -> 0, and the 8 survivors are
  the genuine tombstones. The before and after runs are taken back to back per
  repo, because an earlier pair drifted when one corpus repo committed to its own
  deferred-work file between them — the first comparison showed 6 phantom row
  changes that had nothing to do with the fix. **The bare-name variant was
  measured and rejected:** it flips sql(), open() and fstat() to CODE on a
  substring of something unrelated, which is a dead thing reported as alive.

  Proven by regression rather than by assertion: with `symbolNeedle` stubbed to
  the identity, 2 checks go red. The negative control is the half that matters —
  a call form whose only occurrence is a tombstone comment stays COMMENT-ONLY
  with and without the fix, so a change that reported every call form as alive
  could not pass. Suite 125 -> 140 checks. Deferrals in
  `## Referent classification` above.

- **SHIPPED 2026-08-19 — the scan asks git what is in the repo, so `.gitignore`
  is honoured; and an `ignore` entry that cannot match is now an error instead of
  silence.** Three defects, filed against this tool from the repo it was pointed
  at. (1) *`walkFiles` was a bare `readdirSync` recursion that consulted nothing
  but its own `ignore` list.* On a client repo whose `interview/` directory holds
  recordings, transcripts and a customer CSV export — protected by one
  `.gitignore` line — the walk read **149 of those files** on default config;
  measured before and after, the git enumeration reads **0**. `listFiles` now
  takes the file set from `git ls-files --cached --others --exclude-standard -z`
  when the root is the toplevel of a work tree, so every `.gitignore` at every
  depth applies along with `.git/info/exclude` and the global excludes file.
  `-z` is load-bearing rather than tidy: without it git quotes any non-ASCII
  path, and a repo that is bilingual by intent would have hit that on its first
  Greek filename. Nothing here parses gitignore syntax — the semantics are not
  small, and a parser that gets one of them wrong fails in the direction that
  reads the file it was meant to skip. (2) *A multi-segment `ignore` entry
  matched nothing, at any depth, in silence.* `web/test-results` was compared
  against basenames and sat in `.todokeeper.json` reading exactly like
  protection. `ignore` now takes two shapes through one compiled matcher —
  a bare name at any depth, a `/`-bearing name as a root-anchored path prefix —
  and the SAME matcher serves both the enumeration and `ignoringSegment`, which
  is what stops the two disagreeing and reporting an unindexed file as
  `PATH-MISSING`. (3) *No pattern syntax, also silently.* Dissolved rather than
  built: `*.log` and `.env.*` are `.gitignore`'s job and it does them correctly,
  so a glob in `ignore` is now rejected at load, by name, with a message saying
  where to put it — as are an absolute path, a backslash, `..`, and an empty or
  padded entry. A fourth, unfiled bug fell out of the rewrite: a tracked file
  deleted from disk is still in git's index, so each listed path is stat'ed
  before it enters the index, and an entry naming it no longer reads as
  resolved.

  `PATH-NOT-SCANNED` carries a third provenance, `gitignore`, kept separate from
  `config` because the two send a reader to different files — and checked AFTER
  the `ignore` list so `node_modules`, which is both a todokeeper default and
  gitignored nearly everywhere, keeps its quiet bucket instead of drowning the
  loud one. Both reports name the enumeration mode every run: a downgrade to the
  plain walk is announced, because a report that does not say which mode it ran
  in claims a coverage it may not have.

  Proven by regression, three times, rather than by assertion: with
  `gitEnumerate` stubbed to null 9 checks red including the canary; with the
  path-prefix arm removed 3 red; with `ignoreEntryProblem` stubbed 7 red. The
  canary pair is the shape that matters — a string inside the gitignored file
  and a string inside a scanned one, asserted absent and present in the same
  `--json` output, so neither half can pass on an empty scan. Suite 90 -> 125
  checks. Deferrals in `## Enumeration` above.


- **The leading-slash carve-out is gone; a leading slash now resolves against the
  tree instead of being guessed from shape.** `classifyReferent` called a leading
  slash a site route only when the string carried no known extension, so every
  URL that carried one — `/el/index.html`, in a note about which pages an audit
  config covers — fell through to the path branch and out as PATH-MISSING. The
  filed entry deferred the fix because "someone who writes `/package.json`
  meaning repo-root would go newly silent", and that objection is what the shape
  test could not answer. Resolving answers it: the branch is now conditional on
  the file EXISTING, not on how it is written, so the repo-root convention keeps
  working in a repo that has the file and nothing goes newly silent except a
  leading-slash path that is genuinely deleted. Re-measured on the same corpus,
  now 6,384 backticked spans across 10 repos: 136 distinct leading-slash
  referents, 128 already `route`, 4 `prose`, 4 `path` — and all 4 of the `path`
  ones false alarms. (The filed entry said 133 and 2; PR #1 grew the corpus by
  quoting two more of them as its own evidence.) After: 132 `route`, 4 `prose`,
  **zero** `path`. Exactly 5 occurrences / 4 distinct referents change in the
  whole corpus and nothing else moves; missing-path occurrences 132 → 127, and
  this repo's own report 11 → 9.
  **Two limits, written down because the diff cannot show them.** (1) The guard
  matches FILES only, never directories: one corpus referent is a slash-command
  name that shares a name with a root directory, and matching directories turned
  it into a resolved path. Slash commands and site routes
  both look exactly like a root-directory reference and vastly outnumber it, so
  a repo-root DIRECTORY written with a leading slash stays `route` — a known
  miss, in the quiet direction. (2) The guard's positive branch fires nowhere in
  the corpus, so `test/smoke.mjs` is its only coverage; the three cases added
  there (`/el/index.html` → route, `/src/app.ts` → path with `resolved` asserted,
  `/docs` → route) were confirmed to fail against the old classifier before they
  were kept.
  (measured across 11 deferred-work files in 10 repos, 2026-08-19)

- **One High finding, and proving it uncovered a second bug that nine rounds of
  review had read straight past.** (1) *`dead.mjs` never imported `MAX_ENTRIES`.*
  `stale.mjs` did; the asymmetry stayed invisible for two rounds because
  `MAX_REFERENTS` reads like the whole cap and is not — it bounds DISTINCT
  referents, while the per-referent `from` provenance array accrued one record
  per (entry, referent) pair. The reviewer's stated mechanism was one entry
  repeating a referent; measured, that gives `from=1` in 0.25s, because
  `referentsIn` returns a Set and referents dedupe within an entry. The real
  vector is across entries. Reproduced on a 63.8MB target — inside `TARGET_CAP`,
  admitted, 2,163,704 entries each naming the same one missing file: 7.07s,
  1.41GB RSS, and a SINGLE stdout line of 50,817,797 bytes for ONE referent.
  Fixed with `MAX_ENTRIES` in the entry loop (parity with `stale.mjs`) and a new
  `MAX_FROM = 64` bounding the list while `fromTotal` keeps the true count —
  5.8x the largest `from` measured across four real repos (11, 4, 1, 1). Same
  input after: 4.59s, 1.24GB RSS, longest line 1,230 bytes, both caps announced
  on stderr and in the report. (2) *`console.log` followed by `process.exit(0)`
  truncates on a PIPE.* Found while proving (1): the cap-removal proof failed as
  a `JSON.parse` SyntaxError instead of clean check failures, and chasing that
  showed the child exiting 0 with a partial document and no error anywhere.
  Node's stdout is synchronous for a file or TTY and ASYNCHRONOUS for a pipe, so
  `process.exit()` discards the buffer. On a real 439-file repo,
  `dead.mjs --json | cat` delivered exactly 65,536 bytes — one pipe buffer — of a
  596,029-byte document, and `stale.mjs --json | cat` the same 65,536 of 83,136;
  both invalid JSON, both exit 0. Redirecting to a FILE gave the whole document,
  which is why nine rounds missed it: every hand-check had used `>`. Raising
  `maxBuffer` to 64MB changed nothing — it was never a `maxBuffer` problem. All
  three `--json` sinks now `await writeStdout(...)`, where the await matters as
  much as the flush: it suspends the module so the text report cannot run before
  the exit. After: pipe and file byte counts match on all three scripts across
  three real repos, all valid JSON. A new smoke phase pipes a 139KB fixture
  through `cat` and asserts parse, byte-equality and referent count, with a
  precondition check that the fixture actually exceeds 64KiB; reverting the fix
  makes it fail at exactly 65,536. Suite 77 -> 80 checks, 0.91s.
  (security review round 9, 2026-08-17)

- **Six findings, and three of them were bypasses of guards this same repo had
  just installed.** (1) *A suppression check disagreed with the walk it was
  checking.* `walkFiles` skips `skip.has(item.name)` at EVERY depth, so
  `ignore: ["internal"]` removes `src/internal/auth.ts`; `ignoringSegment` asked
  only about segment 0, so the same file came back `PATH-MISSING`,
  `ignored:false` — the tool asserting a file that exists on disk does not. This
  is the provenance bucket from round 7 being walked straight around: put the
  directory anywhere but first and the quiet bucket is skipped for the loud one.
  Reproduced before, and after the fix the same repo reports `PATH-NOT-SCANNED`
  with `ignoredByConfig:true`. (2) *`MAX_ENTRIES` never bounded the second
  child.* `stale.mjs` spawns one `git log -S` per distinct entry needle AND one
  `git log` per distinct resolved referent path, and referents-per-entry has no
  bound — one entry naming 1,200 resolving referents spawned 1,201 children with
  the entry counter at 1. `pathCache` is now capped at `MAX_REFERENTS`, with the
  drop count on stderr, in the report and in `--json`; proven against a
  5,010-referent fixture — 5,000 dated, 10 announced, 26.49s. The cap docblock
  and the README both claimed entry count bounded process count; both were
  corrected in the same commit. (3) *`safe()` deliberately passes the bytes that
  forge a report line.* It strips C0 and C1 but leaves tab, LF and CR, which is
  right for a multi-line body and wrong for every single-line print sink — and
  round 5's own entry stated the threat correctly while drawing the opposite
  conclusion, since "redraw a SUSPECT finding to look clean" needs a bare
  CARRIAGE RETURN and no ESC anywhere. Measured sinks: a FILENAME, a `targets`
  config entry, a git commit SUBJECT. New `safeField` escapes tab/LF/CR plus the
  bidi overrides (U+202A–U+202E, U+2066–2069 — included for rendering
  manipulation, not for category) at 39 sites across the four scripts. Verified:
  a filename carrying CR/LF that previously forged an `ABSENT (0)` line now
  prints its escapes literally. (4) *Pathspec magic in a git argument.* Both git
  children took referent strings as pathspecs, so a tracked file named
  `:(exclude)src/z.ts` steered the date lookup. `--literal-pathspecs` fixes it —
  but it is a git GLOBAL option: the review's suggested `git log
  --literal-pathspecs` exits `fatal: unrecognized argument` (git 2.34.1), which
  `lastCommitTouching` catches and returns as `null`, silently disabling every
  commit lookup in the tool. Placed before the subcommand and verified in both
  directions. (5) *Classification cost was per occurrence.* Memoised on the raw
  string in `dead.mjs`, and skipped entirely once `seen.size` reaches
  `MAX_REFERENTS`. The review measured the resolving form and reported 1.77s;
  that input does not reproduce — an exact index hit short-circuits the
  same-basename filter, so 30,000 classifications of `a/x.ts` cost 0.015s and
  only the MISS is expensive, 1.61s against 3,001 files named `x.ts`. Measured
  improvement on the shape that actually costs: 30k non-resolving 1.18s → 0.65s,
  100k 2.58s → 0.77s. (6) *An empty word-list entry matched everything.*
  `checkWordList` bounded length and count but not emptiness; `""` in
  `inlineDoneMarkers` hits at every index of every line — 0.95s → 10.5s ASCII and
  23.7s Greek on a 20MB target. Now rejected by name. 71/71 smoke checks after
  every change. (security review round 8, 2026-08-17)
