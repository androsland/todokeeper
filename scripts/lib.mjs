/**
 * Shared parsing for todokeeper's three scripts.
 *
 * Everything here is deliberately structural rather than semantic. It counts
 * bytes, splits on headings, and pulls backticked spans out of prose. It never
 * decides what an entry MEANS — that is the reading model's job, and a script
 * that guessed at it would be wrong silently.
 */

import { readFileSync, existsSync, statSync, lstatSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

/* ------------------------------------------------------------------ config */

/**
 * Defaults are what a repo gets when it has said nothing. They are tuned to be
 * boring: a threshold high enough that small files never trip it, and heading
 * patterns broad enough to match the three shapes seen in the wild (a
 * `## Completed` section, a `## Done` section, and completions marked inline).
 */
export const DEFAULTS = {
  // Which files hold deferred work. Globs are not supported on purpose — an
  // explicit list is auditable, and this list is short in every real repo.
  targets: ['TODOS.md'],

  // Bytes. Below this, one file costs less than the sync between two.
  splitThresholdBytes: 50_000,

  // Words that, at the START of a heading, mean the section holds finished work.
  // Literal and case-insensitive, matched at a word boundary, optionally after
  // one of `COMPLETED_QUALIFIERS`.
  //
  // Anchoring at the start is the load-bearing part. `Recently shipped` is a
  // real heading in a real repo and a strictly-anchored earlier version missed
  // it, reporting 0% completed mass on a file with a 16KB archive — but the fix
  // was a closed qualifier list, not a relaxation, because a word matched
  // ANYWHERE in a heading matches "Not completed" and would silently reclassify
  // live work as finished. Wrong in that direction hides work; wrong in this one
  // only understates the archive.
  completedHeadings: [
    'completed', 'complete', 'done', 'shipped',
    'archive', 'archived', 'archives', 'closed', 'landed', 'merged',
  ],

  // Markers that record a completion INSIDE a topical section, where no
  // `## Completed` heading exists to hold it. Without these the completed mass
  // reads as near-zero on a repo that never adopted a Completed section.
  inlineDoneMarkers: ['✅', '— SHIPPED', '-- SHIPPED', '~~', '[x]', 'DONE:'],

  // The vocabulary for the PER-ENTRY count, which answers a different question
  // from `inlineDoneMarkers` — see `isLeadMarkedDone`. `null` means "the same
  // words", and that is the default because the two lists agreeing is the
  // common case: measured across 205 archived entries in two files of one repo,
  // the shipped words plus that repo's own two additions caught 92 of them at
  // lead position.
  //
  // The key exists so that improving one count cannot be paid for by degrading
  // the other. Measured on the same repo: adding `**CLOSED`, `**ANSWERED`,
  // `**FIXED` and `**DONE` to `inlineDoneMarkers` — the obvious way to teach the
  // per-entry count a new word without this key — took the OCCURRENCE count
  // from 32 to 46 where all 14 new hits were prose, eleven of them inside the
  // two entries describing the gap. A repo needing a wider lead vocabulary sets
  // this instead and leaves the occurrence count alone; a repo needing a
  // NARROWER one (`DONE:` counted anywhere in a checklist, only `**SHIPPED`
  // counted at a lead) sets it too. `[]` is legal and means never fire.
  leadDoneMarkers: null,

  // How an entry starts, as a closed set of names rather than a pattern — see
  // `ENTRY_STYLES`. A leading blockquote marker is stripped before the style is
  // applied in every case, because quoting an archived entry rather than
  // deleting it is a common convention and missing it reports a 10KB archive
  // section as holding zero entries. A repo whose entries are paragraph-led
  // (`**Bold lead.** …` with no bullet) sets `["bold-lead"]`.
  entryStyles: ['bullet'],

  // Paths never scanned for referents.
  ignore: ['node_modules', 'dist', 'build', '.git', 'vendor', 'target', '.next'],
};

/* ----------------------------------------------------------- untrusted input */

/**
 * Control characters that never belong in text this tool prints, stripped at
 * every boundary where repo-controlled bytes reach a terminal.
 *
 * The three scripts print headings, entry leads, matched source lines and git
 * commit SUBJECTS — all of them bytes someone else wrote. An ESC in any of
 * them is executed by the terminal, not displayed: cursor movement and erase
 * sequences let a hostile repo rewrite this tool's own output, which for an
 * auditing tool is the whole ballgame — a SUSPECT finding can be redrawn to
 * look clean. On terminals honouring OSC 52 the same primitive reaches the
 * operator's clipboard.
 *
 * The commit-subject path is the one that matters most, and it is wider than it
 * looks: it needs no edit to the deferred-work file at all. A contributor
 * commits an ordinary change to any file the file happens to reference, puts
 * the payload in the commit SUBJECT, and `stale.mjs` prints it.
 *
 * Verified before and after: an OSC-0 sequence planted in a heading, in a
 * backticked referent and in a commit subject reached stdout as raw 0x1B from
 * all three scripts.
 *
 * This guards the human-readable path. `--json` is guarded separately by
 * `jsonSafe`, and the reason is a claim that was made here and was wrong:
 * `JSON.stringify` escapes C0 and NOTHING else. Measured — ESC (U+001B) and
 * NUL come out as their six-character JSON escape, but DEL (U+007F) emits a raw
 * 0x7F byte and every C1 codepoint emits its raw two-byte UTF-8 form
 * (U+009B becomes 0xC2 0x9B). That is exactly the range added below on
 * purpose. Testing one codepoint and generalising to the range is how the
 * hole got documented as closed.
 *
 * This strips CONTROL characters, never a character set. Tab, newline and
 * carriage return survive because they are layout; C1 (U+0080-U+009F) is
 * included because some terminals honour it as CSI/OSC and no real text uses
 * it. Greek, German and emoji are untouched, for the same reason non-ASCII is
 * allowed in the word lists: this tool is bilingual by intent, and a charset
 * restriction dressed up as a safety fix would break legitimate repos.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function safe(value) {
  return typeof value === 'string' ? value.replace(CONTROL_CHARS, '') : value;
}

/**
 * `safe()` for a value interpolated into ONE report line — which is every print
 * site in this tool.
 *
 * Letting layout through was wrong, and the docblock above stated the threat
 * correctly while drawing the opposite conclusion: "a SUSPECT finding can be
 * redrawn to look clean" is achieved by a bare CARRIAGE RETURN, with no ESC
 * anywhere. CR rewrites the line the terminal has already drawn; LF forges
 * whole additional lines. The measured sinks are not the deferred-work file's
 * prose but the parts a contributor reaches without touching it at all — a
 * FILENAME, a `targets` entry in `.todokeeper.json`, and a git commit SUBJECT,
 * which the docblock above already singles out as the widest path.
 *
 * Bidi controls ride along, and not because they are control characters —
 * U+202E and the isolates are ordinary format characters that reorder a
 * rendered line, so a referent can display as something other than what it
 * names. The defect is rendering manipulation; the category was never the point.
 *
 * Escaped rather than stripped, so the operator can see that something was
 * there. `safe()` stays correct for a genuinely multi-line body, of which this
 * tool currently prints none. `--json` stays on `jsonSafe`: `JSON.stringify`
 * already escapes tab, CR and LF, and re-escaping them here would corrupt
 * legitimate values.
 */
const FIELD_UNSAFE = /[\t\n\r\u202A-\u202E\u2066-\u2069]/g;

export function safeField(value) {
  if (typeof value !== 'string') return value;
  return safe(value).replace(
    FIELD_UNSAFE,
    (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** The bytes `JSON.stringify` leaves raw: DEL and the whole C1 block. */
const JSON_RAW_CONTROLS = /[\u007F-\u009F]/g;

/**
 * The `--json` sink. `safe()` is the wrong tool here and the difference is the
 * point: `--json` exists so a consumer can recover the repo's exact bytes, so
 * stripping them would defeat the flag rather than guard it. Escaping does
 * both — a parser decodes the six characters back to the original codepoint,
 * and a terminal that the operator dumps the output into sees six printable
 * ASCII characters instead of a CSI introducer.
 *
 * The substitution is applied to the SERIALISED text, which is safe because
 * JSON's own syntax uses no byte in this range: anything matched came out of a
 * string value, and inside a string value the escape is the canonical spelling
 * of the same character.
 *
 * This does not re-escape C0 — `JSON.stringify` already does that correctly,
 * verified rather than assumed this time.
 */
export function jsonSafe(value) {
  return JSON.stringify(value, null, 2).replace(
    JSON_RAW_CONTROLS,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * Write one payload to stdout and resolve only once it has actually left.
 *
 * `console.log(big); process.exit(0)` truncates on a pipe. Node's stdout is
 * synchronous for a file or a TTY and ASYNCHRONOUS for a pipe, and
 * `process.exit()` discards whatever is still buffered — so the consumer gets
 * a prefix, the exit status is 0, and nothing anywhere reports an error.
 * Measured on a real 439-file repo against the build that had it:
 * `dead.mjs --json | cat` delivered exactly 65,536 bytes of a 596,029-byte
 * document — one pipe buffer — and `stale.mjs --json | cat` the same 65,536 of
 * 83,136. Both were invalid JSON, both exited 0. Redirecting to a FILE gave
 * the whole document, which is precisely why this survived nine review rounds:
 * every hand-check had used `>`.
 *
 * The `await` at the call site matters as much as the flush. It suspends the
 * module, so the text report below the `--json` block does not run before the
 * exit lands.
 *
 * A FAILED write is reported twice — once to the callback below, and once as an
 * `'error'` event on the stream — and this listened for neither. Measured on
 * Node 24.17.0 against this repo:
 *
 *  - `dead.mjs --json | head -c 10` printed a 497-byte
 *    `Unhandled 'error' event` stack to stderr on 5 runs out of 5, and exited
 *    0. Closing a pipe early is what `head` is FOR, so the correct output there
 *    is nothing at all.
 *  - `measure.mjs --json > /dev/full` printed the same shape of stack, with
 *    `ENOSPC` and a `node:internal/fs/sync_write_stream` frame, and exited 1.
 *
 * So the swallow was never the whole story: resolving instead of rejecting
 * avoided an unhandled REJECTION and left an unhandled EVENT, which is worse
 * — a native stack trace, from a tool whose entire output contract is that an
 * operator can read it. Both cases now go through `failWrite`, and the two are
 * separated on the axis that matters to a caller: EPIPE is the consumer's
 * choice and exits 0 silently; anything else is a real failure and exits 3
 * with one line naming the errno.
 *
 * Non-goals, so this is not read as more than it is:
 *  - It does NOT make `console.log` safe. Every other call site in these
 *    scripts is still async-on-a-pipe; they are safe only because a text
 *    report ends by falling off the end of the module rather than by
 *    `process.exit`, and nothing enforces that a future one will. The
 *    `'error'` listener attached here is process-wide, so a `console.log`
 *    running AFTER the first `writeStdout` no longer throws a native stack —
 *    but it is still not flushed, and no script calls them in that order.
 *  - It bounds nothing. A report too large to be useful is still emitted in
 *    full; see `MAX_ENTRIES` / `MAX_REFERENTS` / `MAX_FROM` for the caps.
 *  - It does not make a partial report VALID. `EPIPE` still leaves the consumer
 *    holding a prefix; the claim is only that the tool stops adding a stack
 *    trace to it.
 *  - It says nothing about the stderr path used by `console.error`, which has
 *    the same shape — smaller payloads only. `failWrite`'s own line is the one
 *    exception, and it uses `writeSync` for exactly that reason.
 */
export function writeStdout(text) {
  return new Promise((resolve) => {
    // Attached once and never removed. The event and the callback have no
    // guaranteed order — both orders were observed while measuring — so
    // detaching inside the callback reopens the window this closes.
    //
    // It is process-wide, which is the cost: from here on, a write to stdout
    // that does NOT go through this function has its failure swallowed with no
    // stack AND no `failWrite` line. That is only safe because every call site
    // exits on the next statement, so nothing prints after this. IF YOU ADD
    // OUTPUT AFTER A `writeStdout` CALL, route it through this function too.
    if (process.stdout.listenerCount('error') === 0) process.stdout.on('error', () => {});
    process.stdout.write(text, (err) => {
      if (err && err.code !== 'EPIPE') failWrite(err);
      resolve();
    });
  });
}

/**
 * One line to stderr, then exit 3.
 *
 * Exits from inside the helper rather than reporting upward because every call
 * site is `await writeStdout(...)` followed immediately by `process.exit(0)`:
 * a `process.exitCode = 3` set here would be overwritten by the next statement,
 * and a rejection would have to be caught identically at four sites, which is
 * the shape of convention that this repo has already watched go unenforced
 * twice. Exiting cannot be forgotten by a call site added later.
 *
 * `writeSync` rather than `console.error` because the process is about to be
 * torn down: `process.stderr` is asynchronous on a pipe, and `process.exit`
 * discards its buffer — which is the bug this whole helper exists to fix, and
 * it would be absurd to reintroduce it in the line that reports it.
 *
 * 3, not 2: 2 already means "the input was unusable" at four sites. A failure
 * to WRITE the answer is a different fact from a failure to READ the question,
 * and a caller that retries should be able to tell them apart.
 */
function failWrite(err) {
  const code = typeof err?.code === 'string' ? err.code : 'unknown';
  try {
    writeSync(2, `todokeeper: could not write the report to stdout (${safeField(code)}). `
      + 'Output is incomplete.\n');
  } catch {
    // stderr is gone too. The exit status is the only channel left, and it is
    // the reason this function exists.
  }
  process.exit(3);
}

/**
 * Bytes above which a file is not read at all.
 *
 * `readFileSync(path, 'utf8')` has no ceiling of its own below V8's 537MB
 * string limit, and the allocation fails long before that: measured, a 53.7MB
 * target parses correctly in 1.54s but holds 490MB resident — roughly 9x the
 * file — so a target a few hundred MB wide exits with `FATAL ERROR: Reached
 * heap limit` and a native stack. That is the same shape as the unvalidated
 * `splitThresholdBytes`: an untrusted repo turning a bad input into a crash
 * carrying no line anyone can act on.
 *
 * `dead.mjs` already caps every OTHER file it reads (`FILE_CAP`, `TOTAL_CAP`)
 * and then read its own target uncapped a few lines later. This closes that.
 *
 * 64MB is chosen against measurement, not taste: the largest real deferred-work
 * file seen across the repos this was built on is 259KB, so the cap sits ~247x
 * above the honest ceiling, and just above a 53.7MB case proven to complete.
 *
 * NON-GOALS, stated because a cap reads as coverage:
 *  - It bounds ONE file, never the set. `targets` may name many, and N files
 *    each just under the cap still sum past memory. Nothing here totals them
 *    the way `dead.mjs` totals its repo-wide walk.
 *  - A byte cap is not a memory cap. The ~9x amplification is a property of
 *    this V8 on this machine, not a constant, so the same 64MB buys a different
 *    ceiling elsewhere.
 *  - It does not bound processing. A file well under the cap can still hold a
 *    million headings; see the standing entry in TODOS.md.
 */
export const TARGET_CAP = 64_000_000;

/**
 * The same ceiling for the small JSON files this tool reads whole:
 * `.todokeeper.json`, `package.json`, `composer.json`. All three hold a handful
 * of keys, all three ship inside the scanned repo, and all three were read with
 * no size check at all.
 *
 * A `try/catch` is not a guard here. `declaredDependencies` wraps its read in
 * one, and an out-of-memory FATAL is not a catchable exception — it ends the
 * process — so the only place to stop this is before the read. Four orders of
 * magnitude above any real manifest.
 */
export const MANIFEST_CAP = 1_000_000;

/**
 * The two COUNT caps. Every byte cap above bounds one file; these bound the two
 * dimensions that MULTIPLY against a byte cap rather than sitting beside it,
 * and they were the only combinatorial costs in this tool that nothing capped.
 *
 * `dead.mjs` scans the whole in-budget corpus once per distinct symbol
 * referent, so its cost is referents × scanned-bytes. Measured here, linear in
 * both factors: at 18MB of corpus, 100/200/400/800 referents cost
 * 0.25/0.40/0.70/1.36s; at 400 referents, 10/20/40/80MB cost
 * 0.36/0.71/1.41/2.86s. That is 9.03e-5 s per referent per MB — a constant
 * that predicted 8.5s for 5,000 referents against 18MB where the measurement
 * was 8.13s. Both factors passed every cap already in this file and their
 * PRODUCT did not: a target at `TARGET_CAP` holds roughly 655,000 referents,
 * which against a corpus at `dead.mjs`'s 256MB budget is about 4.2 hours.
 *
 * `stale.mjs` spawns one `git log -S` child per distinct entry needle, so that
 * half is linear in entry count and was unbounded the same way. It is only
 * half: `lastCommitTouching` is a SECOND child per distinct resolved referent
 * PATH, and referents-per-entry has no bound of its own — one entry naming
 * 1,200 resolving referents spawned 1,201 children with the entry counter at 1.
 * This docblock claimed entry count bounded process count, and it did not.
 * `MAX_REFERENTS` now caps `stale.mjs`'s path cache as well: 5,010 distinct
 * paths dated 5,000 and announced the 10, in 26.5s.
 *
 * 5,000 comes from measurement rather than taste, and the two dimensions were
 * measured over overlapping-but-different sets of repos, so they are quoted
 * separately rather than paired:
 *  - Referents, six repos: 1,219 (the largest, a 318KB target) then 875, 574,
 *    490, 229, 54.
 *  - Entries, six repos: 195 then 188, 113, 97, 58, 4. The
 *    largest file by bytes is NOT the one with the most entries.
 * So the cap sits at 4.1× the largest referent count and 25.6× the largest
 * entry count observed anywhere on this machine.
 *
 * Three things it deliberately does NOT do, written here so a cap is not read
 * as a fix:
 *  - It bounds the COUNT, not the cost. 5,000 referents against a 256MB corpus
 *    is still ~115 seconds, and a `stale.mjs` run that actually reaches the
 *    entry cap measured 39 seconds on a one-commit repo — more on real history,
 *    since each child's own cost grows with the log it searches. Bounded is not
 *    fast, and neither number is a promise.
 *  - It cannot tell a hostile 5,000 from an honest 5,000. A genuinely large
 *    file is truncated exactly like an attack; the announcement is the whole
 *    remedy, which is why both consumers print it on stderr AND carry it in the
 *    report rather than only one of the two.
 *  - It says nothing about the headings dimension, which multiplies against
 *    `completedHeadings` instead and has its own standing entry in TODOS.md.
 *  - `MAX_ENTRIES` shipped in `stale.mjs` and NOT in `dead.mjs`, which never
 *    imported it. The asymmetry was invisible for two rounds because
 *    `MAX_REFERENTS` reads like the whole cap for that script, and it is not:
 *    it bounds DISTINCT referents, while `from` accrues one record per
 *    (entry, referent) pair for referents already admitted. Measured on a
 *    63.8MB target — inside `TARGET_CAP` — holding 2,163,704 entries that each
 *    name the same one missing file: 7.07s, 1.41GB RSS, and a single stdout
 *    line of 50,817,797 bytes, for ONE referent. See `MAX_FROM`.
 */
export const MAX_REFERENTS = 5_000;
export const MAX_ENTRIES = 5_000;

/**
 * The provenance cap, and the reason it is separate from the two above.
 *
 * `referentsIn` returns a Set, so one entry naming the same referent a million
 * times yields one record — that shape was tested and does not reproduce. What
 * accrues is one record per (entry, distinct referent) pair, so the growth is
 * across entries, and `MAX_ENTRIES` alone does not bound it: entry 1 may name
 * 5,000 distinct referents and fill `seen`, after which each of the remaining
 * 4,999 entries pushes 5,000 more records against keys that are already there.
 * The only thing standing between that and the operator's terminal was
 * `TARGET_CAP`, which is a byte cap and admits ~5.3M pairs.
 *
 * 64 is 5.8x the largest `from` list measured on this machine: 11, then 4
 * (this repo's own self-scan), 1, 1. Storage is capped, not display truncated,
 * so a repo below the cap prints byte-identically to before — all four
 * measured repos do.
 *
 * What it does NOT do: it does not bound the report's total size, since
 * `MAX_REFERENTS` x `MAX_FROM` is still ~320,000 records; it drops the tail
 * rather than sampling, so the entries it hides are the LAST ones to name a
 * referent and not a representative set; and it says nothing about how many
 * referents a single entry may name, which is bounded only by bytes.
 */
export const MAX_FROM = 64;

/**
 * Collapse CRLF to LF. The one place newline shape is decided.
 *
 * `text.split('\n')` on a CRLF file leaves a trailing `\r` on every line, and
 * a line-oriented regex then quietly stops matching: `.` excludes `\r`, and an
 * unflagged `$` anchors at end-of-INPUT rather than end-of-line, so
 * `/^(#{1,6})\s+(.*)$/` matches nothing at all against `## Completed\r`. The
 * result was not a crash but a plausible report — zero headings, one
 * `(preamble)` section, 0.0% completed mass, and `stale.mjs` and `dead.mjs`
 * sweeping the whole archive as live work because nothing was ever classified
 * completed. Measured on a 308.9KB deferred-work file in a `core.autocrlf=true`
 * checkout: 1 section against 14, and 0.0% against 9.9%.
 *
 * Normalising HERE rather than at that regex is the point. The defect is a
 * property of every line-oriented match in the tool, not of one pattern, so
 * fixing the pattern leaves the next one to rediscover it. Downstream of this
 * function there is no `\r` to reason about.
 *
 * Two shapes it deliberately does not touch:
 *
 *  - A LONE `\r` inside heading or entry text on an otherwise-LF file. The
 *    pattern is `/\r\n/g` and never `/\r/g`, because this tool measures the
 *    file rather than edits it, and a blanket strip would silently alter the
 *    content whose bytes it then reports.
 *  - Classic-Mac BARE-CR line endings, where `\r` is the terminator and no
 *    `\n` appears at all. Such a file is one line to every splitter here and
 *    this replace does nothing for it. Not detected, by choice — `warnIfHeadingless`
 *    will at least say the file parsed to no headings. Stated as a non-goal in
 *    `README.md` rather than left to be inferred.
 */
export function normaliseNewlines(text) {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Read a whole file this tool does not control, refusing one large enough to
 * end the process instead of the read, and hand back the on-disk size along
 * with the text.
 *
 * Skip-and-announce rather than throw, matching `dead.mjs`'s repo-walk: one
 * oversized file in a `todos/` directory must not take the other four with it.
 * The caller drops a null. Silence here would be the worst outcome — a skipped
 * target reported as a measured one is a completed-mass number that is simply
 * wrong.
 *
 * The size is returned rather than re-statted by the caller because this
 * function is the one place a repo-supplied path is proven to be a contained
 * regular file. A second `statSync` somewhere else is a second path that has
 * to remember both checks, and this repo has already missed that twice.
 *
 * THIS IS THE LINE-ENDING BOUNDARY. See `normaliseNewlines`.
 */
export function readTargetMeta(path, label = path) {
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    process.stderr.write(`todokeeper: cannot stat \`${safeField(label)}\` — ${safeField(err.message)}\n`);
    return null;
  }
  // A size cap bounds a FILE, and this is the check that decides it is one.
  // `statSync` reports size 0 for a character device, a fifo and everything
  // under /proc, so any of them sails under any cap and then reads without
  // end — measured against /dev/zero at 3.9GB resident in ten seconds and
  // still climbing when the timeout killed it. `contained()` stops the usual
  // way in (a symlink out of the tree); this stops the rest.
  if (!st.isFile()) {
    process.stderr.write(
      `todokeeper: skipping \`${safeField(label)}\` — not a regular file. A device or fifo `
      + 'reports size 0 and then reads without end, so no size cap can bound it.\n',
    );
    return null;
  }
  const { size } = st;
  if (size > TARGET_CAP) {
    process.stderr.write(
      `todokeeper: skipping \`${safeField(label)}\` — ${(size / 1e6).toFixed(1)}MB is over the `
      + `${TARGET_CAP / 1e6}MB per-file cap. Reading it costs several times its size in memory `
      + 'and would end the process rather than the read. Anything below is missing this file.\n',
    );
    return null;
  }
  try {
    return { text: normaliseNewlines(readFileSync(path, 'utf8')), diskBytes: size };
  } catch (err) {
    process.stderr.write(`todokeeper: cannot read \`${safeField(label)}\` — ${safeField(err.message)}\n`);
    return null;
  }
}

/**
 * The text of a target, or null. Every caller that does not need the size.
 */
export function readTarget(path, label = path) {
  const meta = readTargetMeta(path, label);
  return meta === null ? null : meta.text;
}

/**
 * Every path this tool reads must resolve to somewhere inside the repo.
 *
 * `join(root, target)` is not containment. `..` inside a target walks out, and
 * a symlink walks out without containing a `..` at all — so a repo that ships
 * `TODOS.md` as a symlink is read from outside its own tree with no config
 * involved. That matters because `dead.mjs` prints matched file lines to
 * stdout: an escape here is an arbitrary file read with a printer attached.
 *
 * Resolve the real path and require it to sit under the real root. An in-repo
 * symlink still works — `TODOS.md -> docs/TODOS.md` resolves inside root and is
 * allowed. The ORIGINAL path is returned, not the resolved one, so the paths
 * printed to the user stay the ones they wrote.
 *
 * Returns null for anything absent, unreadable, or outside.
 */
export function contained(root, candidate) {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(candidate);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    return candidate;
  } catch {
    return null; // absent, broken symlink, or no permission
  }
}

/**
 * No pattern from `.todokeeper.json` is ever compiled, and that is a security
 * boundary rather than a simplification.
 *
 * An earlier version took `entryPattern` and `completedHeadingPattern` as
 * regexes and screened them for the shape that backtracks exponentially — an
 * unbounded quantifier wrapping a group that itself repeats or alternates,
 * `(a+)+`. That screen is not merely incomplete, it is the wrong instrument.
 * `^.*.*.*.*.*.*.*.*.*.*.*.*ZZZZ$` is 34 characters, contains no groups at all
 * and no alternation, passed every version of the screen, and hung a run past
 * eight seconds against an ordinary bullet line — no adversarial file content
 * needed, because the pattern is tested against every line of the file. Group
 * counting does not see it either. Recognising catastrophic backtracking from
 * pattern shape is a decidable-security-policy problem, not a bug to patch, and
 * nothing in Node can interrupt a regex once V8 has entered it.
 *
 * So the knobs are literal instead. `completedHeadings` is a word list and
 * `entryStyles` a closed set of names; both are matched by the two functions
 * below, whose cost is linear in the line and in the list. Every shape the two
 * shipped defaults expressed is still expressible, and a repo that needs a
 * genuinely new bullet shape gets a new entry in `ENTRY_STYLES` rather than a
 * regex. What is lost is arbitrary matching — see the non-goals in README.md.
 */

/** Words that may precede a completed-heading word. Closed on purpose. */
const COMPLETED_QUALIFIERS = ['recently', 'previously', 'already'];

/**
 * Does this heading open a section of finished work?
 *
 * Anchored: the word must start the heading, optionally after one qualifier.
 * That is what keeps `Not completed` out — the completed word is present but
 * does not start the heading.
 *
 * What anchoring does NOT keep out is a heading that STARTS with a completed
 * word and goes on to mean something else: `Done criteria` matches, and reads
 * as an archive. The regex this replaced had the same behaviour, so it is a
 * standing limit rather than a regression, and it errs toward understating live
 * work rather than hiding it. The word boundary only stops a longer word —
 * `Doneness` and `Archiver notes` do not match.
 */
export function isCompletedHeading(heading, words) {
  if (typeof heading !== 'string') return false;
  let text = heading.trim().toLowerCase();
  for (const q of COMPLETED_QUALIFIERS) {
    if (text.startsWith(q) && /\s/.test(text[q.length] ?? '')) {
      text = text.slice(q.length).trimStart();
      break;
    }
  }
  for (const word of words) {
    const w = String(word).toLowerCase();
    if (!w || !text.startsWith(w)) continue;
    // `\b`: the next character must not continue the word. Checking rather than
    // returning false lets `complete` sit before `completed` in the list
    // without shadowing it.
    const next = text[w.length];
    if (next === undefined || !/[a-z0-9_]/.test(next)) return true;
  }
  return false;
}

/**
 * How a repo writes the first line of an entry. Each test runs on the line with
 * any blockquote prefix and up to one leading space already removed.
 */
const ENTRY_STYLES = {
  bullet: (s) => /^[-*+][ \t]/.test(s),
  numbered: (s) => /^\d{1,9}[.)][ \t]/.test(s),
  'bold-lead': (s) => s.startsWith('**'),
};

export const ENTRY_STYLE_NAMES = Object.keys(ENTRY_STYLES);

const QUOTE_PREFIX = /^(\s*>\s?)+/;

/**
 * Is this line the start of a new entry?
 *
 * Indent is measured AFTER stripping blockquote markers, so `> - **x**` reads
 * as a top-level entry rather than a nested one, and more than one space of
 * indent means a nested bullet continuing the entry above.
 */
export function isEntryStart(line, styles) {
  const quoted = QUOTE_PREFIX.exec(line);
  const rest = quoted ? line.slice(quoted[0].length) : line;
  const indent = /^[ \t]*/.exec(rest)[0].length;
  if (indent > 1) return false;
  const body = rest.slice(indent);
  for (const name of styles) {
    const test = ENTRY_STYLES[name];
    if (test && test(body)) return true;
  }
  return false;
}

/**
 * Bounds on the two word lists, and why only these two carry them.
 *
 * `isCompletedHeading` lowercases every word in `completedHeadings` for every
 * heading in every target file, so its cost is `headings × Σ(word lengths)` —
 * the one place in this tool where two attacker-controlled dimensions multiply.
 * Measured: 500 words of 10KB against 5,000 headings takes 8.7s; the same 500
 * words at 10 characters each takes 0.167s. The ARRAY length is nearly free and
 * the STRING length is the whole cost, so the per-word cap is the half that
 * matters and the item cap is a second wall rather than the fix.
 *
 * The cap counts UTF-16 code units, and cost per unit is not uniform — so the
 * ceiling is a range, not a number. At the full 100 x 64, against the same
 * 5,000 headings: ASCII 14ms, German 20ms, Greek and Cyrillic ~71ms, astral
 * 143ms, and U+0130 (Turkish dotted capital I) 602ms, a ~40x spread, because
 * V8 leaves its fast Latin1 lowercasing path for anything above it and leaves
 * even the ICU path for U+0130's SpecialCasing exception. Non-ASCII is NOT
 * rejected: a Greek or German heading word is a legitimate config and the whole
 * point of a word list over a pattern, and the worst case a hostile config can
 * buy is still sub-second and still linear. The honest ceiling is 602ms, not
 * the 14ms an ASCII-only benchmark would suggest.
 *
 * `targets` and `ignore` are deliberately left unbounded: one resolves each
 * entry once and the other becomes a Set, so a long list costs time in
 * proportion to what the author wrote and multiplies against nothing.
 * `inlineDoneMarkers` is bounded here for symmetry, not for a measured need —
 * it reaches `String.prototype.split`, which stayed under 2s even at 40MB.
 * `leadDoneMarkers` gets the same bounds when it is set, on the same reasoning:
 * it multiplies against ENTRY COUNT rather than section bytes, so it is the
 * cheaper of the two, and being cheaper than a bounded thing is not a bound.
 */
const MAX_LIST_ITEMS = 100;
const MAX_LIST_ITEM_CHARS = 64;

function checkWordList(key, value) {
  if (!Array.isArray(value) || value.some((t) => typeof t !== 'string')) {
    throw new Error(`.todokeeper.json: \`${key}\` must be an array of strings`);
  }
  if (value.length > MAX_LIST_ITEMS) {
    throw new Error(
      `.todokeeper.json: \`${key}\` has ${value.length} entries; the limit is ${MAX_LIST_ITEMS}.`,
    );
  }
  // An empty string is not a word, and it is not inert: `measure.mjs` counts
  // inline markers with `body.split(marker)`, which on '' returns one string
  // PER CHARACTER. A 20MB target with 100 empty markers measured 0.95s -> 10.5s
  // (ASCII) and -> 23.7s on Greek, where V8's single-character string cache
  // does not apply. `isCompletedHeading` already skipped empty words; this is
  // the same guard at the boundary, so it covers both lists at once.
  if (value.some((t) => t.length === 0)) {
    throw new Error(
      `.todokeeper.json: \`${key}\` has an empty entry. These are single words, not patterns.`,
    );
  }
  const long = value.find((t) => t.length > MAX_LIST_ITEM_CHARS);
  if (long !== undefined) {
    throw new Error(
      `.todokeeper.json: \`${key}\` has an entry of ${long.length} characters; `
      + `the limit is ${MAX_LIST_ITEM_CHARS}. These are single words, not patterns.`,
    );
  }
}

export function loadConfig(root) {
  const path = join(root, '.todokeeper.json');
  if (!existsSync(path)) return { ...DEFAULTS, _source: 'defaults' };
  // A `.todokeeper.json` symlinked out of the repo would be parsed as config,
  // and a JSON parse error quotes the offending bytes back in its message —
  // enough to read a line of any file the process can open.
  if (!contained(root, path)) {
    throw new Error('.todokeeper.json resolves outside the repository; refusing to read it');
  }
  // The word-list caps run AFTER the parse, so they cannot bound the parse
  // itself. A multi-megabyte `.todokeeper.json` is read and deserialised in
  // full before any of them is consulted — the 4.8MB config that proved the
  // word-list DoS was itself never the memory problem, but nothing stopped a
  // larger one from being.
  const st = statSync(path);
  if (!st.isFile()) {
    throw new Error('.todokeeper.json is not a regular file; refusing to read it');
  }
  if (st.size > MANIFEST_CAP) {
    throw new Error(
      `.todokeeper.json is ${(st.size / 1e6).toFixed(1)}MB; the limit is ${MANIFEST_CAP / 1e6}MB. `
      + 'This file holds a handful of keys, not data.',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // The parse error quotes the offending bytes, so this message carries
    // config-controlled text into a terminal.
    throw new Error(`.todokeeper.json is not valid JSON: ${safeField(err.message)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('.todokeeper.json must contain a JSON object');
  }
  // Unknown keys are rejected rather than ignored. Without this, a config
  // carrying `entryPattern` — the regex knob this tool deliberately no longer
  // has — would be accepted in silence and quietly run on defaults, which reads
  // as "my pattern is in effect" and is the worst of the three outcomes.
  //
  // `Object.hasOwn`, not `k in DEFAULTS`: `in` walks the prototype chain, so
  // `__proto__`, `toString`, `constructor`, `hasOwnProperty` and `valueOf` all
  // read as known keys and slipped through the check that exists to catch
  // exactly that. It was not prototype pollution — `JSON.parse` and object
  // spread both make `__proto__` an ordinary own property — but "unknown keys
  // are rejected" has to be true for every key or it is not a contract.
  const unknown = Object.keys(parsed).filter((k) => !Object.hasOwn(DEFAULTS, k));
  if (unknown.length) {
    throw new Error(
      `.todokeeper.json: unknown key(s) ${unknown.map((k) => `\`${safeField(k)}\``).join(', ')}. `
      + `Known keys: ${Object.keys(DEFAULTS).join(', ')}.`
      + (unknown.some((k) => k === 'entryPattern' || k === 'completedHeadingPattern')
        ? ' Regex config was removed on purpose — use `entryStyles` and `completedHeadings`.'
        : ''),
    );
  }
  const config = { ...DEFAULTS, ...parsed, _source: relative(root, path) };
  if (!Array.isArray(config.targets) || config.targets.some((t) => typeof t !== 'string')) {
    throw new Error('.todokeeper.json: `targets` must be an array of strings');
  }
  if (!Array.isArray(config.ignore) || config.ignore.some((t) => typeof t !== 'string')) {
    throw new Error('.todokeeper.json: `ignore` must be an array of strings');
  }
  // Every shape rejected here previously matched nothing, at any depth, in
  // silence — and a line in `ignore` that matches nothing reads exactly like
  // protection. That is the same failure the unknown-key check above exists to
  // stop, one level down: the config said something, the tool did nothing, and
  // the only signal was the absence of a signal.
  for (const entry of config.ignore) {
    const problem = ignoreEntryProblem(entry);
    if (problem) {
      throw new Error(`.todokeeper.json: \`ignore\` entry ${JSON.stringify(safeField(entry))} ${problem}`);
    }
  }
  checkWordList('completedHeadings', config.completedHeadings);
  checkWordList('inlineDoneMarkers', config.inlineDoneMarkers);
  // `null` is the default and means "reuse `inlineDoneMarkers`", so it is the
  // one non-array this key accepts. Every other shape goes through the same
  // bounds as the list it stands in for — it is matched per entry rather than
  // per section body, which is strictly less work than `inlineDoneMarkers`
  // already does, but "cheaper than the thing beside it" is not a bound.
  if (config.leadDoneMarkers !== null) checkWordList('leadDoneMarkers', config.leadDoneMarkers);
  // Unvalidated, this reached a numeric comparison and simply made `crossed`
  // always false — a config typo that silently reports every file as under the
  // threshold, which is the one answer nobody re-checks.
  if (typeof config.splitThresholdBytes !== 'number'
    || !Number.isFinite(config.splitThresholdBytes)
    || config.splitThresholdBytes < 0) {
    throw new Error('.todokeeper.json: `splitThresholdBytes` must be a non-negative number');
  }
  // Checked at load, so an unknown style names the key rather than silently
  // matching nothing and reporting every section as holding zero entries.
  if (!Array.isArray(config.entryStyles) || config.entryStyles.length === 0) {
    throw new Error('.todokeeper.json: `entryStyles` must be a non-empty array');
  }
  for (const style of config.entryStyles) {
    if (!ENTRY_STYLE_NAMES.includes(style)) {
      throw new Error(
        `.todokeeper.json: \`entryStyles\` has no style ${JSON.stringify(style)}. `
        + `Known styles: ${ENTRY_STYLE_NAMES.join(', ')}.`,
      );
    }
  }
  return config;
}

/**
 * Why an `ignore` entry cannot match anything, or null if it can.
 *
 * The glob case is the one worth spelling out, because rejecting it is a choice
 * and the obvious alternative is to implement it. `ignore` stays literal:
 * patterns belong in `.gitignore`, which `listFiles` now honours through git
 * itself, so a repo wanting `*.log` excluded already has the place to say it
 * and gets a correct implementation of the syntax rather than a second, worse
 * one here. What this cannot see is a well-formed entry naming a path that does
 * not exist — `web/test-resluts` passes every check below and excludes nothing.
 */
function ignoreEntryProblem(entry) {
  if (entry.trim() === '') {
    return 'is empty. An empty string matches nothing and reads like a rule.';
  }
  if (entry.trim() !== entry) {
    return 'has leading or trailing whitespace, which no real path segment carries.';
  }
  if (/[*?[\]]/.test(entry)) {
    return 'looks like a glob. `ignore` is a list of literal names and repo-relative '
      + 'paths on purpose — put patterns in `.gitignore`, which todokeeper reads when '
      + 'the root is a git work tree. Use `node_modules` or `web/test-results`.';
  }
  if (entry.includes('\\')) {
    return 'uses a backslash. Paths here are `/`-separated on every platform.';
  }
  if (entry.startsWith('/') || /^[A-Za-z]:\//.test(entry)) {
    return 'is an absolute path. `ignore` entries are relative to the repository root.';
  }
  if (entry.split('/').includes('..')) {
    return 'contains `..`. `ignore` entries may not climb out of the repository root.';
  }
  return null;
}

/**
 * CLI entry point for the above. A rejected pattern or a target that escapes
 * the repo is a thing the user typed, and a V8 stack trace buries the one line
 * that says which key to fix.
 */
export function loadConfigOrExit(root) {
  try {
    return loadConfig(root);
  } catch (err) {
    // Every message reaching here has passed through config-controlled text at
    // least once — a key name, a style name, a parse error quoting the bytes.
    // This is the single choke point for all of them.
    process.stderr.write(`todokeeper: ${safeField(err.message)}\n`);
    process.exit(2);
  }
}

/* -------------------------------------------------------------------- repo */

export function repoRoot(from = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: from,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return resolve(from);
  }
}

/**
 * Resolve the configured targets to files that exist. A target naming a
 * directory expands to the markdown files directly inside it, so a repo that
 * has already split into `todos/` configures `["todos"]` and not five paths.
 */
export function resolveTargets(root, config) {
  const found = [];
  for (const target of config.targets) {
    const joined = join(root, target);
    const abs = contained(root, joined);
    if (!abs) {
      // A target that exists but resolves outside was rejected, not absent, and
      // saying nothing would report an escaped file as a clean repo.
      if (existsSync(joined)) {
        process.stderr.write(`todokeeper: skipping \`${safeField(target)}\` — it resolves outside the repository\n`);
      }
      continue;
    }
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (!name.endsWith('.md')) continue;
        // The directory passed containment; a file inside it can still be a
        // symlink pointing out, so each entry is checked on its own.
        const child = contained(root, join(abs, name));
        if (child) found.push(child);
        else process.stderr.write(`todokeeper: skipping \`${safeField(target)}/${safeField(name)}\` — it resolves outside the repository\n`);
      }
    } else {
      found.push(abs);
    }
  }
  return found;
}

/* ----------------------------------------------------------------- parsing */

/**
 * Split a markdown file into sections at ATX headings, carrying each section's
 * byte length and heading depth. Fenced code blocks are skipped so a `#` inside
 * a shell snippet never opens a phantom section.
 *
 * Assumes LF-normalised input, which is what `readTargetMeta` returns. The
 * heading pattern below is `$`-anchored without the `m` flag and so matches
 * nothing on a line carrying a trailing `\r`; it is deliberately NOT hardened
 * here, because normalising once at the read boundary closes that for every
 * line-oriented match in the tool rather than for this one. A caller that
 * imports `sections` and hands it bytes from its own `readFileSync` is outside
 * that contract — run them through `normaliseNewlines` first.
 */
export function sections(text) {
  const lines = text.split('\n');
  const out = [];
  let current = { heading: null, depth: 0, start: 0, lines: [] };
  let fence = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (line.trimStart().startsWith(fence)) fence = null;
      current.lines.push(line);
      continue;
    }
    if (fence === null) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        out.push(current);
        current = { heading: heading[2].trim(), depth: heading[1].length, start: i, lines: [] };
        continue;
      }
    }
    current.lines.push(line);
  }
  out.push(current);

  return out
    .filter((s) => s.heading !== null || s.lines.some((l) => l.trim()))
    .map((s) => ({ ...s, body: s.lines.join('\n'), bytes: Buffer.byteLength(s.lines.join('\n'), 'utf8') }));
}

const HEADINGLESS_MIN_LINES = 20;

/**
 * Say so when a target parsed to no headings at all, because the number that
 * produces is plausible rather than obviously wrong.
 *
 * Completed sections are found BY heading. With none, completed mass reads
 * 0.0%, every archived entry counts as live, and nothing on stdout suggests a
 * parse problem — the failure this tool exists to prevent, aimed at itself.
 * The CRLF cause is closed upstream by `normaliseNewlines`; what remains is
 * setext headings, bare-CR line endings and files that genuinely have none, so
 * the message names those and does not repeat the one that is fixed.
 *
 * The 20-non-blank-line floor is a judgement, not a measurement: a short flat
 * deferred-work file with no headings is an ordinary way to keep one, and
 * warning about it would be noise on a legitimate configuration. Above that it
 * is worth a line of stderr. Nothing calibrated this number.
 */
export function warnIfHeadingless(secs, text, label) {
  if (secs.length !== 1 || secs[0].heading !== null) return false;
  // Split on any terminator, not just LF. A bare-CR file is ONE line to every
  // splitter downstream, so counting with `split('\\n')` would score it at 1 and
  // put the exact case this message exists to name below the floor. This split
  // counts; it does not normalise.
  const nonBlank = text.split(/\r\n|\r|\n/).filter((l) => l.trim()).length;
  if (nonBlank < HEADINGLESS_MIN_LINES) return false;
  process.stderr.write(
    `todokeeper: 0 headings matched in \`${safeField(label)}\` — ${nonBlank} non-blank lines and `
    + 'not one ATX (`#`) heading. CRLF is normalised on read, so it is not that. What is left: '
    + 'setext headings (underlined with `===` or `---`), which this tool does not parse; '
    + 'classic-Mac bare-CR line endings, which nothing here normalises; or a file that really '
    + 'has no headings. Completed sections are found by heading, so completed mass reads 0% and '
    + 'every entry counts as live.\n',
  );
  return true;
}

/**
 * Entries within a section. An entry runs from its opening bullet to the line
 * before the next bullet at the same-or-shallower indent, so a multi-paragraph
 * entry stays one entry rather than becoming one per line.
 *
 * A GENERATOR, and deliberately so. `MAX_ENTRIES` bounds what `dead.mjs` and
 * `stale.mjs` PROCESS, and while this returned an array it bounded nothing that
 * was ALLOCATED: every entry in the section was materialised — joined text,
 * lead phrase, search needle and referent list — before the first one reached
 * the cap, and `body.split('\n')` held one array slot per line beside it.
 * Measured on a 63,999,792-byte target holding 2,370,362 entries, just under
 * `TARGET_CAP`, peak RSS:
 *
 *    dead.mjs     1,194,016 kB -> 635,228 kB   (-47%)
 *    measure.mjs  1,317,484 kB -> 662,076 kB   (-50%)
 *
 * `stale.mjs` shares this code path and was NOT measured: on that fixture it
 * issues 5,000 `git log -S` calls against a 64 MB blob and does not finish in
 * nine minutes. Its saving is asserted from the shared path, not observed.
 *
 * What this does NOT fix, stated so the generator is not read as a bound it is
 * not. The corpus, the target text and the per-section body slices are all
 * untouched, so a run is still linear in the target's size — the cap that
 * bounds THAT is `TARGET_CAP`, and 635 MB of the original 1.19 GB is still
 * there. Every entry past `MAX_ENTRIES` is still fully materialised and then
 * discarded, because a consumer that only wants to COUNT the remainder has no
 * way to say so; past the cap the cost is CPU, not memory. And a single entry
 * whose body runs to the whole target still accumulates line by line into
 * `current`, so the cap on the worst SINGLE entry is `TARGET_CAP` too.
 *
 * Consequence for callers: the result is single-use and has no `.length`. Two
 * of the three scripts already iterated it with `for...of` and needed no
 * change; `measure.mjs` bound the array and now counts in one pass.
 */
export function* entries(body, entryStyles) {
  let current = null;
  let fence = null;

  for (const line of eachLine(body)) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (line.trimStart().startsWith(fence)) fence = null;
      if (current) current.push(line);
      continue;
    }
    if (fence === null && isEntryStart(line, entryStyles)) {
      if (current) yield materialiseEntry(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) yield materialiseEntry(current);
}

/**
 * `body.split('\n')`, one line at a time. Identical sequence — including the
 * trailing empty string when `body` ends in a newline, and the single empty
 * string for an empty `body` — without the array. That array was one slot per
 * line of the target, held for the whole scan; on the 2,370,362-entry fixture
 * it was the largest survivor once the entry array was gone, and dropping it
 * took `dead.mjs` from 714,608 kB to 635,228 kB after the generator alone.
 */
function* eachLine(s) {
  let i = 0;
  for (;;) {
    const j = s.indexOf('\n', i);
    if (j === -1) { yield s.slice(i); return; }
    yield s.slice(i, j);
    i = j + 1;
  }
}

/** The derived shape every consumer of `entries()` reads. */
function materialiseEntry(lines) {
  const text = lines.join('\n');
  return {
    text, lead: leadPhrase(text), needle: searchNeedle(text), referents: referentsIn(text),
  };
}

/** The words the per-entry count uses: `leadDoneMarkers` if set, else the same list. */
export function leadMarkersFor(config) {
  return config.leadDoneMarkers ?? config.inlineDoneMarkers;
}

/**
 * Is THIS ENTRY marked done, on its own lead line?
 *
 * This is not the same measurement as counting marker occurrences in a section
 * body, and the two never converge. Measured on one repo, 2 target files, 110
 * live entries: the occurrence count reports 32 and this reports 0, and all 32
 * are prose — a `**CLOSED <date>` on a CONTINUATION line inside a live entry, a
 * struck SUB-bullet under a live parent, and sentences quoting the marker
 * strings. A maintainer reading 32 as "32 of my open entries are finished" has
 * been answered a question they did not ask. Both numbers ship, because
 * "how much completion language does this file contain" is also real.
 *
 * POSITION IS THE WHOLE RULE, and it is the lead LINE, not the lead's start.
 * A start-anchored test was measured and rejected: against 114 archived entries
 * in one file it scored 17 where this scores 27, and the 10 it misses are one
 * repo's ordinary convention — `- **#80 — bolder job-type tints — SHIPPED`,
 * `- **[P2] #78 — Πελάτες registry A→Z — MERGED`. Three of the six shipped
 * default markers (`— SHIPPED`, `-- SHIPPED`, `✅`) are written as headline
 * SUFFIXES, so anchoring at the start would make half the default list dead
 * letter at the one position this function looks at.
 *
 * The sub-bullet exclusion is not a second rule and deliberately not a new one:
 * a lead line is by construction line 0 of an entry, `isEntryStart` already
 * refuses any line indented past one space, and `entries()` starts an entry
 * only on a line that passes it. So a struck child under a live parent is never
 * examined, because it is never a lead. A completed child does not close its
 * parent, and that falls out of the existing rule rather than being bolted on.
 *
 * Non-goals, stated here because an unstated limit reads as coverage:
 *  - It CANNOT see an entry closed by editing its BODY and leaving the lead
 *    alone. No scan of first lines can, and widening to the body is the
 *    occurrence count that already exists.
 *  - Prose on a lead line that QUOTES a marker fires. Measured across 316 live
 *    entries in 14 deferred-work files in 9 unrelated repos, zero do — the only
 *    two leads that fire are genuine in-place completions — but `- **Should we
 *    adopt ~~this~~?` would, and a live `- **HALF FIXED — ...` would too if
 *    `**FIXED` were ever added. The error is in the direction that hides work.
 *  - ZERO IS A NUMBER, not a defect. A repo with a real `## Completed` heading
 *    and no in-place marking reports 0 correctly, and every caller must print
 *    it rather than suppressing it.
 *
 * `entryText` is `entries()`'s `.text`, whose first line is the entry's opening
 * line because `text` is that entry's lines rejoined in order. Sliced at the
 * first newline rather than split, so a single-line entry of any size costs one
 * scan and no array.
 */
export function isLeadMarkedDone(entryText, markers) {
  if (typeof entryText !== 'string') return false;
  const nl = entryText.indexOf('\n');
  const lead = nl === -1 ? entryText : entryText.slice(0, nl);
  for (const marker of markers) {
    // An empty marker is rejected at config load; this is the same guard one
    // level down, because `''.includes` is true for every string and would
    // report every entry in the file as done.
    if (marker && lead.includes(marker)) return true;
  }
  return false;
}

/**
 * The phrase that identifies an entry to `git log -S`. Prefers the bold lead,
 * because that is what a bold-led-bullet convention makes distinctive; falls
 * back to the first run of prose long enough not to collide.
 */
export function leadPhrase(text) {
  const bold = /\*\*(.+?)\*\*/s.exec(text);
  if (bold) return bold[1].replace(/\s+/g, ' ').trim();
  const first = text.split('\n')[0].replace(/^\s*[-*]\s*/, '').replace(/\s+/g, ' ').trim();
  return first.slice(0, 60);
}

/**
 * The string to hand `git log -S`, which searches raw file bytes.
 *
 * This is NOT `leadPhrase`. A bold lead that wraps across two lines — the norm
 * once an entry's first sentence is longer than the file's wrap column —
 * contains a newline and its own indentation, so the display form (whitespace
 * collapsed to single spaces) matches nothing and every such entry reports as
 * never committed. The longest single line inside the lead is present verbatim
 * in the file and is long enough to be distinctive.
 */
export function searchNeedle(text) {
  const bold = /\*\*(.+?)\*\*/s.exec(text);
  const source = bold ? bold[1] : text.split('\n')[0].replace(/^\s*[-*]\s*/, '');
  const longest = source
    .split('\n')
    .map((l) => l.replace(/^\s*>?\s*/, '').trim())
    .sort((a, b) => b.length - a.length)[0] ?? '';
  return longest.length >= 12 ? longest : null;
}

/** Every backticked span in an entry — the convention that makes referents machine-readable. */
export function referentsIn(text) {
  const out = new Set();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) out.add(m[1].trim());
  return [...out];
}

/**
 * An index of the repo's files, keyed both by relative path and by bare
 * basename. Referents in prose are written the way a human refers to a file —
 * `site.ts`, `WorkCard.astro` — not as repo-relative paths, so resolving them
 * with `existsSync(join(root, raw))` reports almost every one as missing. On
 * the first repo this ran against, that mistake produced 35 "missing"
 * referents of which essentially none were actually gone.
 */
export function buildFileIndex(root, ignore) {
  const byPath = new Set();
  const byBase = new Map();
  const dirs = new Set();
  const listing = listFiles(root, ignore);
  for (const abs of listing.files) {
    const path = rel(root, abs);
    byPath.add(path);
    const base = path.slice(path.lastIndexOf('/') + 1);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(path);
    let d = path;
    while (d.includes('/')) {
      d = d.slice(0, d.lastIndexOf('/'));
      dirs.add(d);
    }
  }
  return {
    byPath,
    byBase,
    dirs,
    // `ignore` is kept as the raw set it always was: it is part of this
    // record's published shape and nothing here needs to break to add the two
    // fields below it.
    ignore: new Set(ignore),
    matcher: listing.matcher,
    // `'git'` or `'walk'`. A report that does not say which one ran is claiming
    // a coverage it may not have — see `listFiles`.
    mode: listing.mode,
    gitIgnored: listing.gitIgnored,
    deps: declaredDependencies(root),
  };
}

/**
 * Names declared as dependencies, so `astro/dist/cli/preview/index.js` and
 * `next/font` stop reading as missing repo files. Both are real referents — a
 * note about a library's internals is a normal thing to write down — and both
 * are outside the repo by construction, which is exactly what makes "missing"
 * the wrong word for them.
 *
 * Deliberately only the two JSON manifests. Parsing Cargo.toml, go.mod and
 * requirements.txt correctly is more surface than the payoff justifies, and the
 * cost of not doing it is bounded and one-directional: a Rust or Go repo gets a
 * few extra entries in a bucket a human reads anyway. Nothing is misreported as
 * present, and no other check depends on this.
 */
function declaredDependencies(root) {
  const names = new Set();
  const manifests = [
    ['package.json', ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']],
    ['composer.json', ['require', 'require-dev']],
  ];
  for (const [file, fields] of manifests) {
    try {
      // Containment, not merely a size cap, and these two files were the only
      // ones in the tool that had neither. `package.json` is git-trackable as
      // a symlink (mode 120000), so `package.json -> ../outside/evil.json`
      // ships in a clone and needs no config: measured, an external
      // `dependencies` key reclassified an in-repo referent as a package and
      // dropped it out of `dead.mjs`'s report entirely. The read reaches
      // outside the tree AND changes the finding.
      const abs = contained(root, join(root, file));
      if (!abs) continue;
      // Before the read, not inside the catch: an OOM is a FATAL, not an
      // exception, so this `try` cannot see it. And `isFile()` before the
      // size, because size is meaningless for anything else — the same
      // symlink pointed at /dev/zero stats at 0 and reads for ever.
      const st = statSync(abs);
      if (!st.isFile() || st.size > MANIFEST_CAP) continue;
      const json = JSON.parse(readFileSync(abs, 'utf8'));
      for (const field of fields) {
        for (const name of Object.keys(json[field] ?? {})) names.add(name);
      }
    } catch { /* absent or unparseable — the filter simply does not apply */ }
  }
  return names;
}

/** Is this referent a path INTO a declared dependency rather than into the repo? */
function isDependencyPath(path, index) {
  if (!index || !index.deps || index.deps.size === 0) return false;
  const parts = path.split('/');
  // Scoped packages own two segments: `@scope/name/dist/x.js`.
  return index.deps.has(parts[0]) || (parts.length > 1 && index.deps.has(`${parts[0]}/${parts[1]}`));
}

const DOMAIN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.(com|org|net|io|dev|co|app|sh|ai|me|eu|uk|gr|cy|xyz|tools|so)(\/|$)/i;

/**
 * A referent is only guessed to be a FILE when its extension is one a repo
 * actually uses. Without an allowlist, `site.email`, `repository.url` and
 * `.plate` all parse as filenames and get reported as missing files — three
 * false positives on the first repo this ran against, from a property
 * accessor, a package field and a CSS class.
 */
const KNOWN_EXT = new RegExp(
  '\\.(m?[jt]sx?|cjs|mjs|json|jsonc|ya?ml|toml|ini|cfg|conf|env|lock|md|mdx|markdown|txt|rst|adoc|'
  + 'html?|xml|svg|css|scss|sass|less|astro|vue|svelte|php|rb|py|pyi|go|rs|java|kt|kts|swift|'
  + 'c|h|cc|cpp|hpp|cs|sql|sh|bash|zsh|fish|ps1|dockerfile|gradle|proto|graphql|gql|'
  + 'png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|pdf|csv|tsv)$',
  'i',
);

/**
 * Characters that mean "this is a code fragment or a quotation", never a path.
 * The ellipsis and the leading dash are both abbreviation artefacts: prose
 * elides a long path as `…/print`, and a wrapped or hyphenated name leaves a
 * fragment like `-comments.md`. Neither is a file, and both were reported as
 * missing files before this line existed.
 */
const NOT_A_PATH = /["'`<>()\[\]{}=;,!$|&^~]|\.\.|@|::|…|^-/;

/**
 * A slash does not make a path. Deferred-work files are full of branch names —
 * `feat/installed-machines-register`, `ci/p1-gate-integrity`, `origin/main` —
 * and every one of them resolved as a missing FILE on the second repo this ran
 * against: 6 of that repo's 9 "referent missing" reports were branches.
 *
 * The prefix list is the conventional-commits / git-flow set plus remote names.
 * It is a closed list on purpose: `git rev-parse` would be stronger evidence,
 * but a merged-and-deleted branch fails it, and reporting a finished branch as
 * a missing file is the exact error being fixed here.
 */
const GIT_REF = /^(origin|upstream|fork|feat|feature|fix|hotfix|bugfix|chore|ci|docs|refactor|test|perf|build|style|revert|release|wip|spike|exp)\/[\w.-]+$/i;

/**
 * The string to search a repo for, given a symbol referent.
 *
 * A referent written in CALL form — `safeField()`, `.map()`, `process.exit()` — was
 * searched literally, so its verdict turned on whether some file happened to quote the
 * same empty-paren form rather than on whether the symbol is still called. In this repo
 * `process.exit()` read COMMENT-ONLY because the only literal `process.exit()` sits in a
 * docblock below, while every real call carries an argument; `safeField()` read ABSENT
 * against 22 call sites.
 *
 * Dropping the CLOSING paren and keeping the opening one is what fixes it. `safeField(`
 * matches the definition and every call site; the bare name would match `reopen` for
 * `open` and any prose word. Measured across 11 deferred-work files in 10 repos, 2,878
 * distinct referents, 86 of them call form in 9 of the 10 repos: 31 verdicts change and
 * every one is a call-form referent — COMMENT-ONLY 21 -> 4, ABSENT 16 -> 4, DOC-ONLY
 * 2 -> 0, and the 8 survivors are the genuine tombstones. Searching the bare name was
 * measured too and is worse in the direction that matters: `sql()`, `open()` and
 * `fstat()` each flip to CODE on a substring of something unrelated, which is a dead
 * thing reported as alive — the one error this tool exists to prevent.
 *
 * The search is still a substring test, so `max(` also matches `Math.max(` and
 * `import_customers(` matches `public.import_customers(`. All three corpus cases that
 * rest only on such a match were read by hand and each names the symbol its entry meant,
 * but a same-named function in an unrelated module is indistinguishable — the standing
 * precision limit of a text scan, widened slightly here.
 *
 * Only the EMPTY-paren form is touched. A call carrying a literal argument —
 * a translation call carrying a quoted key, 34 in the corpus — is already specific,
 * and the 4 spans that wrap a call inside a template interpolation name nothing at all.
 * Quoting either shape here would also plant it in this repo's own report, which is how
 * a docblock becomes a false tombstone for the string it is describing.
 *
 * Every call form leaves `classifyReferent` through the `NOT_A_PATH` branch, because
 * `(` is in that character class. That is why the same strip sitting on the final
 * return could never fire.
 */
function symbolNeedle(stripped) {
  return stripped.replace(/^(.+)\(\)$/, '$1(');
}

/**
 * Decide what a backticked span IS, resolving against the repo rather than
 * guessing from shape alone. The order matters: anything with whitespace is a
 * command or a sentence and is not looked up at all; a package specifier and a
 * URL are external by construction; and a bare filename is a path only once the
 * index says a file by that name exists.
 *
 * `index` may be omitted, in which case nothing resolves to a path by basename
 * and the classification degrades to syntax only.
 */
export function classifyReferent(raw, index = null) {
  const trimmed = raw.trim();
  if (/\s/.test(trimmed)) return { kind: 'prose', needle: trimmed, raw };

  // `src/x.ts:12-40` -> `src/x.ts`, and `public/fonts/` -> `public/fonts`.
  const stripped = trimmed.replace(/:\d+(-\d+)?$/, '').replace(/\/+$/, '') || trimmed;

  if (stripped.startsWith('@') || stripped.includes('://')) {
    return { kind: 'external', needle: stripped, raw };
  }
  // A leading slash is a site route — `/`, `/el/`, `/terms` — unless the repo
  // actually holds that path at its root.
  //
  // The extension alone used to decide this, which let every URL carrying one
  // through to the path branch and out as PATH-MISSING. Measured across 11 real
  // deferred-work files in 10 repos, 6,384 backticked spans: 136 distinct
  // leading-slash referents, 128 already classified route, 4 prose, 4 path —
  // and all 4 of the path ones false alarms, among them `/el/index.html`, a URL
  // in a note about which pages an audit config covers. Not one leading-slash
  // referent in the set resolved to a real repo file, so the extension
  // carve-out bought no true positive at all.
  //
  // Resolving instead of guessing from shape is what keeps the repo-root
  // convention alive: `/package.json` in a repo that HAS one is a path and
  // still resolves. The lookup has to strip the slash itself rather than fall
  // through to the index lookup below, which does not — `/src/app.ts` would
  // miss `byPath`, miss the `endsWith('/' + lookup)` suffix test, and land in
  // PATH-MISSING, which is the bucket this branch exists to keep clean.
  //
  // FILES only, never directories, and that is deliberate. Matching `dirs` too
  // was tried and reverted: one corpus referent is a slash-command name that
  // happens to share a name with a root directory, and directory matching
  // turned it into a resolved path. Slash commands and site routes both look
  // exactly like a root-directory reference and vastly outnumber it, so `dirs`
  // costs more than it buys. A repo-root DIRECTORY written with a leading slash
  // stays classified `route` — that is the known miss, and it is the quiet
  // direction.
  if (stripped.startsWith('/')) {
    const rooted = stripped.slice(1);
    if (index && index.byPath.has(rooted)) {
      return { kind: 'path', needle: rooted, resolved: rooted, raw };
    }
    return { kind: 'route', needle: stripped, raw };
  }
  if (/[*?]/.test(stripped) && stripped.includes('/')) {
    const dir = stripped.slice(0, stripped.lastIndexOf('/'));
    const globIgnoredBy = ignoringSegment(dir, index);
    return {
      kind: 'glob',
      needle: stripped,
      dir,
      resolved: index && index.dirs.has(dir) ? dir : null,
      ignored: globIgnoredBy !== null,
      ignoredBy: globIgnoredBy ? globIgnoredBy.by : null,
      // Same provenance split as the path branch below: a glob under a
      // directory the SCANNED REPO chose to ignore is the audited party
      // deciding what the audit may see, and it lands in the same quiet
      // bucket as a directory todokeeper skips by default.
      ignoredByConfig: globIgnoredBy !== null && globIgnoredBy.source !== 'defaults',
      ignoredBySource: globIgnoredBy ? globIgnoredBy.source : null,
      raw,
    };
  }

  if (index) {
    const lookup = stripped.replace(/^\.\//, '');
    if (index.byPath.has(lookup)) return { kind: 'path', needle: lookup, resolved: lookup, raw };
    if (index.dirs.has(lookup)) return { kind: 'path', needle: lookup, resolved: lookup, raw };
    const base = lookup.slice(lookup.lastIndexOf('/') + 1);
    const matches = index.byBase.get(base);
    if (matches && matches.length) {
      // A partial path must be a suffix of a real one, so
      // `components/Wordmark.astro` does not match `other/Wordmark.astro`.
      const hits = lookup.includes('/')
        ? matches.filter((m) => m === lookup || m.endsWith(`/${lookup}`))
        : matches;
      if (hits.length) return { kind: 'path', needle: lookup, resolved: hits[0], all: hits, raw };
    }
  }

  // Unresolved. Everything below is a judgement about what the string WOULD be
  // if it were a path, and each test exists to keep a non-path out.
  if (DOMAIN.test(stripped)) return { kind: 'external', needle: stripped, raw };
  if (NOT_A_PATH.test(stripped)) return { kind: 'symbol', needle: symbolNeedle(stripped), raw };
  // Checked only AFTER the index has had its chance, so a real repo directory
  // that happens to share a dependency's name still resolves as a path.
  if (isDependencyPath(stripped, index)) return { kind: 'external', needle: stripped, raw };
  // Same ordering reason, and one extra guard: `docs/` and `test/` are both a
  // branch prefix and a real directory name, so a referent carrying a file
  // extension is a file even when its first segment looks like a branch.
  if (GIT_REF.test(stripped) && !KNOWN_EXT.test(stripped)) {
    return { kind: 'ref', needle: stripped, raw };
  }

  const base = stripped.slice(stripped.lastIndexOf('/') + 1);
  const looksLikeFile = KNOWN_EXT.test(base) && !base.startsWith('.');
  if (stripped.includes('/') || looksLikeFile) {
    // A path the index cannot see because it was never scanned is not missing —
    // build output and vendored trees are excluded by config, not by absence.
    const suppressor = ignoringSegment(stripped, index);
    return {
      kind: 'path',
      needle: stripped,
      resolved: null,
      ignored: suppressor !== null,
      ignoredBy: suppressor ? suppressor.by : null,
      // Whether the exclusion came from this tool's own defaults or from the
      // scanned repo's own `.todokeeper.json` / `.gitignore`. See
      // `PATH-NOT-SCANNED` in dead.mjs.
      ignoredByConfig: suppressor !== null && suppressor.source !== 'defaults',
      // `'defaults' | 'config' | 'gitignore'`, so a report can name the file to
      // open. Folding `.gitignore` into `ignoredByConfig` alone would send a
      // reader to `.todokeeper.json` to find a line that is not in it.
      ignoredBySource: suppressor ? suppressor.source : null,
      raw,
    };
  }
  return { kind: 'symbol', needle: symbolNeedle(stripped), raw };
}

/**
 * Which directory the scan was told to skip put this path out of reach, or
 * `null` if none did.
 *
 * This returns the SEGMENT rather than a boolean because the segment is the
 * only thing that distinguishes the two very different facts that both land in
 * `PATH-NOT-SCANNED`: "this is build output, todokeeper never looks there" and
 * "the scanned repo's own config excluded exactly the directory an entry names".
 * `.todokeeper.json` ships inside the repo being audited, so the same commit
 * that deletes a file an entry names can add that file's directory to `ignore`
 * and turn a `PATH-MISSING` into a `PATH-NOT-SCANNED` — measured, and it is not
 * a fabricated clean result but it is a real finding wearing a neutral label.
 */
function ignoringSegment(path, index) {
  if (!index) return null;
  const p = String(path).replace(/^\.\//, '');
  // EVERY segment, because that is what the enumeration does: one compiled
  // matcher serves both, so `internal` in `ignore` removes
  // `src/internal/auth.ts` from the index just as surely as `internal/auth.ts`.
  // This asked about segment 0 only, and the two answers disagreed for anything
  // nested — the file was never indexed, nothing reported it as excluded, and
  // it fell out the bottom as PATH-MISSING. That is worse than the bucket this
  // function exists to expose: instead of a quiet count, the tool made the
  // affirmative claim that a file which exists on disk is gone, which invites
  // deleting a live entry as obsolete. Measured on a fixture where
  // `src/internal/auth.ts` exists and `internal` is in the repo's own `ignore`.
  const byList = ignoredBy(p, index.matcher);
  if (byList !== null) {
    return { by: byList, source: DEFAULTS.ignore.includes(byList) ? 'defaults' : 'config' };
  }
  // Checked SECOND so the common case keeps its old answer. `node_modules` is
  // both a todokeeper default and gitignored in most repos; reporting it as a
  // `.gitignore` suppression would move every such referent into the loud
  // bucket and drown the one case that bucket exists for.
  const byGit = gitIgnoringPrefix(p, index.gitIgnored);
  if (byGit !== null) return { by: byGit, source: 'gitignore' };
  return null;
}

/* ------------------------------------------------------------------ commit */

/**
 * `--literal-pathspecs` because `--` does NOT disable pathspec MAGIC, and every
 * pathspec here is repo-derived: a resolved referent path, or a `targets` entry
 * from the audited repo's own config. A tracked file named `:(exclude)src/z.ts`
 * made this report the wrong commit for an unrelated entry and flipped it to
 * `suspect` with a fabricated 2,421-day gap; the same magic in a `targets`
 * directory name steered the phrase search. `execFileSync` with an argv array
 * already prevents shell and flag injection — this is the separate half.
 *
 * It goes BEFORE the subcommand: `git log --literal-pathspecs` exits
 * `fatal: unrecognized argument`, which this function catches and turns into
 * `null` — so the wrong placement disables every commit lookup in the tool and
 * reports it as "no path referent" rather than as an error. Both forms were run
 * on git 2.34.1 before this landed. `GIT_LITERAL_PATHSPECS=1` in the child's
 * env is equivalent and was measured working; the flag is used because it is
 * visible in the argv rather than inherited.
 */
export function lastCommitTouching(root, pathspecs, extraArgs = []) {
  try {
    const out = execFileSync(
      'git',
      ['--literal-pathspecs', 'log', '-1', '--format=%H%x09%cI%x09%s', ...extraArgs, '--', ...pathspecs],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!out) return null;
    const [hash, date, subject] = out.split('\t');
    return { hash, date, subject };
  } catch {
    return null;
  }
}

/** The commit that last added or removed `phrase` anywhere under `pathspecs`. */
export function lastCommitChangingPhrase(root, phrase, pathspecs) {
  if (!phrase) return null;
  try {
    const out = execFileSync(
      'git',
      ['--literal-pathspecs', 'log', '-1', '--format=%H%x09%cI%x09%s', `-S${phrase}`, '--', ...pathspecs],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!out) return null;
    const [hash, date, subject] = out.split('\t');
    return { hash, date, subject };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- walk */

/**
 * `ignore` compiled once into the two shapes it actually has. Entries are
 * LITERAL — a bare name matches that segment at any depth, a name containing a
 * `/` matches that repo-relative path and everything under it.
 *
 * The path form exists because its absence was a silent no-op, which is the
 * worst failure this config can have: a repo wrote `web/test-results`, the old
 * `skip.has(item.name)` compared it against basenames only, it matched nothing
 * at any depth, and the line sat in `.todokeeper.json` reading exactly like
 * protection. Nothing reported it. `loadConfig` now rejects the shapes that
 * still cannot match — globs, absolute paths, backslashes, `..` — so the
 * remaining failure mode is a typo'd path, which no validator can see.
 *
 * One compiled matcher serves BOTH the enumeration and `ignoringSegment`. That
 * is deliberate and it is the second half of the same bug: when the walk and
 * the classifier disagree about what is excluded, a file that was never indexed
 * gets reported as PATH-MISSING — an affirmative claim that something on disk
 * is gone, which invites deleting a live entry. They cannot disagree if there
 * is only one predicate.
 */
export function compileIgnore(list) {
  const names = new Set();
  const paths = [];
  for (const raw of list || []) {
    const entry = String(raw).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!entry) continue;
    if (entry.includes('/')) paths.push(entry);
    else names.add(entry);
  }
  return { names, paths };
}

/**
 * The entry excluding `path`, or null. `path` is repo-relative and
 * `/`-separated. Names are checked before paths so the reported suppressor
 * stays the same string a pre-path config would have reported.
 */
export function ignoredBy(path, matcher) {
  if (!matcher) return null;
  const p = String(path).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!p) return null;
  for (const seg of p.split('/')) {
    if (matcher.names.has(seg)) return seg;
  }
  for (const prefix of matcher.paths) {
    if (p === prefix || p.startsWith(`${prefix}/`)) return prefix;
  }
  return null;
}

/**
 * The ignored prefix covering `path` according to `.gitignore`, or null.
 *
 * `gitIgnored` holds what `git ls-files --others --ignored --directory`
 * returned: whole directories collapsed to one entry, plus individually
 * ignored files. So the lookup is an exact hit or an ancestor hit, and never a
 * pattern match — git already did the pattern matching, which is the entire
 * reason this tool does not implement gitignore semantics itself.
 */
function gitIgnoringPrefix(path, gitIgnored) {
  if (!gitIgnored || gitIgnored.size === 0) return null;
  let p = String(path).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!p) return null;
  if (gitIgnored.has(p)) return p;
  let cut = p.lastIndexOf('/');
  while (cut > 0) {
    p = p.slice(0, cut);
    if (gitIgnored.has(p)) return p;
    cut = p.lastIndexOf('/');
  }
  return null;
}

/**
 * Bytes a `git ls-files` listing may occupy. `execFileSync` defaults to 1MB and
 * throws `ENOBUFS` past it, which this code turns into "not a git repo" and a
 * silent downgrade to the plain walk — so the number is set where a large
 * monorepo cannot reach it rather than left to the default. 64MB is ~800,000
 * paths at 80 bytes each.
 */
const GIT_LIST_BUFFER = 64 * 1024 * 1024;

/**
 * One git enumeration per root per process. These are one-shot CLIs, so a cache
 * that never invalidates is correct here and wrong in a long-lived process —
 * `dead.mjs` alone would otherwise shell out four times for the same answer
 * (`walkFiles` directly, then `buildFileIndex`, each running two git commands).
 */
const gitListingCache = new Map();

/**
 * What git says is in this work tree, or null when the answer cannot be had.
 *
 * `-z` is not an optimisation: without it git QUOTES any path containing a
 * non-ASCII byte, a quote or a backslash, so `"\303\250.md"` would enter the
 * index as a literal 12-character name and every referent naming that file
 * would read as PATH-MISSING. This repo is bilingual by intent; the quoting
 * form would have fired on the first Greek filename.
 *
 * The toplevel comparison is what keeps the two enumerations equivalent. `git
 * ls-files` run from a SUBDIRECTORY of a work tree lists that subdirectory's
 * files with paths relative to it, which is not what `root` means to any caller
 * here — so a root that is not itself the toplevel falls back to the walk
 * rather than silently scanning a different set. `realpathSync` on both sides
 * because a work tree reached through a symlink compares unequal as a string.
 *
 * Returns null on: no git binary, not a work tree, root below the toplevel, a
 * listing past the buffer, or any git failure. Every one of those is a
 * DOWNGRADE, not an error — the caller falls back to the plain walk and says so.
 */
function gitEnumerate(root) {
  let top;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  if (!top) return null;
  try {
    if (realpathSync(top) !== realpathSync(root)) return null;
  } catch {
    return null;
  }
  let listed;
  let ignored;
  try {
    const run = (args) => execFileSync('git', args, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_LIST_BUFFER,
    });
    // Tracked plus untracked-and-not-ignored: exactly the files a contributor
    // would call "in the repo". `--exclude-standard` is what applies every
    // `.gitignore` at every depth, `.git/info/exclude`, and the user's global
    // excludes file — none of which this tool parses or wants to.
    listed = run(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    // The complement, for `ignoringSegment`. `--directory` collapses a wholly
    // ignored directory to one entry, so `interview/` costs one string rather
    // than one per recording inside it.
    ignored = run(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  } catch {
    return null;
  }
  const split = (out) => out.split('\0').filter(Boolean);
  return {
    files: split(listed),
    ignored: new Set(split(ignored).map((p) => p.replace(/\/+$/, ''))),
  };
}

/** The plain recursive walk. Used when `gitEnumerate` returns null. */
function walkDisk(root, matcher) {
  const out = [];
  // The repo-relative prefix travels with the directory so a path-shaped
  // `ignore` entry can be matched during descent rather than after it.
  const stack = [['', root]];
  while (stack.length) {
    const [prefix, dir] = stack.pop();
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      // Before the isDirectory() branch on purpose: `ignore` suppresses FILES
      // as well as directories, which is how a repo keeps `.env`, `.env.keys`
      // or `SESSION.md` out of the scan without inventing a directory for them.
      if (ignoredBy(path, matcher)) continue;
      const abs = join(dir, item.name);
      // A Dirent reports the entry's OWN type, so a symlink is neither a
      // directory nor a file and falls through both arms unfollowed. That is
      // load-bearing rather than incidental: it is what keeps this mode
      // agreeing with the lstat in listFiles. Never switch these to statSync.
      if (item.isDirectory()) stack.push([path, abs]);
      else if (item.isFile()) out.push(abs);
    }
  }
  return out;
}

/**
 * Every file this tool may look at, and how it found them.
 *
 * `mode` is `'git'` or `'walk'`, and the difference is not cosmetic — it is the
 * difference between honouring `.gitignore` and not. In `'walk'` mode nothing
 * excludes an ignored file except `ignore` in `.todokeeper.json`, so a repo
 * whose secrets or personal data are protected by a `.gitignore` line alone
 * gets them READ. Every caller that prints a report prints the mode.
 *
 * Why git rather than a gitignore parser: the semantics are not small
 * (precedence between files at different depths, `!` negation, `**`, a trailing
 * slash meaning directory-only, `.git/info/exclude`, `core.excludesFile`), and
 * a parser that gets one of them wrong fails in the direction that reads the
 * file it was supposed to skip. Shelling out to git is already how this tool
 * answers three other questions.
 *
 * A tracked file that has been deleted from disk is still in the index and is
 * still listed, so each path is stat'ed; that also drops submodule gitlinks,
 * which `ls-files` reports as a single entry naming a directory.
 */
export function listFiles(root, ignore) {
  const matcher = compileIgnore(ignore);
  const key = resolve(root);
  if (!gitListingCache.has(key)) gitListingCache.set(key, gitEnumerate(key));
  const git = gitListingCache.get(key);
  if (!git) {
    return { mode: 'walk', files: walkDisk(key, matcher), gitIgnored: null, matcher };
  }
  const files = [];
  for (const path of git.files) {
    if (ignoredBy(path, matcher)) continue;
    const abs = join(key, path);
    try {
      // lstat, never stat. Git stores a symlink as a blob holding its target
      // string and lists it like any other path, so `ls-files` hands us links
      // as readily as files. `statSync` FOLLOWS one, and `readFileSync`
      // downstream follows it again. Two escapes, and the second is the one
      // that matters here: a tracked link whose target sits INSIDE a
      // gitignored directory is not itself ignored, so it passes every filter
      // above and yields exactly the bytes this change exists to stop being
      // read. A link's own content is its target string -- nothing worth
      // scanning -- so drop it, and both enumeration modes stay in agreement.
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    files.push(abs);
  }
  return { mode: 'git', files, gitIgnored: git.ignored, matcher };
}

export function walkFiles(root, ignore) {
  return listFiles(root, ignore).files;
}

export const isText = (path) =>
  !/\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|pdf|zip|gz|mp4|webm|wasm)$/i.test(path);

export const rel = (root, abs) => relative(root, abs).split(sep).join('/');

export const daysBetween = (a, b) =>
  Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
