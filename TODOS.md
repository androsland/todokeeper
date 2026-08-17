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

- **Nothing tests the scripts.** They have been run against five real repos and
  their output read by hand, which caught seven classes of false positive, but
  there is no fixture repo and no assertion. A fixture with a known-answer
  TODOS.md would let the classifier change without re-reading five repos.
  (2026-08-16)

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

- **The 256MB read budget in `dead.mjs` is a guess, not a measurement.** It was
  chosen to sit below a default Node heap; nothing measured what the scanned
  repos actually peak at, so the headroom is unknown in both directions. No repo
  has hit it, which also means the truncation path and its stderr warning have
  never run outside a synthetic test.
  (2026-08-17)

## Completed

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
