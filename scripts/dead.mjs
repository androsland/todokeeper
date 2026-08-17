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
  loadConfigOrExit, repoRoot, resolveTargets, sections, entries,
  classifyReferent, buildFileIndex, walkFiles, isText, rel, isCompletedHeading,
  readTarget, safe, jsonSafe, MAX_REFERENTS,
} from './lib.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const rootArg = argv.indexOf('--root');
const root = rootArg !== -1 ? argv[rootArg + 1] : repoRoot();

const config = loadConfigOrExit(root);
const targets = resolveTargets(root, config);

if (targets.length === 0) {
  console.error(`todokeeper: no deferred-work file found. Looked for: ${config.targets.map(safe).join(', ')}`);
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
const seen = new Map();

const unreadTargets = [];
// The count this script has to bound, because the scan below is one pass over
// the whole in-budget corpus PER distinct referent. See `MAX_REFERENTS`.
let droppedReferents = 0;

for (const abs of targets) {
  const file = rel(root, abs);
  // Capped like every other file this script reads. Skipping one target still
  // reports the referents named by the others; the skip is announced below,
  // because a referent nobody collected cannot be ABSENT — it was never asked.
  const text = readTarget(abs, file);
  if (text === null) { unreadTargets.push(file); continue; }
  let completedDepth = null;

  for (const sec of sections(text)) {
    const completedHere = sec.heading != null && isCompletedHeading(sec.heading, config.completedHeadings);
    if (sec.heading != null && completedDepth != null && sec.depth <= completedDepth && !completedHere) {
      completedDepth = null;
    }
    if (completedHere) completedDepth = sec.depth;
    if (completedDepth != null) continue;

    for (const entry of entries(sec.body, config.entryStyles)) {
      for (const raw of entry.referents) {
        const c = classifyReferent(raw, index);
        // Prose is a command or a sentence; external is a package or a URL; a
        // ref is a branch and a route is a URL. None of the four is a symbol
        // the repo could have lost, and grepping the source for `/` or for a
        // branch name produces noise rather than evidence.
        if (c.kind === 'prose' || c.kind === 'external') continue;
        if (c.kind === 'ref' || c.kind === 'route') continue;
        const key = `${c.kind}:${c.needle}`;
        if (!seen.has(key)) {
          // The cap is on DISTINCT referents, which is the factor the scan
          // multiplies by; a referent already collected keeps accruing its
          // `from` list for free.
          if (seen.size >= MAX_REFERENTS) { droppedReferents += 1; continue; }
          seen.set(key, { ...c, from: [] });
        }
        seen.get(key).from.push({ file, lead: entry.lead });
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
  console.log(jsonSafe({
    root, referents: report, unreadTargets, droppedReferents, referentCap: MAX_REFERENTS,
  }));
  process.exit(0);
}

const order = ['ABSENT', 'PATH-MISSING', 'COMMENT-ONLY', 'DOC-ONLY', 'PATH-NOT-SCANNED', 'CODE', 'PATH-EXISTS'];
const grouped = Object.fromEntries(order.map((k) => [k, []]));
for (const r of report) grouped[r.verdict].push(r);

console.log(`todokeeper dead — ${root}`);
console.log(`${report.length} distinct referents, scanned across ${contents.size} files\n`);

if (unreadTargets.length) {
  console.log(`UNREAD TARGET (${unreadTargets.length}): ${unreadTargets.map(safe).join(', ')}`);
  console.log('No referent from these files was collected — see stderr for why.\n');
}

const explain = {
  ABSENT: 'no occurrence anywhere in the repo — the entry names something gone',
  'PATH-MISSING': 'the entry names a file or directory that does not exist',
  'COMMENT-ONLY': 'every occurrence is inside a comment — probable tombstone, the thing is gone and a comment explains why',
  'DOC-ONLY': 'occurs only in prose/markdown — described but not used',
  'PATH-NOT-SCANNED': 'the path sits under an ignored directory — this tool never looked, which is not the same as absent',
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
      console.log(`  ${bySuppression.length} of these were excluded by this repo's own .todokeeper.json,`);
      console.log('  not by todokeeper\'s defaults. Check the entry before reading it as out of scope:');
      for (const r of bySuppression) {
        console.log(`    \`${safe(r.raw)}\`  — under \`${safe(r.ignoredBy)}\``);
      }
    }
    console.log('');
    continue;
  }
  for (const r of list) {
    console.log(`  \`${safe(r.raw)}\``);
    console.log(`    named by: ${r.from.map((f) => `${safe(f.file)} :: ${safe(f.lead.slice(0, 56))}`).join(' | ')}`);
    for (const h of r.hits) console.log(`    ${safe(h.path)}:${h.line}  ${safe(h.text)}`);
  }
  console.log('');
}

console.log('COMMENT-ONLY is the finding this script exists for, and it is the one to read by hand:');
console.log('a tombstone comment is exactly what a naive grep scores as PRESENT.');
console.log('');
console.log('Two shapes it cannot see. An entry that names its FIX rather than its problem inverts');
console.log('the signal — the fix is present and the entry still open, or absent and the entry done.');
console.log('And a repo-wide rename or restructure resets every referent at once, so recent churn');
console.log('says nothing about any individual entry for a while after one.');
