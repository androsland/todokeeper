#!/usr/bin/env node
/**
 * todokeeper stale — which entries has the repo moved on without?
 *
 * The signal is a comparison of two commit dates:
 *
 *   git log -S"<the entry's distinctive phrase>" -1 -- <todos path>   when the ENTRY last changed
 *   git log -1 -- <path the entry names>                              when its REFERENT last changed
 *
 * An entry whose referents have all churned since the entry itself last moved
 * is SUSPECT: the code it describes has been edited, possibly several times,
 * and nobody revisited the note. That is evidence, not a verdict — plenty of
 * entries stay true across refactors of the file they name.
 *
 * The inverse is just as informative and is reported too: an entry nobody has
 * touched whose referents nobody has touched either is not stale, it is simply
 * cold. Distinguishing the two is the point.
 *
 * Usage:
 *   node scripts/stale.mjs [--json] [--min-days N] [--root <dir>]
 */

import {
  loadConfigOrExit, repoRoot, resolveTargets, sections, entries,
  lastCommitTouching, lastCommitChangingPhrase, classifyReferent,
  buildFileIndex, rel, daysBetween, isCompletedHeading,
  readTarget, safe, jsonSafe, MAX_ENTRIES,
} from './lib.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const rootArg = argv.indexOf('--root');
const root = rootArg !== -1 ? argv[rootArg + 1] : repoRoot();
const minDaysArg = argv.indexOf('--min-days');
const minDays = minDaysArg !== -1 ? Number(argv[minDaysArg + 1]) : 0;

const config = loadConfigOrExit(root);
const targets = resolveTargets(root, config);

if (targets.length === 0) {
  console.error(`todokeeper: no deferred-work file found. Looked for: ${config.targets.map(safe).join(', ')}`);
  process.exit(2);
}

const targetSpecs = targets.map((t) => rel(root, t));
const index = buildFileIndex(root, config.ignore);

// git log -S over the same phrase repeatedly is the slow part; entries in one
// file share a pathspec, so the cache keys on phrase alone per run.
const phraseCache = new Map();
const pathCache = new Map();

const results = [];
const unreadTargets = [];
// One `git log -S` child per distinct entry needle, so entry count is a process
// count. Bounded for the same reason `dead.mjs` bounds referents.
let entriesSeen = 0;
let droppedEntries = 0;

for (const abs of targets) {
  const file = rel(root, abs);
  // An unread target contributes no entries, so its live work is absent from
  // every bucket below rather than landing in a wrong one. Announced, because
  // "0 suspect" from a file nobody read reads exactly like a clean sweep.
  const text = readTarget(abs, file);
  if (text === null) { unreadTargets.push(file); continue; }
  let completedDepth = null;

  for (const sec of sections(text)) {
    const completedHere = sec.heading != null && isCompletedHeading(sec.heading, config.completedHeadings);
    if (sec.heading != null && completedDepth != null && sec.depth <= completedDepth && !completedHere) {
      completedDepth = null;
    }
    if (completedHere) completedDepth = sec.depth;
    // Finished work does not go stale. Skip it rather than filling the report.
    if (completedDepth != null) continue;

    for (const entry of entries(sec.body, config.entryStyles)) {
      entriesSeen += 1;
      if (entriesSeen > MAX_ENTRIES) { droppedEntries += 1; continue; }
      const phrase = entry.lead;
      // The needle is the raw-bytes form; the lead is the display form. They
      // differ whenever the entry's bold lead wraps across lines.
      const needle = entry.needle;
      if (!phrase) continue;

      if (needle && !phraseCache.has(needle)) {
        phraseCache.set(needle, lastCommitChangingPhrase(root, needle, targetSpecs));
      }
      const entryCommit = needle ? phraseCache.get(needle) : null;

      const referents = [];
      for (const raw of entry.referents) {
        const c = classifyReferent(raw, index);
        // Only things that resolve to somewhere in the tree can be dated.
        // Symbols, packages, URLs and commands are the dead.mjs surface.
        if (c.kind !== 'path' && c.kind !== 'glob') continue;
        const resolved = c.resolved;
        if (!resolved) {
          // Not scanned is not the same as not there. A path under `dist/` or
          // `node_modules/` was excluded by config, and calling it missing
          // would be the tool's own blind spot reported as the repo's fault.
          referents.push({
            path: c.needle,
            raw,
            status: c.ignored ? 'not-scanned' : 'missing',
            // Which side put it out of reach: todokeeper's defaults, or the
            // audited repo's own `.todokeeper.json`. Same bucket, and only the
            // second one is the audited party choosing what the audit sees.
            ignoredBy: c.ignoredBy ?? null,
            ignoredByConfig: c.ignoredByConfig ?? false,
            commit: null,
          });
          continue;
        }
        if (!pathCache.has(resolved)) {
          pathCache.set(resolved, lastCommitTouching(root, [resolved]));
        }
        referents.push({ path: resolved, raw, status: 'present', commit: pathCache.get(resolved) });
      }

      const dated = referents.filter((r) => r.commit);
      const newest = dated.length
        ? dated.reduce((a, b) => (new Date(b.commit.date) > new Date(a.commit.date) ? b : a))
        : null;

      let status = 'no-path-referent';
      let gapDays = null;
      if (referents.some((r) => r.status === 'missing')) {
        status = 'referent-missing';
      } else if (!entryCommit) {
        status = 'entry-uncommitted';
      } else if (newest) {
        gapDays = daysBetween(newest.commit.date, entryCommit.date);
        status = gapDays > minDays ? 'suspect' : 'cold';
      }

      results.push({
        file,
        section: sec.heading ?? '(preamble)',
        lead: phrase,
        entryCommit,
        referents,
        newestReferent: newest,
        gapDays,
        status,
      });
    }
  }
}

if (droppedEntries > 0) {
  process.stderr.write(
    `todokeeper: stopped at ${MAX_ENTRIES} entries; ${droppedEntries} more were not dated. `
    + 'Each entry costs a `git log -S` child process, so the count has to be bounded. '
    + 'Every bucket below is incomplete by that many entries — a "0 suspect" here does '
    + 'not mean the file is clean.\n',
  );
}

if (asJson) {
  console.log(jsonSafe({
    root, minDays, entries: results, unreadTargets, droppedEntries, entryCap: MAX_ENTRIES,
  }));
  process.exit(0);
}

const buckets = {
  'referent-missing': [],
  suspect: [],
  cold: [],
  'no-path-referent': [],
  'entry-uncommitted': [],
};
for (const r of results) buckets[r.status].push(r);

const short = (s, n = 72) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const day = (iso) => (iso ? iso.slice(0, 10) : '—');

console.log(`todokeeper stale — ${root}`);
console.log(`${results.length} live entries across ${targets.length - unreadTargets.length} file(s)\n`);

if (unreadTargets.length) {
  console.log(`UNREAD TARGET (${unreadTargets.length}): ${unreadTargets.map(safe).join(', ')}`);
  console.log('No entry from these files reached any bucket below — see stderr for why.\n');
}

if (droppedEntries > 0) {
  console.log(`ENTRY CAP HIT — ${droppedEntries} entr${droppedEntries === 1 ? 'y' : 'ies'} past the ${MAX_ENTRIES} limit were not dated.`);
  console.log('Every count below is short by that many. See stderr.\n');
}

const suppressed = results.flatMap(
  (r) => r.referents.filter((x) => x.ignoredByConfig).map((x) => ({ file: r.file, lead: r.lead, ref: x })),
);
if (suppressed.length) {
  console.log(`EXCLUDED BY THIS REPO'S OWN CONFIG (${suppressed.length}) — not by todokeeper's defaults`);
  console.log('`.todokeeper.json` ships inside the repo being audited, so this bucket is the');
  console.log('audited party choosing what the audit may see. Read these before treating a');
  console.log('`not-scanned` referent as out of scope:');
  for (const s of suppressed) {
    console.log(`  ${safe(s.file)} :: ${safe(short(s.lead))}`);
    console.log(`    \`${safe(s.ref.raw)}\` — under \`${safe(s.ref.ignoredBy)}\``);
  }
  console.log('');
}

if (buckets['referent-missing'].length) {
  console.log(`REFERENT MISSING (${buckets['referent-missing'].length}) — the entry names a path that no longer exists`);
  for (const r of buckets['referent-missing']) {
    const gone = r.referents.filter((x) => x.status === 'missing').map((x) => x.raw);
    console.log(`  ${safe(r.file)} :: ${safe(short(r.lead))}`);
    console.log(`    gone: ${gone.map(safe).join(', ')}`);
  }
  console.log('');
}

if (buckets.suspect.length) {
  console.log(`SUSPECT (${buckets.suspect.length}) — referents changed AFTER the entry last did`);
  for (const r of [...buckets.suspect].sort((a, b) => b.gapDays - a.gapDays)) {
    console.log(`  ${r.gapDays}d  ${safe(r.file)} :: ${safe(short(r.lead))}`);
    console.log(`      entry last changed ${day(r.entryCommit?.date)}  (${r.entryCommit?.hash.slice(0, 8) ?? '—'})`);
    console.log(`      ${safe(r.newestReferent.path)} changed ${day(r.newestReferent.commit.date)}  (${r.newestReferent.commit.hash.slice(0, 8)}) ${safe(short(r.newestReferent.commit.subject, 48))}`);
  }
  console.log('');
}

console.log(`cold ${buckets.cold.length} · no path referent ${buckets['no-path-referent'].length} · uncommitted ${buckets['entry-uncommitted'].length}`);
console.log('');
console.log('SUSPECT means the code moved and the note did not. It does NOT mean the note is wrong —');
console.log('read it. A note about a constraint often survives every refactor of the file it names.');
console.log('"no path referent" is the blind half: an entry that describes its subject in prose, or');
console.log('whose subject is outside the repo entirely, cannot be dated by this method at all.');
