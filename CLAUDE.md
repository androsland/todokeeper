# CLAUDE.md

todokeeper audits deferred-work files — `TODOS.md` and whatever else a repo
configures — in whatever repo it is pointed at. Three scripts, `dead.mjs`,
`stale.mjs` and `measure.mjs`, share `lib.mjs`.

**The audited repo is untrusted input.** Its files, its commit subjects and its
`.todokeeper.json` are all attacker-controlled, and a report is read by an
operator who will act on it. Both halves of that matter: a hostile repo can try to
hang the run or forge what the run prints.

## Load-bearing constraints

Every line here was paid for by a shipped bug or by a claim that measurement
falsified. The narrative, the numbers and the reversed decisions are in
`TODOS-DONE.md` — this is only the part that binds the next change.

### Handling the audited repo

- **Never pass a config value to `new RegExp`.** Screening the pattern was tried
  and abandoned: a shape check for nested quantifiers was walked straight through
  by a 34-character pattern with no groups and no alternation. Config matching is
  a literal word list plus a closed set of style names, matched by hand-written
  functions. Recognising catastrophic backtracking from pattern shape is not a
  patchable bug.
- **Gate every read of a repo-supplied path on `contained()` AND `isFile()`.** A
  size cap cannot bound a device: a manifest symlinked to `/dev/zero` stats at
  size 0 and reached 3.9GB resident in ten seconds. The two manifest reads were
  the ones missed twice — once when `contained()` was added everywhere else, and
  again by the commit that added a size cap to those exact lines. Assume a new
  read will be missed too unless the check is written alongside it.
- **Check a size cap before the read, never behind a `try/catch`.** A `catch`
  cannot catch an out-of-memory abort.
- **Send everything human-readable through the escaping helpers.** Headings, entry
  leads, matched source lines and git commit subjects all reach stdout, and a
  commit subject needs no edit to the deferred-work file at all. For an auditing
  tool this is worse than for an ordinary CLI: cursor and erase sequences let a
  hostile repo redraw a finding to look clean.
- **`JSON.stringify` escapes C0 and nothing else.** DEL emits raw, and every C1
  codepoint emits its raw UTF-8 form. The `--json` sinks escape `U+007F–U+009F`
  themselves; do not delete that on the theory that the serialiser covers it.
- **Reject unknown config keys with `Object.hasOwn`, never `in`.** `in` walks the
  prototype chain, so five inherited names read as known keys and passed.
- **Bound anything an untrusted config multiplies — and record which keys are
  deliberately unbounded, and why.** `targets` and `ignore` are unbounded on
  purpose: one resolves each entry once, the other becomes a Set, and neither
  multiplies. A word list does multiply, and an empty string in one matches at
  every index of every line.
- **Controls, never a charset.** Non-ASCII stays legal in config and in scanned
  text. A Greek or German heading word is a legitimate configuration, and it is
  most of the reason to prefer a word list over a pattern.

### Verdicts and reporting

- **`node --check` is not verification.** It parses without resolving
  identifiers, so a rename that missed one call site reported all four scripts
  clean while two of them threw on any repo naming a glob — four of the five
  repos tested. Run `node test/smoke.mjs`.
- **A truncated scan must announce truncation on stderr and in the report.** A
  partial scan that reports like a complete one calls a live referent dead, which
  is the one error this tool exists to prevent.
- **Excluded-by-config is a different fact from absent-from-the-repo, and every
  script must agree on it.** The audited repo's own `ignore` list can move a
  referent between those buckets, so both are reported with their provenance. The
  tool does not detect suppression and cannot know intent — it fires identically
  on a repo that legitimately ignores its own fixtures.
- **Widen a matching rule with a closed list, never by unanchoring it.** An
  unanchored completed-heading pattern matches "Done criteria" and "Not
  completed", which reclassifies live work as finished — wrong in the direction
  that hides work.
- **Resolve against the repo file index before deciding from shape.** Shape alone
  reported git branch names as missing paths; the fix is a closed prefix list
  checked *after* index resolution, so a real directory of the same name wins.
- **Cost is `referents × scanned-bytes`, a product.** Every other cap in the tool
  bounds a single file. Any new per-referent pass over the corpus multiplies, and
  the caps that bound the product are the only thing standing between a large
  target and a multi-hour run.

### Claims this repo makes about itself

- **Do not restate that a hostile regex leaves no way to interrupt the run.**
  Measured: an interrupt terminates a V8-blocked Node process in 4–9ms, because
  the default action is an OS-level terminate that does not need the event loop.
  The true statement is that nothing *inside* Node can interrupt it, so the cost
  is a wasted run rather than a wedged machine. The regex ban stands on that.
- **Quote the worst measured number, not the convenient one.** A cap justified by
  an ASCII benchmark read as though its ceiling were near that figure; the
  non-ASCII cases are up to ~40× more expensive at the identical cap.
- **Never type caret notation for a control byte into source.** It lands as the
  raw byte. Four instances in this repo, and the suite now asserts zero
  non-layout control bytes across the scripts and itself.
- **Three consecutive review rounds falsified a claim this repo made about its own
  guards.** Treat a confident sentence about a guard as unverified until it is
  measured — and prefer a shipped non-goal to a heuristic that cannot work.

## What this file is not

It is not a summary of the guards — the code and `test/smoke.mjs` are. It lists
only constraints extracted from *completed* work, so a live entry in `TODOS.md`
may impose one that never appears here. And it is not exhaustive by construction:
a constraint that no bug has yet cost anything is not in it.
