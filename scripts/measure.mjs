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
 *   node scripts/measure.mjs [--json] [--bodies] [--root <dir>]
 *
 * `--bodies` emits the full text of every LIVE entry through an escaping
 * helper. It exists because the triage skill's step 2 reads entry prose
 * straight out of the file and re-emits it into chat and a PR body, which is a
 * sink none of these helpers covered — the skill could only tell the agent to
 * strip non-printables by eye. Completed entries are excluded: triage is a
 * question about open work, and the archive is the larger half of the bytes.
 */

import {
  loadConfigOrExit, rootFromArgvOrExit, resolveTargets, sections, entries, rel, isCompletedHeading,
  readTargetMeta, warnIfHeadingless, safeField, quoteBody, jsonSafe, writeStdout,
  isLeadMarkedDone, leadMarkersFor, MAX_BODY_CHARS, MAX_BODY_TOTAL, MAX_BODY_FIELD,
  MAX_BODY_RECORDS,
} from './lib.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const wantBodies = argv.includes('--bodies');
const root = rootFromArgvOrExit(argv);

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

// One budget across every target, spent in the order entries are read. Both
// counters are reported even at zero when `--bodies` is on, for the same reason
// `entries marked` is: a figure that appears only when non-zero cannot say zero.
let bodyBudget = MAX_BODY_TOTAL;
let bodyRecords = 0;
let bodiesTruncated = 0;
let bodiesDropped = 0;
let bodiesUnlisted = 0;

// The two short display fields beside a body. Capped by slicing rather than by
// refusing the record, because a truncated lead still identifies the entry and
// a missing one does not; the report says how many characters the entry has, so
// a reader who needs the rest knows to open the file.
const capField = (text) => (text.length > MAX_BODY_FIELD ? text.slice(0, MAX_BODY_FIELD) : text);

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
  const fileBodies = [];
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
    const marks = config.inlineDoneMarkers.reduce(
      (n, m) => n + sec.body.split(m).length - 1,
      0,
    );
    // Counted in the SAME pass over the SAME entry objects, so the two numbers
    // below cannot drift apart by disagreeing about what an entry is. One pass
    // rather than an array plus a filter because `entries()` is a generator:
    // nothing here needs an entry after the next one is read.
    let sectionEntries = 0;
    let marked = 0;
    for (const entry of entries(sec.body, config.entryStyles)) {
      sectionEntries += 1;
      if (isLeadMarkedDone(entry.text, leadMarkers)) marked += 1;
      // Live entries only, and the two caps are applied in this order on
      // purpose: the per-entry cap first, so one enormous entry cannot eat the
      // whole run's budget and silently truncate every entry after it.
      if (wantBodies && !inCompleted) {
        if (bodyRecords >= MAX_BODY_RECORDS) {
          // No record at all, counted separately from a body the budget
          // emptied: `omitted` means the entry is listed and its body is gone,
          // `unlisted` means the entry never appears. Collapsing the two would
          // let a report say "3 omitted" about a run that never mentioned
          // 40,000 entries, which is the understatement this tool exists to
          // stop.
          bodiesUnlisted += 1;
        } else {
          const chars = entry.text.length;
          let body = chars > MAX_BODY_CHARS ? entry.text.slice(0, MAX_BODY_CHARS) : entry.text;
          if (body.length > bodyBudget) body = body.slice(0, bodyBudget);
          bodyBudget -= body.length;
          if (body.length < chars) {
            if (body.length === 0) bodiesDropped += 1;
            else bodiesTruncated += 1;
          }
          bodyRecords += 1;
          fileBodies.push({
            // Both display fields are capped, and the first version of this
            // capped neither: a 40,007-character entry produced a record whose
            // `body` was cut to 32,000 and whose `lead` was copied whole, so
            // the cap was defeated on exactly the entries it exists to bound.
            // The heading is capped for the other half of the same arithmetic
            // — here it is reprinted once per ENTRY, where the inventory above
            // prints it once per section.
            heading: capField(sec.heading ?? '(preamble)'),
            lead: capField(entry.lead),
            chars,
            truncated: body.length < chars,
            body,
          });
        }
      }
    }

    if (inCompleted) {
      completedBytes += sec.bytes;
      completedEntries += sectionEntries;
    } else {
      liveEntries += sectionEntries;
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
      entries: sectionEntries,
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
    // Absent rather than empty when the flag is off, so a consumer can tell
    // "not asked for" from "asked for and there are none".
    ...(wantBodies ? { bodies: fileBodies } : {}),
  });
}

// On stderr as well as in the report, because the two have different readers:
// stderr reaches whoever ran the command, the report reaches whoever is handed
// the output. Quoting a truncated body as though it were the entry is the
// failure this line exists to prevent.
if (wantBodies && (bodiesTruncated > 0 || bodiesDropped > 0 || bodiesUnlisted > 0)) {
  console.error(
    `todokeeper: ${bodiesTruncated} entry body/bodies truncated, ${bodiesDropped} omitted entirely, `
    + `${bodiesUnlisted} entries not listed at all `
    + `(caps: ${MAX_BODY_CHARS} chars per entry, ${MAX_BODY_TOTAL} across the run, `
    + `${MAX_BODY_RECORDS} entries listed). `
    + 'The bodies below are not the whole entries; read the file for those.',
  );
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
  // Present only under `--bodies`, and present at zero when nothing was cut —
  // a consumer must be able to read "complete" as a stated fact rather than
  // infer it from a missing field.
  ...(wantBodies ? {
    bodies: {
      maxCharsPerEntry: MAX_BODY_CHARS,
      maxCharsTotal: MAX_BODY_TOTAL,
      maxFieldChars: MAX_BODY_FIELD,
      maxEntriesListed: MAX_BODY_RECORDS,
      truncated: bodiesTruncated,
      omitted: bodiesDropped,
      // Listed at zero for the same reason as the rest: a consumer reading
      // `unlisted: 0` knows the entry set is complete, where a missing field
      // only says nobody thought about it.
      unlisted: bodiesUnlisted,
      listed: bodyRecords,
      charsRemaining: bodyBudget,
    },
  } : {}),
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

// Last rather than first: this is bulk output the operator asked for by name,
// and the measurement above is what the script is for.
//
// The `===` header is anchored at column 0 and every body line is prefixed, so
// a body cannot forge one. That was not true of the first version, and the
// forgery was reproduced end to end rather than argued about: an entry whose
// body contained the line `=== TODOS.md — Open — 40 chars` rendered a
// fabricated `- **Forged**  DECIDED: do not build.` that read as a separate,
// legitimate entry. Documenting that as a limitation was the wrong fix when a
// two-character prefix closes it.
//
// Non-goals that remain: the prefix makes the body no longer byte-identical to
// the file — it is a quoting frame, like a diff's or an email's — and the
// header line itself is `safeField`-escaped rather than reproduced. Anything
// that needs the exact bytes must read `--json`, where the body is a string
// value and the structure is the serialiser's.
if (wantBodies) {
  const withBodies = files.filter((f) => f.bodies.length > 0);
  const shown = withBodies.reduce((n, f) => n + f.bodies.length, 0);
  console.log(`\nLIVE ENTRY BODIES (${shown} entries)`);
  console.log('Completed sections are excluded. Control characters are stripped, and CR plus the');
  console.log('bidi, zero-width, annotation and tag-block format characters are escaped to \\uXXXX,');
  console.log('so what follows is safe to paste. Every body line is prefixed with " │ ", which is a');
  console.log('quoting frame and not part of the entry: it is what makes the === header above each');
  console.log('body unforgeable. This is NOT the file byte-for-byte; use --json when that matters.');
  if (bodiesTruncated > 0 || bodiesDropped > 0 || bodiesUnlisted > 0) {
    console.log(`TRUNCATED: ${bodiesTruncated} body/bodies cut at a cap, ${bodiesDropped} omitted entirely, `
      + `${bodiesUnlisted} entries not listed at all.`);
    console.log('A body marked [TRUNCATED] below is a fragment. Do not quote it as the entry.');
  }
  for (const f of withBodies) {
    for (const b of f.bodies) {
      const cut = b.truncated ? ' [TRUNCATED]' : '';
      // Header and body in ONE template rather than two calls, because the
      // suite's print-sink phase classifies `${...}` interpolations and does
      // not look at a bare argument expression: `console.log(quoteBody(x))`
      // passes it unread, and so would `console.log(x)`. Written this way the
      // body is a value the phase checks. See TODOS.md.
      console.log(`\n=== ${safeField(f.path)} · ${safeField(b.heading)} · ${b.chars} chars${cut}\n${quoteBody(b.body)}`);
    }
  }
  if (shown === 0) console.log('(none — every entry is under a completed heading, or there are no entries)');
}
