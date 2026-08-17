# TODOS

Deferred work for todokeeper itself. It is also the plugin's own test fixture —
run the three scripts against this repo and they should report something sane.

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

## Comment detection

- **`scanFile` does not parse string literals.** A needle inside a quoted string
  following a `//` on the same line — a URL in code is the common case — is
  misread as commented. Errs toward reporting a live referent as COMMENT-ONLY,
  which is a false alarm rather than a hidden tombstone, so it is tolerable but
  not correct. A real fix needs a per-language tokenizer.
  (known at design time, 2026-08-16)

## Coverage

- **`entryStyles` names three shapes and a repo outside them cannot be
  configured into working.** A deferred-work file written as a table, or as a
  checklist inside a table cell, reports 0 entries per section while still
  measuring bytes correctly. Since config no longer takes a regex, the fix for a
  fourth shape is a new entry in `ENTRY_STYLES`, not a setting — deliberate, but
  it means every new shape is a release. `numbered` and `bold-lead` were added
  when the regex went away and are exercised only by hand.
  (2026-08-16, revised 2026-08-17)

- **`test/smoke.mjs` covers the branches, not the answers.** It executes every
  `classifyReferent` branch and runs all four scripts end to end against a
  fixture, which is what a rename that broke the glob branch needed and did not
  have. What it still does not do: assert that any verdict is CORRECT. The
  fixture is checked for well-formedness, so a change that reclassified every
  symbol as prose passes it. That is still caught only by diffing `--json`
  against real repos by hand, which is the step this entry has not yet replaced.
  It also skips both count caps deliberately — reaching them costs 8.2s and 39s,
  which is a benchmark, not a smoke test, so nothing would notice if a cap were
  deleted. (2026-08-16, narrowed 2026-08-17)

- **`suspect` is only as good as the git history it reads.** It was unexercised
  entirely until a repo with month-old entries was tested — the first test repo's
  entries were all written the same week, so the code path returned zero every
  time and looked like it worked.
  (2026-08-16)

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

- **The 256MB read budget in `dead.mjs` is a guess, not a measurement.** It was
  chosen to sit below a default Node heap; nothing measured what the scanned
  repos actually peak at, so the headroom is unknown in both directions. No repo
  has hit it, which also means the truncation path and its stderr warning have
  never run outside a synthetic test.
  (2026-08-17)

## Completed

- **The control-byte scan found a literal ESC in its own docblock on the first
  run.** The phase asserts zero non-layout control bytes (C0 minus tab/LF/CR,
  DEL, and C1 arriving as its `0xC2` UTF-8 lead) across the four `scripts/*.mjs`
  and the suite itself. Its first run reported `0x1b at line 260` — inside the
  comment explaining why literal control bytes are a defect, where `^[` had been
  typed as caret notation and landed as one raw ESC. That is the fourth instance
  of the same editing-tool behaviour in this repo and the first one a machine
  caught rather than a hand-run `od`. Verified in both directions: 71/71 on the
  clean tree, and planting a `0x00` in `measure.mjs` fails the phase with
  `0x00 at line 1`. Limits are in the open entry above.
  (round 8, 2026-08-17)

- **A rename shipped broken because `node --check` resolves nothing, and the
  fix for that is the first test in this repo.** `isIgnoredPath` became
  `ignoringSegment` on the path branch of `classifyReferent`; the **glob**
  branch twelve lines above kept calling the old name. `node --check` parses
  without resolving identifiers, so all four scripts reported clean while
  `dead.mjs` and `stale.mjs` threw `ReferenceError` on any repo whose
  deferred-work file names a glob — which is most of them: a larger repo, another repo,
  a tooling repo and todokeeper itself all crashed, only a small repo (5 referents,
  no globs) survived. Every proof-of-concept for the round used a plain path, so
  no hand-run took the broken branch. Caught by diffing `--json` against five
  real repos, where four came back as **empty files**, and only because stderr
  had been discarded did that first read as a diff rather than a crash.
  `test/smoke.mjs` is the response: it executes all 13 classifier branches,
  runs all four scripts end to end, and asserts the provenance split on the glob
  branch as well as the path branch. Proven by reintroducing the exact bug —
  `node --check` still passes, the suite fails 12 checks across all four phases,
  including `dead.mjs exits 0`. Post-fix parity: 15/15 runs exit 0 and every
  verdict is byte-identical to pre-change on all five repos (1,219 / 875 / 229 /
  5 / 28 referents; 183 / 152 / 53 / 4 / 15 entries).
  (round 8, 2026-08-17)

- **Three findings: two counts that multiply were unbounded, one bucket hid its
  own provenance, and the docs made a claim that measured false.**
  (a) *Unbounded cost.* `dead.mjs` makes one pass over its whole in-budget
  corpus **per distinct referent**, so its cost is `referents × scanned-bytes` —
  a product, where every existing cap bounds a single file. Measured linear in
  both factors: at 18MB, 100/200/400/800 referents cost 0.25/0.40/0.70/1.36s; at
  400 referents, 10/20/40/80MB cost 0.36/0.71/1.41/2.86s. That is **9.03e-5 s
  per referent per MB**, a constant that predicted 8.5s for a 5,000×18MB case
  where the measurement was 8.13s. A target at `TARGET_CAP` holds ~655,000
  referents, which against `dead.mjs`'s 256MB budget is **~4.2 hours**.
  `stale.mjs` spawns one `git log -S` child per entry and was unbounded the same
  way. `MAX_REFERENTS`/`MAX_ENTRIES` now sit at 5,000, chosen from measurement
  across six real repos — largest referent count 1,219 (a larger repo), largest entry
  count 195 (another repo), and **they are different repos**, so the cap is
  4.1× and 25.6× the observed maxima and cannot fire on anything on this
  machine. Both consumers announce truncation on stderr *and* in the report.
  (b) *Provenance.* `.todokeeper.json` ships inside the repo being audited, so
  `ignore` is attacker-controlled: one commit can delete a file an entry names
  and add its directory to `ignore`, flipping `PATH-MISSING` into
  `PATH-NOT-SCANNED` — a quiet bucket that prints a count and no detail.
  Reproduced exactly. `ignoringSegment` now returns the segment rather than a
  boolean, and `ignoredBy`/`ignoredByConfig` let both reports list the referents
  the audited repo's own config excluded, separately from todokeeper's defaults.
  This does not detect suppression and cannot know intent — it fires identically
  on a repo that legitimately ignores its own `fixtures/`.
  (c) *A false claim in the shipped docs.* README and SKILL.md both said a
  hostile regex could hang the run "unstoppably" / with "no way to interrupt
  it". Measured false: `kill -INT` terminates a V8-blocked Node process in
  **9ms** on a synchronous scan loop and **4ms** on catastrophic backtracking,
  because Node's default SIGINT action is the OS-level terminate and does not
  need the event loop. The precise truth is that nothing *in Node* can interrupt
  it — no timer, signal handler or abort runs on a blocked loop — so the harm is
  a wasted run, not a wedged machine. The regex ban stands on that; the sentence
  defending it did not. Third consecutive round in which a claim this repo made
  about its own guards was falsified by testing it.
  (security review round 7, 2026-08-17)

- **Two claims about the guards were false, and a review round proved both.**
  (a) *`--json` was never affected — `JSON.stringify` escapes control bytes on
  its own.* It escapes **C0 and nothing else**. Measured: ESC and NUL come out
  escaped; DEL emits a raw `0x7F` and every C1 codepoint emits its raw UTF-8
  form (`U+009B` → `0xC2 0x9B`) — exactly the range `CONTROL_CHARS` had been
  widened to cover on purpose. One codepoint was tested and generalised to a
  range, then written into a code comment, the README and the skill. `jsonSafe`
  now escapes `U+007F–U+009F` in the serialised text at all four `--json` sinks;
  escaping rather than stripping, because `--json` exists to preserve the bytes
  and a parser decodes the escape back. Verified: 0 decoded control codepoints
  across 3 scripts × 2 modes, `JSON.parse` recovers `U+009B` and `U+007F`
  exactly, and the payload text still appears neutered so the zero is escaping
  rather than a silenced path.
  (b) *Nothing outside the repository is read.* `declaredDependencies` read
  `package.json` and `composer.json` via `join(root, file)` with no `contained()`
  — the only two reads in the tool that never had it, missed again by the commit
  that added `MANIFEST_CAP` to those exact lines. `package.json` is git-trackable
  as a symlink, so this needs no config: measured, `package.json ->
  ../outside/evil.json` let an external `dependencies` key reclassify an in-repo
  referent and drop it out of `dead.mjs`'s report, and `package.json ->
  /dev/zero` reached **3.9GB resident in ten seconds**, still climbing at the
  timeout. A size cap cannot bound that — a device stats at size 0 — so the read
  is now gated on `contained()` **and** `isFile()`, the latter added to
  `readTarget` and `loadConfig` too. After: the `/dev/zero` case exits 0 in 0.04s
  at 49MB, the escaping symlink produces output identical to having no manifest
  at all, and an in-repo symlinked manifest still resolves. Parity across two
  real repos: a small repo byte-identical on all three scripts; todokeeper's
  self-scan differs only in line numbers and three sample strings, verdicts
  unchanged at 22 referents.
  (security review round 6, 2026-08-17)

- **An auditing tool printed repo-controlled escape sequences straight to the
  terminal, and read its own target with no cap at all.** Two findings, one
  fix each. (1) Headings, entry leads, matched source lines and git commit
  SUBJECTS all reached `console.log` raw: an OSC-0 sequence planted in each
  arrived as 0x1B from all three scripts, verified. For an auditing tool that
  is worse than for an ordinary CLI — cursor and erase sequences let a hostile
  repo redraw a `SUSPECT` finding to look clean, and OSC 52 reaches the
  operator's clipboard. The commit-subject path needs no edit to the
  deferred-work file at all: a contributor commits an ordinary change to any
  file the file happens to reference and puts the payload in the subject.
  `safe()` now strips C0 and C1 at every human-readable print sink; `--json`
  was never affected, because `JSON.stringify` escapes control bytes on its
  own. Controls, never a charset — Greek, German and emoji are untouched, for
  the same reason non-ASCII stays legal in the word lists. (2) `dead.mjs`
  capped every file in its repo-wide walk and then read its own target
  uncapped twenty lines later; `measure.mjs` and `stale.mjs` did the same.
  Measured, not argued: a 53.7MB target parses correctly in 1.54s but holds
  490MB resident, ~9× the file, and under `--max-old-space-size=128` it exits
  `FATAL ERROR: Reached heap limit` with a native stack — the same
  crash-with-no-actionable-line already rejected for `splitThresholdBytes`.
  `TARGET_CAP` is 64MB, ~247× the largest real deferred-work file seen (259KB)
  and just above a case proven to complete, and it skips-and-announces per
  file like `dead.mjs` rather than refusing the run. The skip is on stdout as
  well as stderr, because it changes the total, the completed mass and the
  threshold verdict. `MANIFEST_CAP` (1MB) closes the same hole in
  `.todokeeper.json`, `package.json` and `composer.json` — a `try/catch`
  cannot catch an OOM, so the check is before the read. Verified: 0 raw ESC
  bytes from all three scripts on all three PoC repos with the SUSPECT path
  still firing, and every verdict, status and number byte-identical across
  both test repos. (security review, 2026-08-17)

- **The cap counted code units, the docs quoted an ASCII benchmark, and the two
  are ~40× apart.** `checkWordList` bounds `completedHeadings` at 100 × 64, but
  `toLowerCase()` cost per unit is not uniform: at the identical cap against
  5,000 headings, ASCII is 14ms, German 20ms, Greek and Cyrillic ~71ms, astral
  143ms, and U+0130 602ms — V8 leaves its fast Latin1 path above Latin1 and
  leaves even ICU for U+0130's special-casing exception. The cap held; the
  README's justification did not, because it quoted only the ASCII figure and
  read as though the ceiling were near it. Rejecting non-ASCII was considered
  and refused — a Greek or German heading word is a legitimate config and most
  of the reason to prefer a word list over a pattern — so the fix is the honest
  number in all three artefacts. Closed alongside it: unknown-key rejection used
  `k in DEFAULTS`, and `in` walks the prototype chain, so `__proto__`,
  `toString`, `constructor`, `hasOwnProperty` and `valueOf` all read as known
  keys and passed. Verified NOT prototype pollution (`JSON.parse` and spread
  both make `__proto__` an own property; `({}).polluted` stays undefined) — but
  a contract that holds for every key except five is not a contract. Now
  `Object.hasOwn`. (security review, 2026-08-17)

- **Removing the regex did not remove the cost — an unbounded word list hung a
  run for 8.7 seconds.** `isCompletedHeading` lowercases every entry of
  `completedHeadings` for every heading in every target file, so the cost is
  `headings × Σ(word lengths)` and both halves came from an untrusted config. A
  4.8MB `.todokeeper.json` (500 words × 10KB) against a 108KB file of 5,000
  headings took 8.7s; the same 500 words at 10 characters took 0.167s, which
  says the string length is the entire cost and the item count nearly free — so
  the per-word cap of 64 is the fix and the 100-item cap is a second wall.
  `targets` and `ignore` were left unbounded on purpose: one resolves each entry
  once, the other becomes a Set, and neither multiplies. Closed alongside it:
  `inlineDoneMarkers` and `splitThresholdBytes` were merged in with no type
  check at all, so a non-array crashed with a raw V8 stack trace and a string
  threshold silently reported every file as under it. Both now fail through
  `loadConfigOrExit` like every other key. (security review, 2026-08-17)

- **A repo could make todokeeper read and print files outside itself.**
  `resolveTargets` built `join(root, target)` and read it, so `"../secrets"` in
  `.todokeeper.json` escaped — and a git-tracked `TODOS.md` symlink escaped with
  no config at all, which `dead.mjs` then printed to stdout line by line. Added
  `contained()`: resolve the real path, require it under the real root, return
  the original path so display stays stable. Applied to targets, to each file
  inside a directory target, and to `.todokeeper.json` itself, whose JSON parse
  error quotes the offending bytes back. Rejections print the path rather than
  passing silently. (security review, 2026-08-17)

- **A config-supplied regex could hang a run indefinitely, and screening the
  pattern did not fix it.** `entryPattern` and `completedHeadingPattern` went
  straight to `new RegExp`; `^(\s*[-*]\s*(a+)+)$` ran past eight seconds against
  a 38-character line with nothing able to interrupt it. The first fix screened
  for that nested-quantifier shape — and `^.*.*.*.*.*.*.*.*.*.*.*.*ZZZZ$` (34
  characters, no groups, no alternation) walked through it and hung on an
  ordinary bullet line. Counting groups fails for the same reason. Recognising
  catastrophic backtracking from pattern shape is not a patchable bug, so the
  regex surface is gone: `completedHeadings` is a literal word list and
  `entryStyles` a closed set of three names, matched by two hand-written
  functions with no `new RegExp` on any config value. Verified at exact parity
  with the retired regex across 15 headings, and `measure`/`stale` output is
  byte-identical on both test repos. (security review, 2026-08-17)

- **`dead.mjs` had a per-file read cap and no total.** A repo of many small
  files cleared 2MB on every one and still exhausted the heap. Added a 256MB
  aggregate budget that announces what it skipped — a truncated scan reporting
  like a complete one would call a live referent ABSENT.
  (security review, 2026-08-17)

- **Ignored paths reported as missing.** `dist/*.html` and friends read as
  PATH-MISSING in `dead.mjs` while `stale.mjs` already handled them, because the
  `ignored` flag was checked in one script and not the other. Split into a
  PATH-NOT-SCANNED bucket in both: excluded by config is a different fact from
  absent from the repo, and conflating them reports the tool's own blind spot as
  the repo's problem. (2026-08-16)

- **Git branch names reported as missing paths.** `feat/…`, `ci/…`, `origin/main`
  — 6 of one test repo's 9 REFERENT MISSING reports were branches. Added a `ref`
  kind behind a closed prefix list, checked after index resolution so a real
  `docs/` or `test/` directory still wins, and guarded on file extension.
  (2026-08-16)

- **`## Recently shipped` read as live work.** The anchored completed-heading
  match missed it and reported 0% completed mass on a file
  with a 16KB archive. Widened with a closed qualifier list rather than
  unanchoring, because an unanchored pattern matches "Done criteria" and "Not
  completed" and would reclassify live work as finished — wrong in the direction
  that hides work. (2026-08-16)

- **Bold leads that wrap across lines matched nothing.** `git log -S` searches
  raw bytes while `leadPhrase` collapses whitespace, so every multi-line entry
  reported as uncommitted — 22 of them on the first test repo. Added
  `searchNeedle`, which returns the longest single physical line. (2026-08-16)

- **Basename referents reported as missing.** `site.ts` meaning
  `src/content/site.ts` failed `existsSync(join(root, raw))`; 35 false positives
  on the first run. Replaced with a repo file index keyed by path and by
  basename, with suffix matching so a partial path cannot match the wrong file.
  (2026-08-16)
