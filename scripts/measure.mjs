#!/usr/bin/env node
/**
 * todokeeper measure — the number, not the impression.
 *
 * Two figures decide whether a deferred-work file needs splitting, and they
 * diverge: the file's SIZE, and the MASS of finished work inside it. A file can
 * be large because it holds a lot of live work (splitting off completions buys
 * nothing) or because it is mostly archive (splitting is the whole win). Only
 * measuring tells them apart, and the failure this script exists to prevent is
 * a maintainer eyeballing the second figure and being wrong by 2.5x.
 *
 * Completed mass is counted TWICE over, because repos record completion two
 * ways: under a `## Completed`-style heading, and inline inside topical
 * sections as `✅ DONE` / `— SHIPPED` / `~~struck through~~`. A repo that never
 * adopted a Completed section reads as 0% on the first count and its real
 * archive shows up only in the second.
 *
 * The inline half is then reported TWO WAYS, because it is two questions:
 *
 *   entries marked  how many LIVE ENTRIES are marked done on their lead line
 *   inline done     how many marker OCCURRENCES the live sections contain
 *
 * They are different numbers and they never converge. Measured on one repo with
 * 110 live entries, the second reads 32 and the first reads 0 — every one of
 * the 32 is prose, a marker on a continuation line, or a struck SUB-bullet under
 * a live parent. A maintainer asking "how many of my open entries are actually
 * closed?" wants the first; a maintainer asking "does this file record
 * completions in place at all?" wants the second. Reporting only the second and
 * letting it be read as the first is the bug this pair exists to close.
 *
 * Usage:
 *   node scripts/measure.mjs [--json] [--root <dir>]
 */

import {
  loadConfigOrExit, repoRoot, resolveTargets, sections, entries, rel, isCompletedHeading,
  readTargetMeta, warnIfHeadingless, safeField, jsonSafe, writeStdout,
  isLeadMarkedDone, leadMarkersFor,
} from './lib.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const rootArg = argv.indexOf('--root');
const root = rootArg !== -1 ? argv[rootArg + 1] : repoRoot();

const config = loadConfigOrExit(root);
const targets = resolveTargets(root, config);

if (targets.length === 0) {
  const msg = `todokeeper: no deferred-work file found. Looked for: ${config.targets.map(safeField).join(', ')}`;
  if (asJson) await writeStdout(`${jsonSafe({ error: msg, targets: config.targets })}\n`);
  else console.error(msg);
  process.exit(2);
}

const files = [];
// A skipped target is the one thing this script must not report silently: every
// number below is a sum or a percentage over the files actually read, so a
// target dropped for size changes the total, the completed mass AND the
// threshold verdict. stderr alone would leave a wrong number on stdout with
// nothing beside it saying so.
const skipped = [];

// TWO SIZES, and which one answers which question is a decision, not an
// accident. `readTargetMeta` collapses CRLF to LF, so the text measured here is
// one byte per line smaller than the file on a CRLF checkout — 308.9KB read as
// 304.6KB on one measured 4,427-line file.
//
//  - Every RATIO uses `bytes`, the normalised text, on both sides. Taking the
//    denominator from the raw file while the section sizes come from normalised
//    text mismatches them and understates completed mass by about one byte per
//    line; on that same file 9.9% would print as 9.76%. Getting that figure
//    right is the entire reason this script exists, so this is the combination
//    to avoid.
//  - The THRESHOLD verdict uses `diskBytes`, because "is this file big enough to
//    split" is a question about the file on disk — the thing `ls` and the repo's
//    own size budget are talking about. It is labelled "on disk" in the report
//    for the same reason: an unexplained gap between `ls` and todokeeper is a
//    bug report waiting to happen.
for (const abs of targets) {
  const meta = readTargetMeta(abs, rel(root, abs));
  if (meta === null) { skipped.push(rel(root, abs)); continue; }
  const { text, diskBytes } = meta;
  const bytes = Buffer.byteLength(text, 'utf8');
  const secs = sections(text);
  warnIfHeadingless(secs, text, rel(root, abs));

  let completedBytes = 0;
  let completedEntries = 0;
  let liveEntries = 0;
  let inlineDone = 0;
  let markedLeads = 0;
  const inventory = [];
  const leadMarkers = leadMarkersFor(config);

  // A completed heading owns everything under it until a heading at the same or
  // shallower depth. Without that, a `### Archived` nested under `## Completed`
  // would be counted as live.
  let completedDepth = null;
  for (const sec of secs) {
    const completedHere = sec.heading != null && isCompletedHeading(sec.heading, config.completedHeadings);
    if (sec.heading != null && completedDepth != null && sec.depth <= completedDepth && !completedHere) {
      completedDepth = null;
    }
    if (completedHere) completedDepth = sec.depth;

    const inCompleted = completedDepth != null;
    const found = entries(sec.body, config.entryStyles);
    const marks = config.inlineDoneMarkers.reduce(
      (n, m) => n + sec.body.split(m).length - 1,
      0,
    );
    // Counted over the SAME entry objects `found` already holds, so the two
    // numbers below cannot drift apart by disagreeing about what an entry is.
    const marked = found.filter((e) => isLeadMarkedDone(e.text, leadMarkers)).length;

    if (inCompleted) {
      completedBytes += sec.bytes;
      completedEntries += found.length;
    } else {
      liveEntries += found.length;
      inlineDone += marks;
      // Live sections only, and for the same reason `inlineDone` is: an entry
      // under `## Completed` is already counted as finished by the heading, so
      // counting its `[x]` again would double-count the archive rather than
      // measure what this figure is for — completions recorded WITHOUT one.
      markedLeads += marked;
    }

    inventory.push({
      heading: sec.heading ?? '(preamble)',
      depth: sec.depth,
      bytes: sec.bytes,
      entries: found.length,
      completed: inCompleted,
      inlineDoneMarkers: inCompleted ? 0 : marks,
      entriesMarkedDone: inCompleted ? 0 : marked,
    });
  }

  files.push({
    path: rel(root, abs),
    bytes,
    diskBytes,
    lines: text.split('\n').length,
    completedBytes,
    completedPercent: bytes === 0 ? 0 : Number(((completedBytes / bytes) * 100).toFixed(1)),
    completedEntries,
    liveEntries,
    inlineDoneMarkers: inlineDone,
    // A count of live ENTRIES, so it is bounded by `liveEntries` and reads as a
    // fraction of it. `inlineDoneMarkers` beside it is a count of OCCURRENCES
    // and is bounded by nothing in particular — it can and does exceed the
    // entry count. Naming them apart in the JSON is the point.
    entriesMarkedDone: markedLeads,
    sections: inventory,
  });
}

const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
const totalDiskBytes = files.reduce((n, f) => n + f.diskBytes, 0);
const totalCompleted = files.reduce((n, f) => n + f.completedBytes, 0);
const totalInline = files.reduce((n, f) => n + f.inlineDoneMarkers, 0);
const totalLive = files.reduce((n, f) => n + f.liveEntries, 0);
const totalMarked = files.reduce((n, f) => n + f.entriesMarkedDone, 0);
const over = files.filter((f) => f.diskBytes >= config.splitThresholdBytes);

const verdict = {
  thresholdBytes: config.splitThresholdBytes,
  filesOverThreshold: over.map((f) => f.path),
  // `totalBytes` is the normalised text and is the denominator of the
  // percentage below; `totalDiskBytes` is what the threshold was compared
  // against. They are equal on an LF checkout and differ by one byte per line
  // on a CRLF one.
  totalBytes,
  totalDiskBytes,
  completedBytes: totalCompleted,
  completedPercent: totalBytes === 0 ? 0 : Number(((totalCompleted / totalBytes) * 100).toFixed(1)),
  inlineDoneMarkers: totalInline,
  // The denominator ships with the numerator. `entriesMarkedDone` alone is
  // unreadable — 4 is a lot out of 6 and nothing out of 400 — and a consumer
  // that had to re-derive the total by summing `files[].liveEntries` would get
  // a different answer the moment a target is skipped for size.
  liveEntries: totalLive,
  entriesMarkedDone: totalMarked,
  // Deliberately not a recommendation. Crossing the threshold is a fact; what
  // to do about it depends on whether the mass is archive or live work, and
  // that is a judgement this script refuses to make.
  crossed: over.length > 0,
  // Named, not counted: every figure in this object is incomplete by exactly
  // these files.
  skippedTargets: skipped,
};

if (asJson) {
  await writeStdout(`${jsonSafe({ root, config: config._source, files, verdict })}\n`);
  process.exit(0);
}

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
const pad = (s, n) => String(s).padEnd(n);

console.log(`todokeeper measure — ${root}`);
console.log(`config: ${config._source}\n`);

if (skipped.length) {
  console.log(`UNREAD (${skipped.length}): ${skipped.map(safeField).join(', ')}`);
  console.log('Every number below excludes these files — see stderr for why. Sizes,');
  console.log('completed mass and the threshold verdict are all incomplete by that much.\n');
}

for (const f of files) {
  console.log(`${safeField(f.path)}`);
  console.log(`  size            ${kb(f.diskBytes)} (${f.diskBytes.toLocaleString()} B on disk, ${f.lines} lines)`);
  if (f.diskBytes !== f.bytes) {
    console.log(`                  ${f.bytes.toLocaleString()} B of text after CRLF normalisation — every percentage below uses that`);
  }
  console.log(`  completed mass  ${kb(f.completedBytes)} (${f.completedBytes.toLocaleString()} B, ${f.completedPercent}% of file, ${f.completedEntries} entries)`);
  console.log(`  live entries    ${f.liveEntries}`);
  // Printed ALWAYS, 0 included. A figure that appears only when it is non-zero
  // cannot say zero: its absence reads as "not measured", and 0 here is a real,
  // common and correct answer — a repo with a working `## Completed` heading and
  // no in-place marking should read 0 and be told that 0 is fine.
  console.log(`  entries marked  ${f.entriesMarkedDone} of ${f.liveEntries} live entries marked done on their LEAD line`);
  if (f.entriesMarkedDone > 0) {
    console.log('                  -> completions recorded in place, so the percentage above understates the archive.');
  } else {
    console.log('                  -> 0 means nothing is recorded as finished in place. That is not a parse failure,');
    console.log('                     and not a defect on a repo that archives under a heading instead.');
  }
  if (f.inlineDoneMarkers > 0) {
    console.log(`  inline done     ${f.inlineDoneMarkers} marker(s) OUTSIDE any completed section`);
    // The count above is unchanged; this explains what it is, which is not what
    // the line above it measures. It used to claim the archive was understated,
    // and printed beside a `entries marked 0` that claim is simply false —
    // measured, 32 occurrences against 0 marked entries on one real repo.
    console.log('                  -> an OCCURRENCE count over whole section bodies, not a count of entries:');
    console.log('                     prose, continuation lines and struck sub-bullets all count here.');
  }
  const biggest = [...f.sections].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  console.log('  largest sections:');
  for (const s of biggest) {
    console.log(`    ${pad(kb(s.bytes), 8)} ${pad(`${s.entries}e`, 5)} ${s.completed ? '[completed] ' : ''}${'#'.repeat(Math.max(s.depth, 1))} ${safeField(s.heading)}`);
  }
  console.log('');
}

if (files.length > 1) {
  console.log(`total: ${kb(totalDiskBytes)} across ${files.length} files, ${verdict.completedPercent}% completed mass`);
  console.log(`       ${totalMarked} of ${totalLive} live entries marked done on their lead line\n`);
}

if (verdict.crossed) {
  console.log(`OVER THRESHOLD (${kb(config.splitThresholdBytes)} / ${config.splitThresholdBytes.toLocaleString()} B): ${verdict.filesOverThreshold.map(safeField).join(', ')}`);
  console.log('A split is relief, not a fix — the open half routinely stays over the threshold too.');
  console.log('Read the completed mass above before deciding: splitting a file whose archive is a');
  console.log('rounding error moves almost nothing and makes a stale section look maintained.');
} else {
  console.log(`under threshold (${kb(config.splitThresholdBytes)} / ${config.splitThresholdBytes.toLocaleString()} B) — one file costs less than keeping two in sync.`);
}
