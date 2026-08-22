#!/usr/bin/env node
/**
 * todokeeper dead — do the things an entry names still exist?
 *
 * The naive version of this check greps the repo for each backticked referent
 * and calls a hit PRESENT. That check is wrong in a specific, recurring way,
 * and correcting it is the reason this script exists.
 *
 * When a thing is removed, the removal is usually explained in a comment that
 * NAMES the removed thing. A tombstone. So the grep finds `mask-position`,
 * `Alegreya`, `780` — every hit inside a comment saying why they are gone — and
 * reports PRESENT for three referents that are all dead. In one real repo all
 * three of the naive check's hits were tombstones; the check's false-negative
 * rate on that sample was 100%.
 *
 * So hits are tiered:
 *
 *   CODE          at least one hit outside any comment    -> alive
 *   COMMENT-ONLY  every hit is inside a comment           -> probable tombstone
 *   DOC-ONLY      every hit is in markdown/prose files    -> described, not used
 *   ABSENT        no hit anywhere                         -> gone
 *
 * Usage:
 *   node scripts/dead.mjs [--json] [--root <dir>]
 */

import { readFileSync, statSync } from 'node:fs';
import {
  loadConfigOrExit, rootFromArgvOrExit, resolveTargets, sections, entries,
  classifyReferent, buildFileIndex, walkFiles, isText, rel, isCompletedHeading,
  readTarget, warnIfHeadingless, safeField, jsonSafe, writeStdout, warnIndexSkips, notedList,
  MAX_REFERENTS, MAX_ENTRIES, MAX_FROM,
} from './lib.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const root = rootFromArgvOrExit(argv);

const config = loadConfigOrExit(root);
const targets = resolveTargets(root, config);

if (targets.length === 0) {
  console.error(`todokeeper: no deferred-work file found. Looked for: ${config.targets.map(safeField).join(', ')}`);
  process.exit(2);
}

/* ------------------------------------------------------- comment detection */

const HASH_COMMENT = /\.(sh|bash|zsh|py|rb|yml|yaml|toml|conf|cfg|ini|nix|pl|r)$/i;
const SLASH_COMMENT = /\.(m?[jt]sx?|c|h|cc|cpp|hpp|cs|java|go|rs|swift|kt|scala|php|astro|vue|svelte|css|scss|less|sass)$/i;
const MARKUP_COMMENT = /\.(html?|xml|svg|astro|vue|svelte|md|markdown)$/i;
const DOC_FILE = /\.(md|markdown|mdx|txt|rst|adoc)$/i;

/**
 * For every line of `text` containing `needle`, decide whether the occurrence
 * sits inside a comment. Block state (`/* *\/`, `<!-- -->`) is tracked across
 * lines, because a tombstone is very often a multi-line block.
 *
 * Known limit, stated rather than hidden: this does not parse string literals.
 * A needle inside a quoted string that follows a `//` on the same line — a URL
 * in code, say — is misread as a comment. That biases toward reporting a live
 * referent as COMMENT-ONLY, which surfaces a false alarm to a human instead of
 * hiding a dead referent, and that is the direction to be wrong in.
 */
function scanFile(text, needle, path) {
  const slash = SLASH_COMMENT.test(path);
  const hash = HASH_COMMENT.test(path);
  const markup = MARKUP_COMMENT.test(path);

  const lines = text.split('\n');
  const hits = [];
  let inBlock = null; // 'c' for /* */, 'x' for <!-- -->

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const at = line.indexOf(needle);
    const blockAtLineStart = inBlock;

    // Advance block state across this line, remembering where each state change
    // happened so a needle can be placed relative to it.
    let cursor = 0;
    const events = [];
    while (cursor < line.length) {
      if (inBlock === 'c') {
        const end = line.indexOf('*/', cursor);
        if (end === -1) break;
        events.push({ pos: end + 2, state: null });
        inBlock = null;
        cursor = end + 2;
      } else if (inBlock === 'x') {
        const end = line.indexOf('-->', cursor);
        if (end === -1) break;
        events.push({ pos: end + 3, state: null });
        inBlock = null;
        cursor = end + 3;
      } else {
        const c = slash ? line.indexOf('/*', cursor) : -1;
        const x = markup ? line.indexOf('<!--', cursor) : -1;
        const next = [c, x].filter((n) => n !== -1).sort((a, b) => a - b)[0];
        if (next === undefined) break;
        const state = next === c ? 'c' : 'x';
        events.push({ pos: next, state });
        inBlock = state;
        cursor = next + 2;
      }
    }

    if (at === -1) continue;

    // Where did the block state stand at the needle's column?
    let stateAtNeedle = blockAtLineStart;
    for (const e of events) {
      if (e.pos <= at) stateAtNeedle = e.state;
    }

    let commented = stateAtNeedle !== null;
    if (!commented) {
      const openers = [];
      if (slash) openers.push('//');
      if (hash) openers.push('#');
      for (const o of openers) {
        const idx = line.indexOf(o);
        if (idx !== -1 && idx < at) { commented = true; break; }
      }
      // A continuation line inside a JSDoc-style block that this scan entered on
      // an earlier line is already caught above; this catches a lone ` * ` line
      // in a file whose block opener sits outside the scanned range.
      if (!commented && slash && /^\s*\*(\s|$)/.test(line)) commented = true;
    }

    hits.push({ line: i + 1, commented, text: line.trim().slice(0, 120) });
  }

  return hits;
}

/* ------------------------------------------------------------------- scan */

const targetSet = new Set(targets);
const files = walkFiles(root, config.ignore)
  .filter((f) => isText(f))
  .filter((f) => !targetSet.has(f)); // the deferred-work file names everything; it proves nothing

// Every text file in the repo is held in memory at once so each referent can be
// scanned without re-reading. The per-file cap alone bounds nothing in
// aggregate: a repo of a hundred thousand small files clears it on every file
// and still exhausts the heap. The total cap is what actually bounds this, and
// it is announced rather than silent — a truncated scan that reported like a
// complete one would call a live referent ABSENT.
//
// MEASURED, 2026-08-22, in both directions, because the budget was chosen to
// sit below a default Node heap and nothing had checked either end of that.
//
// Below: across 30 repositories on one machine the largest corpus this walk
// holds is 16.7MB over 1,163 text files — 6.5% of the budget — and the next
// is 11.8MB. Not one was truncated, so the announcement path above has still
// never run outside a fixture, and the cap is nowhere near firing on ordinary
// work.
//
// Above: driven to 254,700,000 bytes held (99.5% of the cap) with a single
// referent, so the figure is the read and not the scan. Peak RSS — `ru_maxrss`,
// so KiB — was 315,240 over 130 files of ASCII, 355,608 for the same bytes in
// Greek, 566,712 over 100,000 files of 2,547 bytes, and 612,748 for 100,000
// Greek files at 4.95 seconds: the worst of the four, and 627,453,952 bytes.
// Node's default heap ceiling on that machine is 4,496,293,888 bytes, so a
// saturated budget peaks at 14.0% of it. The guess was right and conservative.
//
// Both units are spelled out because the first version of this comment divided
// KiB by decimal MB and printed 13.6%. The rest of this file is decimal
// (`TOTAL_CAP / 1e6` prints "256MB"), `ru_maxrss` is not, and a ratio between
// the two conventions is wrong by 2.4% while looking entirely ordinary.
//
// The shape matters more than the charset: the same 254.7MB costs 315MB in 130
// files and 567MB in 100,000, because the per-file overhead nearly doubles it.
// That is the hundred-thousand-small-files case this comment already named, and
// it is now the measured worst rather than the asserted one. What none of this
// covers: one machine, one V8, and a per-referent scan whose cost sits on top
// of these figures rather than inside them.
const FILE_CAP = 2_000_000;
const TOTAL_CAP = 256_000_000;
const contents = new Map();
let held = 0;
let skippedForSize = 0;
let unread = 0;
for (const f of files) {
  try {
    const { size } = statSync(f);
    if (size > FILE_CAP) { skippedForSize += 1; continue; }
    if (held + size > TOTAL_CAP) { unread += 1; continue; }
    contents.set(f, readFileSync(f, 'utf8'));
    held += size;
  } catch { /* unreadable, skip */ }
}
if (unread > 0 || skippedForSize > 0) {
  const parts = [];
  if (unread > 0) parts.push(`${unread} past the ${Math.round(TOTAL_CAP / 1e6)}MB read budget`);
  if (skippedForSize > 0) parts.push(`${skippedForSize} over the ${FILE_CAP / 1e6}MB per-file cap`);
  process.stderr.write(
    `todokeeper: ${unread + skippedForSize} file(s) went unscanned (${parts.join(', ')}). `
    + 'ABSENT verdicts below are only as complete as the scan; narrow it with `ignore` '
    + 'in .todokeeper.json and re-run.\n',
  );
}

const index = buildFileIndex(root, config.ignore);
// Before a single verdict is computed, because all three change what a verdict
// MEANS and an operator who reads them after the table has already acted.
warnIndexSkips(index);
const classified = new Map();
const seen = new Map();

const unreadTargets = [];
// The count this script has to bound, because the scan below is one pass over
// the whole in-budget corpus PER distinct referent. See `MAX_REFERENTS`.
let droppedReferents = 0;
// The two `stale.mjs` had and this script did not. `MAX_REFERENTS` bounds
// DISTINCT referents and reads like the whole cap; it is not. Entries were
// uncounted here, and each one pushes a provenance record per referent it
// names — including referents already admitted, which no cap touched.
let entriesSeen = 0;
let droppedEntries = 0;
let droppedFrom = 0;

for (const abs of targets) {
  const file = rel(root, abs);
  // Capped like every other file this script reads. Skipping one target still
  // reports the referents named by the others; the skip is announced below,
  // because a referent nobody collected cannot be ABSENT — it was never asked.
  const text = readTarget(abs, file);
  if (text === null) { unreadTargets.push(file); continue; }
  const secs = sections(text);
  // A target that parsed to no headings produces a plausible report rather than
  // an obviously broken one: nothing is ever classified completed, so the whole
  // archive sweeps as live work. Say so on stderr before printing the numbers.
  warnIfHeadingless(secs, text, file);
  let completedDepth = null;

  for (const sec of secs) {
    const completedHere = sec.heading != null && isCompletedHeading(sec.heading, config.completedHeadings);
    if (sec.heading != null && completedDepth != null && sec.depth <= completedDepth && !completedHere) {
      completedDepth = null;
    }
    if (completedHere) completedDepth = sec.depth;
    if (completedDepth != null) continue;

    for (const entry of entries(sec.body, config.entryStyles)) {
      entriesSeen += 1;
      if (entriesSeen > MAX_ENTRIES) { droppedEntries += 1; continue; }
      for (const raw of entry.referents) {
        // Two guards on one cost the cap did not bound. `MAX_REFERENTS`
        // gates INSERTION into `seen`, but classification runs first and is
        // not free: a path that does NOT resolve falls through to a basename
        // filter that is O(files sharing that basename). Measured against
        // 3,001 files named `x.ts`, 30,000 classifications cost 1.61s for
        // `zzz/x.ts` and 0.015s for `a/x.ts` — the exact-hit lookup
        // short-circuits, so the expensive shape is specifically a referent
        // that MISSES. (The review that raised this measured the resolving
        // form and got 1.77s; that input does not reproduce, the miss does.)
        //
        // Memoising on the raw string kills the repeated-referent case.
        // Distinct raws it cannot help, so the second guard stops classifying
        // once the cap is reached: past that point an unseen referent can only
        // be dropped, so paying to classify it buys nothing. That widens
        // `droppedReferents` slightly — a prose or external referent arriving
        // after the cap now counts as dropped where before it was skipped
        // silently — which overstates a truncation warning rather than
        // understating it.
        //
        // `index` is built once per run and `classifyReferent` reads it
        // without mutating, so a given string's classification is invariant
        // for the whole run.
        if (seen.size >= MAX_REFERENTS && !classified.has(raw)) {
          droppedReferents += 1;
          continue;
        }
        let c = classified.get(raw);
        if (c === undefined) {
          c = classifyReferent(raw, index);
          classified.set(raw, c);
        }
        // Prose is a command or a sentence; external is a package or a URL; a
        // ref is a branch and a route is a URL. None of the four is a symbol
        // the repo could have lost, and grepping the source for `/` or for a
        // branch name produces noise rather than evidence.
        if (c.kind === 'prose' || c.kind === 'external') continue;
        if (c.kind === 'ref' || c.kind === 'route') continue;
        const key = `${c.kind}:${c.needle}`;
        if (!seen.has(key)) {
          // `MAX_REFERENTS` bounds the factor the SCAN multiplies by. It does
          // not bound provenance: a referent already collected used to accrue
          // its `from` list without limit, which is how one referent named by
          // 2.16M entries reached a 50MB stdout line. `MAX_FROM` bounds that
          // list; `fromTotal` keeps the true count, so the report can say the
          // referent is named 2.16M times without holding 2.16M records.
          if (seen.size >= MAX_REFERENTS) { droppedReferents += 1; continue; }
          seen.set(key, { ...c, from: [], fromTotal: 0 });
        }
        const rec = seen.get(key);
        rec.fromTotal += 1;
        if (rec.from.length < MAX_FROM) rec.from.push({ file, lead: entry.lead });
        else droppedFrom += 1;
      }
    }
  }
}

if (droppedReferents > 0) {
  process.stderr.write(
    `todokeeper: stopped collecting at ${MAX_REFERENTS} distinct referents; `
    + `${droppedReferents} more were not scanned. This scan is one pass over every `
    + 'file in the read budget PER referent, so the count has to be bounded. '
    + 'Verdicts below cover the first ' + MAX_REFERENTS + ' only.\n',
  );
}

if (droppedEntries > 0) {
  process.stderr.write(
    `todokeeper: stopped at ${MAX_ENTRIES} entries; ${droppedEntries} more were not read. `
    + 'Referents named only by those entries are missing from the verdicts below.\n',
  );
}

if (droppedFrom > 0) {
  process.stderr.write(
    `todokeeper: ${droppedFrom} provenance record(s) past the ${MAX_FROM}-per-referent limit were `
    + 'dropped. Verdicts are unaffected — this only shortens the `named by` list.\n',
  );
}

const report = [];

for (const ref of seen.values()) {
  if (ref.kind === 'path' || ref.kind === 'glob') {
    let verdict = 'PATH-MISSING';
    if (ref.resolved) verdict = 'PATH-EXISTS';
    // `dist/index.html` is not missing; it was never looked at. Excluded by
    // config is a different fact from absent from the repo, and conflating them
    // reports the tool's own configured blind spot as the repo's problem.
    //
    // But `ignoredByConfig` splits that bucket again, and the second half is
    // not a blind spot — it is a suppression. `.todokeeper.json` ships inside
    // the audited repo, so one commit can delete a file an entry names AND add
    // its directory to `ignore`; the referent then reads PATH-NOT-SCANNED,
    // which a human scans past as "out of scope".
    else if (ref.ignored) verdict = 'PATH-NOT-SCANNED';
    report.push({ ...ref, verdict, hits: [] });
    continue;
  }

  let codeHits = 0;
  let commentHits = 0;
  let docHits = 0;
  const samples = [];

  for (const [abs, text] of contents) {
    if (!text.includes(ref.needle)) continue;
    const path = rel(root, abs);
    const isDoc = DOC_FILE.test(path);
    for (const hit of scanFile(text, ref.needle, path)) {
      if (isDoc) docHits += 1;
      else if (hit.commented) commentHits += 1;
      else codeHits += 1;
      if (samples.length < 4) samples.push({ path, ...hit, doc: isDoc });
    }
  }

  let verdict;
  if (codeHits > 0) verdict = 'CODE';
  else if (commentHits > 0) verdict = 'COMMENT-ONLY';
  else if (docHits > 0) verdict = 'DOC-ONLY';
  else verdict = 'ABSENT';

  report.push({ ...ref, verdict, codeHits, commentHits, docHits, hits: samples });
}

if (asJson) {
  await writeStdout(`${jsonSafe({
    root,
    // `'git'` or `'walk'`. On `'walk'` nothing consulted `.gitignore`, so an
    // ABSENT or PATH-EXISTS verdict was reached over a different file set.
    enumeration: index.mode,
    // Three skips that are not verdicts and are not caps: a dropped symlink, an
    // `ignore` entry that excluded nothing, and a manifest this tool refused.
    // Each one narrows the scan the verdicts were reached over.
    droppedSymlinks: index.droppedSymlinks,
    unusedIgnores: index.unusedIgnores,
    skippedManifests: index.depsSkipped,
    referents: report,
    unreadTargets,
    droppedReferents,
    referentCap: MAX_REFERENTS,
    droppedEntries,
    entryCap: MAX_ENTRIES,
    droppedFrom,
    fromCap: MAX_FROM,
  })}\n`);
  process.exit(0);
}

const order = ['ABSENT', 'PATH-MISSING', 'COMMENT-ONLY', 'DOC-ONLY', 'PATH-NOT-SCANNED', 'CODE', 'PATH-EXISTS'];
const grouped = Object.fromEntries(order.map((k) => [k, []]));
for (const r of report) grouped[r.verdict].push(r);

console.log(`todokeeper dead — ${root}`);
console.log(`${report.length} distinct referents, scanned across ${contents.size} files`);
// Said every run, because it is the difference between honouring `.gitignore`
// and not, and the reader cannot tell from the verdicts which one happened.
if (index.mode === 'git') {
  console.log('Enumeration: git — .gitignore, .git/info/exclude and your global excludes all applied.\n');
} else {
  console.log('Enumeration: directory walk — this root is not a git work tree, so .gitignore was');
  console.log('NOT consulted and ignored files WERE read. `ignore` in .todokeeper.json is the only');
  console.log('exclusion in effect here.\n');
}

if (unreadTargets.length) {
  console.log(`UNREAD TARGET (${unreadTargets.length}): ${unreadTargets.map(safeField).join(', ')}`);
  console.log('No referent from these files was collected — see stderr for why.\n');
}

if (index.droppedSymlinks.length) {
  console.log(`SYMLINK NOT SCANNED (${index.droppedSymlinks.length}): ${notedList(index.droppedSymlinks)}`);
  console.log('Links are never followed. A doc reached only through one is absent from every verdict.\n');
}

if (index.unusedIgnores.length) {
  console.log(`IGNORE ENTRY MATCHED NOTHING (${index.unusedIgnores.length}): ${notedList(index.unusedIgnores)}`);
  console.log('Not an error. A typo looks exactly like protection, so check the spelling.\n');
}

for (const { file, reason } of index.depsSkipped) {
  console.log(`MANIFEST NOT READ: ${safeField(file)} — it ${safeField(reason)}`);
  console.log('Referents naming a declared dependency may appear below as missing repo files.\n');
}

const explain = {
  ABSENT: 'no occurrence anywhere in the repo — the entry names something gone',
  'PATH-MISSING': 'the entry names a file or directory that does not exist',
  'COMMENT-ONLY': 'every occurrence is inside a comment — probable tombstone, the thing is gone and a comment explains why',
  'DOC-ONLY': 'occurs only in prose/markdown — described but not used',
  'PATH-NOT-SCANNED': 'the path is excluded by `ignore` or by .gitignore — this tool never looked, which is not the same as absent',
  CODE: 'occurs in code outside any comment — alive',
  'PATH-EXISTS': 'the path is there',
};

for (const key of order) {
  const list = grouped[key];
  if (!list.length) continue;
  const quiet = key === 'CODE' || key === 'PATH-EXISTS' || key === 'PATH-NOT-SCANNED';
  console.log(`${key} (${list.length}) — ${explain[key]}`);
  if (quiet) {
    // One exception to quiet, and it is the whole reason `ignoredByConfig`
    // exists: a directory this tool ignores BY DEFAULT is a blind spot the
    // operator already knows about, while a directory the SCANNED REPO added to
    // `ignore` is the audited party choosing what the audit may see. Same
    // bucket, opposite provenance. Printing the count alone is what lets the
    // second one pass for the first.
    const bySuppression = list.filter((r) => r.ignoredByConfig);
    if (bySuppression.length) {
      console.log(`  ${bySuppression.length} of these were excluded by this repo's own .todokeeper.json`);
      console.log('  or .gitignore, not by todokeeper\'s defaults. Check the entry before reading');
      console.log('  it as out of scope:');
      for (const r of bySuppression) {
        // The source is named because the two send a reader to different files,
        // and `.gitignore` is the one they would not think to open.
        const where = r.ignoredBySource === 'gitignore' ? '.gitignore' : '.todokeeper.json';
        console.log(`    \`${safeField(r.raw)}\`  — under \`${safeField(r.ignoredBy)}\` (${where})`);
      }
    }
    console.log('');
    continue;
  }
  for (const r of list) {
    console.log(`  \`${safeField(r.raw)}\``);
    const named = r.from.map((f) => `${safeField(f.file)} :: ${safeField(f.lead.slice(0, 56))}`).join(' | ');
    const more = r.fromTotal > r.from.length ? ` | +${r.fromTotal - r.from.length} more` : '';
    console.log(`    named by: ${named}${more}`);
    for (const h of r.hits) console.log(`    ${safeField(h.path)}:${h.line}  ${safeField(h.text)}`);
  }
  console.log('');
}

if (droppedEntries > 0) {
  console.log(`ENTRY CAP HIT — ${droppedEntries} entr${droppedEntries === 1 ? 'y' : 'ies'} past the ${MAX_ENTRIES} limit were not read.`);
  console.log('Referents named only by those entries are absent from this report entirely.');
  console.log('');
}

console.log('COMMENT-ONLY is the finding this script exists for, and it is the one to read by hand:');
console.log('a tombstone comment is exactly what a naive grep scores as PRESENT.');
console.log('');
console.log('Two shapes it cannot see. An entry that names its FIX rather than its problem inverts');
console.log('the signal — the fix is present and the entry still open, or absent and the entry done.');
console.log('And a repo-wide rename or restructure resets every referent at once, so recent churn');
console.log('says nothing about any individual entry for a while after one.');
