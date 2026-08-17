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

- **`entryPattern` is markdown-bullet shaped.** A deferred-work file written as a
  table, a checklist inside a table cell, or a numbered list is not parsed as
  entries at all — it will report 0 entries per section while still measuring
  bytes correctly. No test repo used those shapes, so this is untested rather
  than known-broken.
  (2026-08-16)

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

## Completed

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

- **`## Recently shipped` read as live work.** The anchored
  `completedHeadingPattern` missed it and reported 0% completed mass on a file
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
