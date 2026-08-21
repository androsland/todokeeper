#!/usr/bin/env node
/**
 * todokeeper smoke test — `node test/smoke.mjs`
 *
 * WHY THIS EXISTS, stated plainly because the reason is the design:
 *
 * A rename of one internal helper (`isIgnoredPath` -> `ignoringSegment`) was
 * applied to the path branch of `classifyReferent` and missed the glob branch
 * twelve lines above it. `node --check` passes on an undefined reference — it
 * parses, it does not resolve — so all four scripts still "checked out" clean
 * while `dead.mjs` and `stale.mjs` crashed with a ReferenceError on any repo
 * whose deferred-work file names a glob. Every hand-run proof-of-concept that
 * round happened to use a plain path, so none of them took the broken branch.
 * It was caught by diffing JSON output against five real repos by hand.
 *
 * So the shape of this file follows the shape of that failure: it EXECUTES
 * every branch of the classifier, and it RUNS all four scripts end to end.
 * A test that imports a module and asserts nothing about its branches would
 * not have caught this, and neither would another syntax check.
 *
 * Zero dependencies and no framework, deliberately — this repo ships no
 * package.json and adding one to get a test runner would put a dependency
 * tree behind a 200-line smoke test.
 *
 * WHAT IT DOES NOT COVER, so a pass is not read as more than it is:
 *  - It does not exercise `MAX_REFERENTS` / `MAX_ENTRIES`. Reaching either cap
 *    means building a 5,000-referent fixture, which measured 8.2s and 39s
 *    respectively; that is a benchmark, not a smoke test. The caps are proven
 *    by hand and recorded in TODOS.md, and nothing here would notice if one
 *    were deleted.
 *  - It asserts that verdicts are WELL-FORMED, with two exceptions: the
 *    call-form pair asserts CODE and COMMENT-ONLY by name, so a symbol tier
 *    that stopped separating a live call from a tombstone would fail here.
 *    Everything else is shape-checked only, and the fixture is small enough to
 *    reason about rather than large enough to be a corpus. Measured, not
 *    assumed: reclassifying both symbol returns as prose fails 7 checks here
 *    against 4 on the tree before this phase existed — and 3 of those 4 are
 *    collateral, tripping only because the report empties. The rest is still
 *    caught only by the real-repo parity diff described above.
 *  - The control-byte scan covers the four `scripts/*.mjs` and this file. Not
 *    SKILL.md, not README.md, not any config or fixture — and nothing runs this
 *    suite for you, so it protects the edits of whoever remembers to run it.
 *  - The symlink escapes are covered only where the PLATFORM can create a
 *    symlink. An unprivileged Windows account cannot, and phase 8 then prints
 *    a SKIP and proves nothing about links — read the run's output, not this
 *    file, to know which happened. The skip is loud on purpose: the same four
 *    checks passing and never running look identical in a summary line.
 *  - It runs on one platform, in one shell, with whatever git is installed.
 *    `stale.mjs` shells out to `git log -S`; a git old enough to lack a flag it
 *    uses fails here as a test error, which is the right outcome but is not the
 *    same as supporting that git.
 *  - The enumeration phases cover a work-tree root and a non-git root. They do
 *    NOT cover a root BELOW a work tree's toplevel, a git binary that is
 *    missing rather than failing, a listing past the 64MB buffer, or a
 *    submodule gitlink — all four take the same fallback branch, and only the
 *    non-git one is exercised here.
 *  - Nothing here sees personal data that was never gitignored and never named
 *    in `ignore`. No test can: there is no property of such a file that
 *    distinguishes it from source.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULTS, classifyReferent, buildFileIndex, loadConfig, entries,
  MAX_ENTRIES as DEAD_ENTRY_CAP, MAX_FROM as DEAD_FROM_CAP,
} from '../scripts/lib.mjs';

const IGNORED_DIR = 'interview';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

let failures = 0;
let checks = 0;

function check(name, ok, detail = '') {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
}

// ---------------------------------------------------------------- the fixture

/**
 * A repo small enough to reason about that still names a referent of every
 * kind the classifier can return, plus both provenances of exclusion:
 * `node_modules/` is a todokeeper default, `internal/` is added by the
 * fixture's own `.todokeeper.json`.
 */
function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'todokeeper-smoke-'));
  const put = (p, body) => {
    mkdirSync(join(root, dirname(p)), { recursive: true });
    writeFileSync(join(root, p), body);
  };

  put('src/app.ts', 'export const app = 1;\n');
  put('src/helpers/thing.ts', 'export const thing = 1;\n');
  put('docs/guide.md', '# guide\n');
  put('internal/secret.ts', 'export const s = 1;\n');
  put('node_modules/dep/index.js', 'module.exports = 1;\n');
  // The call-form pair. `stillCalled` is defined and called in code and nowhere
  // writes the empty-paren form; `wasCalled()` exists only as a tombstone
  // comment. A referent written `stillCalled()` must reach the first and must
  // NOT drag the second along with it.
  put('src/calls.ts', [
    '// `wasCalled()` went away with the old pipeline — nothing calls it now.',
    'export function stillCalled(n) { return n + 1; }',
    'export const total = stillCalled(1);',
    '',
  ].join('\n'));

  // `ignore` REPLACES the defaults rather than merging with them, so the
  // defaults are restated here; `internal` is the one this config adds.
  put('.todokeeper.json', `${JSON.stringify({
    ignore: [...DEFAULTS.ignore, 'internal'],
  }, null, 2)}\n`);

  put('TODOS.md', [
    '# TODOS',
    '',
    '## Open',
    '',
    '- **A path that resolves** — `src/app.ts` needs a second look.',
    '- **A path that does not** — `src/gone.ts` was deleted.',
    '- **A glob under a default-ignored dir** — `node_modules/**/*.js` is noise.',
    '- **A glob under a config-ignored dir** — `internal/*.ts` is excluded here.',
    '- **A path under a config-ignored dir** — `internal/secret.ts` too.',
    '- **A symbol** — \`buildFileIndex\` changed shape.',
    '- **A call form still called** — \`stillCalled()\` needs a second argument.',
    '- **A call form with only a tombstone** — \`wasCalled()\` is gone.',
    '- **A route** — `/el/` still redirects.',
    '- **A package** — `@scope/pkg` is pinned.',
    '- **A directory** — `docs` needs an index.',
    '',
    '## Completed',
    '',
    '- **Something finished** — `src/helpers/thing.ts` landed.',
    '',
  ].join('\n'));

  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'smoke@example.invalid');
  git('config', 'user.name', 'smoke');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return root;
}

// ------------------------------------------------- 1. classifier branch sweep

function testClassifier(root) {
  const config = loadConfig(root);
  const index = buildFileIndex(root, config.ignore);

  // Every branch the classifier can return, named by the input that reaches it.
  // The point is coverage of the BRANCHES, not of the taxonomy: an unreferenced
  // identifier inside any one of these is invisible until the branch is taken.
  const cases = [
    ['src/app.ts', 'path'],
    ['src/gone.ts', 'path'],
    ['docs', 'path'],
    ['node_modules/**/*.js', 'glob'],
    ['internal/*.ts', 'glob'],
    ['docs/*.md', 'glob'],
    ['buildFileIndex', 'symbol'],
    ['stillCalled()', 'symbol'],
    ['/el/', 'route'],
    ['@scope/pkg', 'external'],
    ['https://example.com', 'external'],
    ['example.com', 'external'],
    ['origin/main', 'ref'],
    ['two words here', 'prose'],
    // Leading slash resolves against the tree rather than guessing from shape.
    // `/el/index.html` is a URL, not a repo file, and used to reach the path
    // branch purely because it carried a known extension; `/src/app.ts` is the
    // repo-root convention and must survive. `/docs` is a real directory and
    // still reads as a route on purpose — see the FILES-only note in lib.mjs.
    ['/el/index.html', 'route'],
    ['/src/app.ts', 'path'],
    ['/docs', 'route'],
  ];

  for (const [input, want] of cases) {
    let got;
    try {
      got = classifyReferent(input, index);
    } catch (err) {
      check(`classify \`${input}\``, false, `threw: ${err.message}`);
      continue;
    }
    check(`classify \`${input}\` -> ${want}`, got && got.kind === want,
      `got ${got ? got.kind : String(got)}`);
    check(`classify \`${input}\` has needle`, got && typeof got.needle === 'string');
    check(`classify \`${input}\` echoes raw`, got && got.raw === input);
  }

  // `kind: 'path'` alone does not prove the leading slash was stripped for the
  // lookup — an unresolved path is still a path, and it is exactly the shape
  // that lands in PATH-MISSING. Assert the resolution itself. Nothing in the
  // measured corpus takes this branch, so this test is its only coverage.
  const rooted = classifyReferent('/src/app.ts', index);
  check('classify `/src/app.ts` resolves to the root-relative file',
    rooted && rooted.resolved === 'src/app.ts',
    `got resolved=${rooted ? String(rooted.resolved) : 'none'}`);

  // The needle is what the repo is searched for, and for a call form it is the
  // one thing this branch decides. Asserting the KIND proves nothing here: every
  // case below is already a symbol, and the defect was that all three shapes were
  // searched for literally.
  const call = classifyReferent('stillCalled()', index);
  check('classify \`stillCalled()\` searches for the call, not the empty-paren form',
    call && call.needle === 'stillCalled(',
    `got needle=${call ? call.needle : 'none'}`);
  const plainSymbol = classifyReferent('buildFileIndex', index);
  check('classify \`buildFileIndex\` leaves a paren-free symbol alone',
    plainSymbol && plainSymbol.needle === 'buildFileIndex',
    `got needle=${plainSymbol ? plainSymbol.needle : 'none'}`);
  // A call carrying its own literal argument is already specific — widening it
  // would search for a prefix of a string the entry deliberately quoted whole.
  const withArgs = classifyReferent("t('errors.exportFailed')", index);
  check('classify a call WITH arguments is left literal',
    withArgs && withArgs.needle === "t('errors.exportFailed')",
    `got needle=${withArgs ? withArgs.needle : 'none'}`);

  // Classifying with no index must not throw — the documented degraded mode.
  for (const [input] of cases) {
    try {
      classifyReferent(input);
    } catch (err) {
      check(`classify \`${input}\` with no index`, false, `threw: ${err.message}`);
    }
  }
}

// ------------------------------------------- 2. the provenance split, both kinds

function testProvenance(root) {
  const config = loadConfig(root);
  const index = buildFileIndex(root, config.ignore);

  // The two facts that share the `PATH-NOT-SCANNED` bucket have to stay
  // distinguishable, on the glob branch as well as the path branch. The glob
  // branch is the one that shipped broken.
  const byDefault = classifyReferent('node_modules/**/*.js', index);
  check('glob under a default-ignored dir is ignored', byDefault.ignored === true);
  check('glob under a default-ignored dir names its segment', byDefault.ignoredBy === 'node_modules',
    `got ${JSON.stringify(byDefault.ignoredBy)}`);
  check('glob under a default-ignored dir is NOT config-suppressed',
    byDefault.ignoredByConfig === false);

  const byConfig = classifyReferent('internal/*.ts', index);
  check('glob under a config-ignored dir is ignored', byConfig.ignored === true);
  check('glob under a config-ignored dir names its segment', byConfig.ignoredBy === 'internal',
    `got ${JSON.stringify(byConfig.ignoredBy)}`);
  check('glob under a config-ignored dir IS config-suppressed',
    byConfig.ignoredByConfig === true);

  const pathByConfig = classifyReferent('internal/secret.ts', index);
  check('path under a config-ignored dir IS config-suppressed',
    pathByConfig.ignoredByConfig === true,
    `ignored=${pathByConfig.ignored} by=${JSON.stringify(pathByConfig.ignoredBy)}`);

  const plain = classifyReferent('src/app.ts', index);
  check('a resolving path is not marked ignored', !plain.ignored);
  check('a resolving path reports no suppressor', (plain.ignoredBy ?? null) === null);
}

// --------------------------------------------------- 3. every script runs

function testScripts(root) {
  for (const script of ['measure.mjs', 'dead.mjs', 'stale.mjs']) {
    for (const args of [[], ['--json']]) {
      const label = `${script} ${args.join(' ')}`.trim();
      let out;
      try {
        out = execFileSync('node', [join(SCRIPTS, script), '--root', root, ...args],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        check(`${label} exits 0`, false,
          `exit ${err.status}: ${String(err.stderr || err.message).split('\n')[0]}`);
        continue;
      }
      check(`${label} exits 0`, true);
      check(`${label} produced output`, out.trim().length > 0);
      if (args.includes('--json')) {
        try {
          const parsed = JSON.parse(out);
          check(`${label} emits an object`, parsed && typeof parsed === 'object');
        } catch (err) {
          check(`${label} emits valid JSON`, false, err.message);
        }
      }
    }
  }
}

// --------------------------------------- 4. the reports carry the provenance

function testReportsSurfaceSuppression(root) {
  const dead = execFileSync('node', [join(SCRIPTS, 'dead.mjs'), '--root', root],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  check('dead.mjs report names the config-suppressed referent',
    dead.includes('.todokeeper.json') && dead.includes('internal'),
    'the suppression listing is the whole point of ignoredByConfig');

  const stale = execFileSync('node', [join(SCRIPTS, 'stale.mjs'), '--root', root],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  check('stale.mjs report names the config-suppressed referent',
    stale.includes("EXCLUDED BY THIS REPO'S OWN CONFIG"),
    'expected the suppression section');

  // Finished work does not go stale, and must not be reported as live.
  check('stale.mjs skips the Completed section',
    !stale.includes('Something finished'));
}

// --------------------------------- 5. call-form referents reach their symbol

/**
 * The classifier check above proves the needle; this proves the verdict, which
 * is the part a reader acts on. Both directions matter and they pull opposite
 * ways: `stillCalled()` must reach the definition and the call (it read
 * DOC-ONLY before, because the only literal `stillCalled()` in the fixture is
 * the TODOS entry naming it), and `wasCalled()` must stay COMMENT-ONLY, because
 * a fix that reported every call form as alive would be worse than the defect.
 */
function testCallFormVerdicts(root) {
  const out = execFileSync('node', [join(SCRIPTS, 'dead.mjs'), '--root', root, '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const byRaw = new Map(JSON.parse(out).referents.map((r) => [r.raw, r]));

  const live = byRaw.get('stillCalled()');
  check('a call form whose symbol is still called reads CODE',
    live && live.verdict === 'CODE',
    `got ${live ? live.verdict : 'no such referent'}`);

  const gone = byRaw.get('wasCalled()');
  check('a call form with only a tombstone stays COMMENT-ONLY',
    gone && gone.verdict === 'COMMENT-ONLY',
    `got ${gone ? gone.verdict : 'no such referent'}`);
}

// -------------------------------------- 5b. CRLF line endings parse the same

/**
 * A CRLF worktree used to parse to ZERO headings, and the report it produced
 * was plausible rather than obviously broken.
 *
 * `text.split('\n')` leaves a trailing `\r` on every line; `.` excludes `\r`
 * and an unflagged `$` anchors at end-of-input, so the ATX heading pattern
 * matched nothing. One `(preamble)` section, 0.0% completed mass, and both
 * `stale.mjs` and `dead.mjs` sweeping the archive as live work because nothing
 * was ever classified completed. Measured on a real 308.9KB file: 1 section
 * against 14, 0.0% against 9.9%.
 *
 * This fixture writes `\r\n` into the string literals explicitly and commits
 * with `core.autocrlf=false`, so what is on disk is decided by this file and
 * not by the checkout the suite happens to run in. A line-ending test whose
 * fixture is normalised by git proves whatever git was configured to do.
 *
 * Asserted against the broken tree, not assumed: reverting `normaliseNewlines`
 * to `return text` fails 6 of these 7 checks. The seventh is the fixture's own
 * CRLF-on-disk sanity check, which must pass on both trees or it is not
 * checking the fixture.
 */
function testCrlfParsesIdentically() {
  const root = mkdtempSync(join(tmpdir(), 'todokeeper-crlf-'));
  try {
    const put = (p, body) => {
      mkdirSync(join(root, dirname(p)), { recursive: true });
      writeFileSync(join(root, p), body);
    };
    // Every line ends CRLF, including the blank ones.
    const crlf = (lines) => `${lines.join('\r\n')}\r\n`;

    put('src/app.ts', 'export const app = 1;\n');
    put('TODOS.md', crlf([
      '# TODOS',
      '',
      '## Open',
      '',
      '- **A live entry** — `src/app.ts` needs a second look.',
      '',
      '## Completed',
      '',
      '- **A finished entry** — `src/app.ts` landed.',
      '',
    ]));

    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    git('config', 'user.email', 'smoke@example.invalid');
    git('config', 'user.name', 'smoke');
    git('add', '-A');
    git('commit', '-q', '-m', 'crlf fixture');

    // The fixture is only a fixture if the bytes survived to disk.
    const onDisk = readFileSync(join(root, 'TODOS.md')).toString('latin1');
    const lf = (onDisk.match(/\n/g) || []).length;
    const crlfCount = (onDisk.match(/\r\n/g) || []).length;
    check('the CRLF fixture really holds CRLF on disk',
      crlfCount > 0 && crlfCount === lf,
      `${crlfCount} CRLF against ${lf} LF — git or the platform normalised the fixture, so this phase proves nothing`);

    const m = JSON.parse(execFileSync('node', [join(SCRIPTS, 'measure.mjs'), '--root', root, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const file = m.files[0];

    check('a CRLF file parses into its headings',
      file && file.sections.length === 3,
      `got ${file ? file.sections.length : 'no file'} section(s): ${file ? file.sections.map((x) => x.heading).join(' | ') : ''}`);
    check('a CRLF file reports non-zero completed mass',
      file && file.completedBytes > 0 && file.completedPercent > 0,
      `got ${file ? `${file.completedBytes} B / ${file.completedPercent}%` : 'no file'}`);
    check('a CRLF file counts the completed entry as completed, not live',
      file && file.completedEntries === 1 && file.liveEntries === 1,
      `got ${file ? `${file.completedEntries} completed, ${file.liveEntries} live` : 'no file'}`);
    // The ratio is taken over normalised text; the threshold verdict is not.
    check('the on-disk size is reported alongside the normalised one',
      file && file.diskBytes > file.bytes,
      `got diskBytes ${file ? file.diskBytes : '?'} vs bytes ${file ? file.bytes : '?'}`);

    // Both scripts count entries themselves rather than reusing measure.mjs's
    // pass, so both are asserted. The signal is the COUNT, not the absence of a
    // string: `stale.mjs` prints only entries it judges stale, and a fixture
    // committed seconds ago has none — so "the completed entry is not in the
    // report" passes just as well on the broken tree and proves nothing.
    const stale = execFileSync('node', [join(SCRIPTS, 'stale.mjs'), '--root', root],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    check('stale.mjs counts one live entry, not the archive too, on a CRLF file',
      /\b1 live entr\w+ across\b/.test(stale),
      `expected 1 live entry; got: ${(stale.split('\n')[1] || '').trim()}`);

    const dead = execFileSync('node', [join(SCRIPTS, 'dead.mjs'), '--root', root, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const leads = JSON.parse(dead).referents.flatMap((r) => r.from || []).map((f) => f.lead);
    check('dead.mjs draws provenance from the live entry only on a CRLF file',
      leads.length === 1 && leads[0] === 'A live entry',
      `provenance was ${JSON.stringify(leads)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --------------------------- 5c. a file that parsed to no headings says so

/**
 * The diagnostic that keeps the remaining causes from being silent.
 *
 * CRLF is fixed above, but setext headings and classic-Mac bare-CR endings
 * still produce zero headings, and the report they produce is the same
 * plausible one: 0.0% completed mass with nothing on stdout saying why. Both
 * directions are checked, because a warning that fires on a legitimate
 * configuration is how a warning gets ignored — a short flat deferred-work
 * file with no headings is an ordinary way to keep one.
 */
function testHeadinglessWarning() {
  const bullets = (n) => Array.from({ length: n }, (_, i) => `- **Entry ${i + 1}** — thing ${i + 1} needs work.`);
  const stderrOf = (body, newline) => {
    const root = mkdtempSync(join(tmpdir(), 'todokeeper-flat-'));
    try {
      writeFileSync(join(root, 'TODOS.md'), body.join(newline) + newline);
      const r = spawnSync('node', [join(SCRIPTS, 'measure.mjs'), '--root', root],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return r.stderr;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  check('a long headingless file announces that it parsed to no headings',
    stderrOf(bullets(25), '\n').includes('0 headings matched'),
    'the 0% it reports would have been silent');

  // The case CRLF normalisation structurally cannot reach. It must still be
  // named, and the line count has to be taken across bare CR to see it at all:
  // to every splitter downstream this file is one line.
  const bare = stderrOf(bullets(25), '\r');
  check('a bare-CR file is seen as many lines, not one, by the warning',
    /\b25 non-blank lines\b/.test(bare),
    `got: ${bare.slice(0, 200)}`);
  check('...and the message names bare-CR as the cause nothing normalises',
    bare.includes('bare-CR'));

  check('a short flat file is left alone',
    stderrOf(bullets(3), '\n').trim() === '',
    'warning on a legitimate configuration is how warnings get ignored');
}

// ------------------------------------- 6. no literal control byte in source

/**
 * In a tool whose entire subject is control characters, a stray one inside
 * `CONTROL_CHARS` itself would be invisible in every diff view and would
 * silently change the class it matches. That is not hypothetical: three
 * separate edits wrote raw 0x1B / 0x00 / 0x7F into `lib.mjs` because the
 * editing tool interpreted a typed escape sequence, and each was caught only by
 * reading the file back through `od`.
 *
 * Tab, newline and carriage return are layout and are allowed. Everything else
 * in C0, plus DEL and C1, is a defect in source. What belongs in a source
 * file is the two-character escape SEQUENCE a language defines (backslash-x1b
 * in a JS string literal, backslash-e in a shell); that is ordinary ASCII and
 * carries no control byte. This docblock shipped a literal ESC on its first
 * draft, and this phase is what found it.
 */
function testNoControlBytes() {
  const files = ['lib.mjs', 'dead.mjs', 'stale.mjs', 'measure.mjs']
    .map((f) => join(SCRIPTS, f))
    .concat([fileURLToPath(import.meta.url)]);

  for (const file of files) {
    const bytes = readFileSync(file);
    const bad = [];
    for (let i = 0; i < bytes.length; i += 1) {
      const b = bytes[i];
      const isLayout = b === 0x09 || b === 0x0A || b === 0x0D;
      // C1 arrives as UTF-8 (0xC2 0x80–0x9F), so the lead byte is what to spot.
      const isC1 = b === 0xC2 && bytes[i + 1] >= 0x80 && bytes[i + 1] <= 0x9F;
      if ((b < 0x20 && !isLayout) || b === 0x7F || isC1) {
        const line = bytes.subarray(0, i).toString('utf8').split('\n').length;
        bad.push(`0x${b.toString(16).padStart(2, '0')} at line ${line}`);
      }
    }
    check(`${file.split('/').pop()} carries no literal control byte`,
      bad.length === 0, bad.slice(0, 5).join(', '));
  }
}

// ---------------------------------------------- 6. the two counts that had no test

/**
 * `MAX_ENTRIES` and `MAX_FROM` in `dead.mjs`, exercised rather than trusted.
 *
 * The other caps are deliberately untested because reaching them costs 8.2s and
 * 39s, which is a benchmark rather than a smoke test. These two are different:
 * one distinct referent named by 5,001 entries hits both, and the whole run
 * takes ~70ms, because `dead.mjs`'s expensive dimension is DISTINCT referents
 * and this fixture has one.
 *
 * That cheapness is exactly why the gap survived two rounds. `dead.mjs` never
 * imported `MAX_ENTRIES` at all while `stale.mjs` did, and nothing here would
 * have noticed: 2,163,704 entries naming one missing file printed a single
 * 50,817,797-byte stdout line at 1.41GB RSS, from a target inside `TARGET_CAP`.
 *
 * What this does NOT cover: `MAX_REFERENTS` in either script, `MAX_ENTRIES` in
 * `stale.mjs`, and every byte cap. Deleting any of those still passes here.
 */
function testCounts() {
  const root = mkdtempSync(join(tmpdir(), 'todokeeper-caps-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'real.ts'), 'export const a = 1;\n');
    const lines = ['# TODOS', '', '## Open', ''];
    // A MISSING path on purpose: PATH-EXISTS is one of the quiet verdicts, and
    // the quiet branch prints no `named by` line at all, so a resolving referent
    // cannot exercise the provenance remainder.
    for (let i = 0; i <= DEAD_ENTRY_CAP; i += 1) lines.push(`- **E${i}.** \`src/gone.ts\``);
    writeFileSync(join(root, 'TODOS.md'), `${lines.join('\n')}\n`);

    const out = execFileSync('node', [join(SCRIPTS, 'dead.mjs'), '--root', root, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const j = JSON.parse(out);

    check('dead.mjs drops the entry past MAX_ENTRIES',
      j.droppedEntries === 1 && j.entryCap === DEAD_ENTRY_CAP,
      `droppedEntries=${j.droppedEntries} entryCap=${j.entryCap}`);

    const ref = j.referents.find((r) => r.raw === 'src/gone.ts');
    check('dead.mjs caps the provenance list', ref && ref.from.length === DEAD_FROM_CAP,
      `from.length=${ref ? ref.from.length : 'no referent'}`);
    // The count is the point: a truncated list that also lost the total would
    // report a referent named 5,000 times as one named 64 times.
    check('dead.mjs keeps the true provenance count', ref && ref.fromTotal === DEAD_ENTRY_CAP,
      `fromTotal=${ref ? ref.fromTotal : 'no referent'}`);
    check('dead.mjs counts the dropped provenance records',
      j.droppedFrom === DEAD_ENTRY_CAP - DEAD_FROM_CAP, `droppedFrom=${j.droppedFrom}`);

    const text = execFileSync('node', [join(SCRIPTS, 'dead.mjs'), '--root', root],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    check('dead.mjs report announces the entry cap', text.includes('ENTRY CAP HIT'));
    check('dead.mjs report shows the provenance remainder',
      text.includes(`+${DEAD_ENTRY_CAP - DEAD_FROM_CAP} more`),
      'a silently shortened list reads as the whole list');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * `--json` must survive a PIPE, which is not the same as surviving a file.
 *
 * Node's stdout is synchronous for a file or a TTY and asynchronous for a pipe,
 * so `console.log(big); process.exit(0)` delivered one 65,536-byte pipe buffer
 * of a 596,029-byte document and exited 0. Every earlier hand-check had used
 * `>` — where the same call is synchronous and complete — so nine review rounds
 * read a correct document and none of them piped it.
 *
 * That is why this phase pipes through `cat` rather than reading the child's
 * stdout directly: a parent that drains eagerly races the exit and got 146,176
 * bytes instead, which is still wrong but not reproducibly wrong. `| cat`
 * pins the failure at the buffer boundary.
 *
 * The fixture crosses that boundary rather than being assumed to: 400 entries
 * each naming a distinct absent symbol produce ~139KB in ~50ms, and the first
 * check asserts the size so a future record-shape change cannot shrink this
 * into a test that pipes 3KB and proves nothing.
 *
 * NOT covered: `stale.mjs` and `measure.mjs` carry the identical pattern and
 * are not exercised here — inflating `stale.mjs` past 64KB means ~400 entries
 * each costing two `git log` spawns, which is a benchmark. On a real 439-file
 * repo `stale.mjs` did cross it (83,136 bytes, truncated to the same 65,536)
 * and `measure.mjs` did not (3,336). Nor does this cover stderr, the text
 * report, or any `console.log` outside the two `--json` sinks.
 */
function testPipedJson() {
  const root = mkdtempSync(join(tmpdir(), 'todokeeper-pipe-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'real.ts'), 'export const a = 1;\n');
    const lines = ['# TODOS', '', '## Open', ''];
    for (let i = 0; i < 400; i += 1) {
      lines.push(`- **E${i}.** A deferred entry naming a symbol absent from this `
        + `fixture: \`absentSymbolNumber${i}\` (2026-08-17)`);
    }
    writeFileSync(join(root, 'TODOS.md'), `${lines.join('\n')}\n`);

    const dead = join(SCRIPTS, 'dead.mjs');
    const direct = execFileSync('node', [dead, '--root', root, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

    check('the pipe fixture is larger than one 64KiB pipe buffer',
      Buffer.byteLength(direct) > 65_536,
      `${Buffer.byteLength(direct)} bytes — below this, piping proves nothing`);

    const piped = execFileSync('sh',
      ['-c', `node ${JSON.stringify(dead)} --root ${JSON.stringify(root)} --json | cat`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

    check('dead.mjs --json survives a pipe intact',
      Buffer.byteLength(piped) === Buffer.byteLength(direct),
      `piped ${Buffer.byteLength(piped)} vs ${Buffer.byteLength(direct)} bytes`);

    // Byte-equality alone would pass if BOTH were truncated identically, and a
    // consumer's real failure is the parse, not the count.
    let parsed = null;
    try {
      parsed = JSON.parse(piped);
    } catch (err) {
      check('piped --json parses', false, err.message.slice(0, 80));
    }
    if (parsed) {
      check('piped --json carries every referent', parsed.referents.length === 400,
        `${parsed.referents.length} referents`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------- 8. .gitignore is honoured, and it shows

/**
 * The fixture for the enumeration phases. Two things live in it that no
 * `.todokeeper.json` mentions:
 *
 *  - `interview/`, gitignored and holding a canary string. It is named after
 *    the real directory that prompted this: a repo whose only control on client
 *    personal data was one `.gitignore` line, scanned in full by a tool that
 *    walked the filesystem and never asked git anything.
 *  - `web/test-results`, excluded by a PATH-shaped `ignore` entry. That shape
 *    used to match nothing at any depth, in silence.
 *
 * `init` decides whether it becomes a git work tree, because the two modes are
 * each other's control: the same tree, enumerated both ways, must disagree
 * about `interview/` and agree about everything else. An assertion that the
 * gitignored file is absent proves nothing on its own — an empty index
 * satisfies it — so every phase below pairs it with a file that must be there.
 */
function buildEnumerationFixture({ init }) {
  const root = mkdtempSync(join(tmpdir(), 'todokeeper-enum-'));
  const put = (p, body) => {
    mkdirSync(join(root, dirname(p)), { recursive: true });
    writeFileSync(join(root, p), body);
  };

  put('.gitignore', `${IGNORED_DIR}/\n*.log\n`);
  put('src/app.ts', "export const scannedCanary = 'CANARY-SCANNED-4417';\n");
  put('src/removed.ts', 'export const removed = 1;\n');
  put(`${IGNORED_DIR}/notes.md`, "const ignoredCanary = 'CANARY-IGNORED-9002';\n");
  put('web/test-results/report.html', '<p>ignoredByPath</p>\n');
  // The control for the path entry: same basename, different parent. A
  // path-shaped entry that quietly degraded to a basename match would take
  // this one too, and the exclusion would be wider than the config said.
  put('other/test-results/keep.html', '<p>keptByPath</p>\n');

  put('.todokeeper.json', `${JSON.stringify({
    ignore: [...DEFAULTS.ignore, 'web/test-results'],
  }, null, 2)}\n`);

  put('TODOS.md', [
    '# TODOS',
    '',
    '## Open',
    '',
    '- **A scanned symbol** — `scannedCanary` is live.',
    '- **A symbol only the ignored tree defines** — `ignoredCanary` should not be read.',
    '- **A path under a gitignored dir** — `interview/notes.md` holds client notes.',
    '- **A path under a path-ignored dir** — `web/test-results/report.html` is build output.',
    '- **A path the ignore list does not cover** — `other/test-results/keep.html` stays.',
    '- **A tracked file deleted from disk** — `src/removed.ts` went away.',
    '- **A symbol only a file OUTSIDE the repo defines** — `outsideCanary` is not ours.',
    '',
  ].join('\n'));

  // Two symlinks, planted before the commit so `git add -A` TRACKS them. Git
  // stores a symlink as a blob holding its target string and `ls-files` reports
  // it exactly like a regular file, so the enumeration is handed both:
  //   escape-link.md  -> a gitignored file. The LINK is not ignored, so it
  //                      survives every filter above; following it hands back
  //                      the very bytes this phase exists to keep out. This is
  //                      a bypass of the fix, not a gap beside it.
  //   outside-link.md -> a file outside the repo entirely, for the broader
  //                      "nothing outside the repository is read" contract.
  // Creation is guarded because an unprivileged Windows account cannot make
  // one; phase 8 reports a loud SKIP rather than passing quietly if so.
  try {
    writeFileSync(`${root}-outside.txt`, "const outsideCanary = 'CANARY-OUTSIDE-2260';\n");
    symlinkSync(join(IGNORED_DIR, 'notes.md'), join(root, 'escape-link.md'));
    symlinkSync(`${root}-outside.txt`, join(root, 'outside-link.md'));
  } catch {
    rmSync(`${root}-outside.txt`, { force: true });
  }

  if (init) {
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'smoke@example.invalid');
    git('config', 'user.name', 'smoke');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
  }
  // After the commit on purpose: the file is in the index and gone from disk,
  // which is the state `git ls-files --cached` reports and a stat has to catch.
  rmSync(join(root, 'src/removed.ts'));
  return root;
}

/**
 * Did the fixture actually manage to create the symlinks? Asked by lstat rather
 * than carried as a flag, so the answer is about the tree the code under test
 * will see. `existsSync` would FOLLOW the link and answer about the target.
 */
function symlinksPlanted(root) {
  try {
    return lstatSync(join(root, 'escape-link.md')).isSymbolicLink()
      && lstatSync(join(root, 'outside-link.md')).isSymbolicLink();
  } catch {
    return false;
  }
}

function testGitEnumeration() {
  const root = buildEnumerationFixture({ init: true });
  try {
    const config = loadConfig(root);
    const index = buildFileIndex(root, config.ignore);

    check('a git work tree enumerates through git', index.mode === 'git',
      `got ${JSON.stringify(index.mode)}`);

    // The pair. Neither half means anything alone.
    check('a gitignored file is not indexed',
      !index.byPath.has(`${IGNORED_DIR}/notes.md`));
    check('...while a tracked file next to it is',
      index.byPath.has('src/app.ts'),
      'positive control — without this the check above passes on an empty index');

    const ignored = classifyReferent(`${IGNORED_DIR}/notes.md`, index);
    check('a referent under a gitignored dir is NOT-SCANNED, not MISSING',
      ignored.ignored === true && ignored.resolved === null,
      `ignored=${ignored.ignored} resolved=${JSON.stringify(ignored.resolved)}`);
    check('...and names the gitignored directory', ignored.ignoredBy === IGNORED_DIR,
      `got ${JSON.stringify(ignored.ignoredBy)}`);
    check('...and names .gitignore as the source', ignored.ignoredBySource === 'gitignore',
      `got ${JSON.stringify(ignored.ignoredBySource)}`);
    check('...and lands in the loud bucket, not the defaults one',
      ignored.ignoredByConfig === true);

    // A path-shaped `ignore` entry, and the sibling that proves it is anchored.
    const byPath = classifyReferent('web/test-results/report.html', index);
    check('a path-shaped ignore entry excludes its subtree',
      byPath.ignored === true && byPath.ignoredBy === 'web/test-results',
      `ignored=${byPath.ignored} by=${JSON.stringify(byPath.ignoredBy)}`);
    check('...reported as config, not gitignore', byPath.ignoredBySource === 'config',
      `got ${JSON.stringify(byPath.ignoredBySource)}`);
    check('...and does not degrade to a basename match',
      index.byPath.has('other/test-results/keep.html'),
      'positive control — `web/test-results` must not take `other/test-results`');

    // A tracked file deleted from disk is in git's index and not on disk. It
    // must not read as present, or an entry naming it looks resolved forever.
    const deleted = classifyReferent('src/removed.ts', index);
    check('a tracked-but-deleted file is not indexed', !index.byPath.has('src/removed.ts'));
    check('...and classifies as missing rather than not-scanned',
      deleted.resolved === null && !deleted.ignored,
      `resolved=${JSON.stringify(deleted.resolved)} ignored=${deleted.ignored}`);

    // The whole point, end to end: the bytes inside the gitignored file must
    // not reach this tool's output. The paired canary is what makes it a test
    // rather than a tautology — one is read and printed, one is not.
    const json = execFileSync('node', [join(SCRIPTS, 'dead.mjs'), '--root', root, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    check('dead.mjs --json declares the enumeration',
      JSON.parse(json).enumeration === 'git');
    check('the scanned canary reaches the report', json.includes('CANARY-SCANNED-4417'),
      'positive control — without this the next check passes on any empty scan');
    check('the gitignored canary does not', !json.includes('CANARY-IGNORED-9002'),
      'a .gitignore line is the only control on personal data in some repos');

    // A symlink is the one shape that walks straight through everything above:
    // `ls-files` lists it, `ignoredBy` sees an unignored name, and a `statSync`
    // would resolve it to a perfectly ordinary file on the far side. Both links
    // were tracked by the fixture, so the enumeration was OFFERED both escapes.
    if (symlinksPlanted(root)) {
      check('a tracked symlink is not indexed', !index.byPath.has('escape-link.md'),
        'lstat, not stat — git lists a symlink exactly like a file');
      check('...nor the one pointing outside the repo',
        !index.byPath.has('outside-link.md'));
      check('a symlink into the gitignored tree does not leak its target',
        !json.includes('CANARY-IGNORED-9002'),
        'the link itself is NOT gitignored, so this bypasses the fix rather than testing it');
      check('a symlink out of the repo does not leak its target',
        !json.includes('CANARY-OUTSIDE-2260'),
        'README promises nothing outside the repository is read');
    } else {
      console.error('SKIP  symlink escapes — this platform would not create one.');
      console.error('      Phase 8 proves .gitignore handling here and NOTHING about symlinks.');
    }

    // `stale` never prints file CONTENT, but the mode still decides which
    // referents exist to be dated, so a reader of `stale` ALONE needs the same
    // sentence. It went unsaid there while a comment in lib.mjs claimed every
    // report printed it.
    const staleJson = execFileSync('node', [join(SCRIPTS, 'stale.mjs'), '--root', root, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    check('stale.mjs --json declares the enumeration too',
      JSON.parse(staleJson).enumeration === 'git',
      'both reports, or the claim in lib.mjs is false for one of them');

    const text = execFileSync('node', [join(SCRIPTS, 'dead.mjs'), '--root', root],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    check('the report says .gitignore put the referent out of scope',
      text.includes('(.gitignore)'),
      'a reader sent to .todokeeper.json would not find the line');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-outside.txt`, { force: true });
  }
}

// ------------------------------- 9. the fallback, and that it is announced

/**
 * The same tree with no `.git`. This is the control for phase 8 — it proves the
 * git arm changed the answer rather than agreeing with the walk by accident —
 * and it pins the downgrade's own contract: the walk reads what `.gitignore`
 * excludes, so the report has to say so out loud.
 */
function testWalkFallback() {
  const root = buildEnumerationFixture({ init: false });
  try {
    const config = loadConfig(root);
    const index = buildFileIndex(root, config.ignore);

    check('a non-git root falls back to the walk', index.mode === 'walk',
      `got ${JSON.stringify(index.mode)}`);
    check('the walk DOES read a gitignored file',
      index.byPath.has(`${IGNORED_DIR}/notes.md`),
      'the contrast with phase 8 is the evidence that git enumeration did the work');
    check('the walk still honours a path-shaped ignore entry',
      !index.byPath.has('web/test-results/report.html')
      && index.byPath.has('other/test-results/keep.html'),
      'one compiled matcher serves both modes');
    // The two modes must agree about symlinks or the fallback becomes the
    // escape. A Dirent is neither a file nor a directory for a link, which is
    // why this holds — assert it, so switching the walk to statSync reds here.
    if (symlinksPlanted(root)) {
      check('the walk does not follow a symlink either',
        !index.byPath.has('escape-link.md') && !index.byPath.has('outside-link.md'),
        'both modes must agree, or the downgrade path is the way in');
    }

    const text = execFileSync('node', [join(SCRIPTS, 'dead.mjs'), '--root', root],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    check('the fallback is announced, not silent',
      text.includes('not a git work tree') && text.includes('.gitignore was'),
      'a downgrade nobody is told about reads as coverage');

    const staleText = execFileSync('node', [join(SCRIPTS, 'stale.mjs'), '--root', root],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    check('stale.mjs announces the downgrade as well',
      staleText.includes('not a git work tree') && staleText.includes('.gitignore was'),
      'a clean stale report on a walk root would otherwise read as coverage');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-outside.txt`, { force: true });
  }
}

// ------------------------- 10. the per-entry done count, and what it refuses to see

/**
 * `entriesMarkedDone` answers "how many of my OPEN ENTRIES are actually
 * closed?"; `inlineDoneMarkers` answers "how much completion language does this
 * file contain?". They are different numbers, they never converge, and the bug
 * this phase pins is reporting only the second while a reader takes it for the
 * first — measured on one real repo as 32 against 0.
 *
 * Both NON-GOALS are asserted here rather than only written down, because a
 * limit nothing tests is a limit that quietly stops holding:
 *  - a struck or marked SUB-BULLET must not close its parent, and the check is
 *    proven non-vacuous by moving the same line to column 0, where it must;
 *  - a lead with no marker stays open even when its BODY says DONE, which is
 *    the shape no first-line scan can ever see.
 */
function testLeadMarkedDone() {
  const roots = [];
  const build = (todos, config) => {
    const root = mkdtempSync(join(tmpdir(), 'todokeeper-lead-'));
    roots.push(root);
    writeFileSync(join(root, 'TODOS.md'), `${todos.join('\n')}\n`);
    if (config) writeFileSync(join(root, '.todokeeper.json'), `${JSON.stringify(config, null, 2)}\n`);
    return root;
  };
  const measure = (root, flags = []) => execFileSync(
    'node', [join(SCRIPTS, 'measure.mjs'), '--root', root, ...flags],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  try {
    // ---- A. every shape at once, with the numbers pinned exactly.
    const mixed = build([
      '# TODOS',
      '',
      '## Open',
      '',
      '- **A lead marked done — SHIPPED** in the same run.',
      '  Continuation prose, carrying no marker.',
      '- **A live parent whose child is finished.**',
      '  - ~~a struck sub-bullet~~',
      '  More prose under the same parent.',
      '- **A live entry closed in its body.**',
      '  **DONE:** finished in fact, but the lead line does not say so.',
      '- **A live entry that merely quotes a marker.**',
      '  Prose mentioning DONE: as a word rather than as a verdict.',
      '',
      '## Completed',
      '',
      '- **An archived entry — SHIPPED** last week.',
      '',
    ]);
    const a = JSON.parse(measure(mixed, ['--json'])).files[0];

    check('four bullets under a live heading are four entries',
      a && a.liveEntries === 4, `got ${a && a.liveEntries}`);
    check('exactly the one entry marked on its LEAD line is counted',
      a && a.entriesMarkedDone === 1, `got ${a && a.entriesMarkedDone}`);
    check('a struck SUB-bullet does not close its parent',
      a && a.entriesMarkedDone === 1,
      'a completed child is not a completed entry; `isEntryStart` already refuses indent > 1');
    check('a lead with no marker stays open even when its BODY says DONE',
      a && a.entriesMarkedDone === 1,
      'the structural non-goal: no first-line scan can see a body-only closure');
    check('a marked lead under `## Completed` is not counted as live',
      a && a.liveEntries === 4 && a.completedEntries === 1,
      `live ${a && a.liveEntries}, completed ${a && a.completedEntries}`);
    // The occurrence count is the OTHER question and must be untouched by all
    // of the above: 1 `— SHIPPED`, 2 `~~`, 2 `DONE:` across the live sections.
    check('the occurrence count still counts every marker in the body',
      a && a.inlineDoneMarkers === 5, `got ${a && a.inlineDoneMarkers}`);
    check('the two numbers diverge, which is the whole point',
      a && a.inlineDoneMarkers > a.entriesMarkedDone,
      'if these ever agree on this fixture, one of them stopped measuring what it claims');

    // ---- A'. the negative control's negative control. The SAME struck text at
    // column 0 is an entry lead and MUST be counted, or the check above passes
    // for the wrong reason.
    const promoted = build([
      '# TODOS',
      '',
      '## Open',
      '',
      '- **A live parent whose child is finished.**',
      '- ~~a struck sub-bullet~~',
      '',
    ]);
    const p = JSON.parse(measure(promoted, ['--json'])).files[0];
    check('the same struck line at column 0 IS counted',
      p && p.liveEntries === 2 && p.entriesMarkedDone === 1,
      `live ${p && p.liveEntries}, marked ${p && p.entriesMarkedDone} — indent is the only difference`);

    // ---- B. the legitimate configuration this must NOT fire on: a real
    // `## Completed` heading and no in-place marking anywhere.
    const tidy = build([
      '# TODOS',
      '',
      '## Open',
      '',
      '- **A live entry.** Nothing here is marked.',
      '- **Another live entry.** Also unmarked.',
      '',
      '## Completed',
      '',
      '- **An archived entry.** Finished, and filed under the heading.',
      '',
    ]);
    const b = JSON.parse(measure(tidy, ['--json'])).files[0];
    check('a repo that archives under a heading reports 0 marked leads',
      b && b.liveEntries === 2 && b.entriesMarkedDone === 0,
      `live ${b && b.liveEntries}, marked ${b && b.entriesMarkedDone}`);
    check('...with the archive still found by heading, so 0 is not a parse failure',
      b && b.completedEntries === 1 && b.completedBytes > 0,
      `completed ${b && b.completedEntries} entries, ${b && b.completedBytes} B`);

    const text = measure(tidy);
    // A number printed only when non-zero cannot say zero: its ABSENCE reads as
    // "not measured", which is the reading this whole field exists to prevent.
    check('the report prints the 0 rather than omitting the line',
      text.includes('0 of 2 live entries marked done on their LEAD line'),
      text.split('\n').slice(0, 12).join('\n'));
    check('...and says in words that 0 is an answer, not a defect',
      text.includes('not a parse failure') && text.includes('not a defect'),
      'an unstated limit reads as a claim of coverage');

    // ---- C. the two vocabularies are allowed to differ, and setting one must
    // not move the other. Without this key the only way to teach the per-entry
    // count a new word is to widen `inlineDoneMarkers`, which degrades it.
    const split = build([
      '# TODOS',
      '',
      '## Open',
      '',
      '- **First lead. RESOLVED — last week.**',
      '- **Second lead — SHIPPED.**',
      '- **Third lead. RESOLVED — also.**',
      '',
    ], { leadDoneMarkers: ['RESOLVED —'] });
    const c = JSON.parse(measure(split, ['--json'])).files[0];
    check('`leadDoneMarkers` replaces the lead vocabulary',
      c && c.entriesMarkedDone === 2, `got ${c && c.entriesMarkedDone} of ${c && c.liveEntries}`);
    check('...and leaves the occurrence count on `inlineDoneMarkers`',
      c && c.inlineDoneMarkers === 1, `got ${c && c.inlineDoneMarkers}`);

    // ---- D. the new key is bounded like the list it stands in for.
    const badRoot = mkdtempSync(join(tmpdir(), 'todokeeper-lead-cfg-'));
    roots.push(badRoot);
    writeFileSync(join(badRoot, 'TODOS.md'), '# TODOS\n');
    const rejects = (label, value, wanted) => {
      writeFileSync(join(badRoot, '.todokeeper.json'),
        `${JSON.stringify({ leadDoneMarkers: value }, null, 2)}\n`);
      let message = null;
      try {
        loadConfig(badRoot);
      } catch (err) {
        message = err.message;
      }
      check(`leadDoneMarkers rejects ${label}`, message !== null, 'it was accepted');
      if (message) {
        check(`...naming the key for ${label}`,
          message.includes('leadDoneMarkers') && message.includes(wanted),
          `got ${JSON.stringify(message)}`);
      }
    };
    rejects('an empty marker', [''], 'empty');
    rejects('a bare string', 'RESOLVED', 'array of strings');

    // Positive control: `null` is the default and must stay legal, or the
    // validator above rejects the shipped configuration.
    writeFileSync(join(badRoot, '.todokeeper.json'),
      `${JSON.stringify({ leadDoneMarkers: null }, null, 2)}\n`);
    let nullOk = true;
    try {
      loadConfig(badRoot);
    } catch {
      nullOk = false;
    }
    check('leadDoneMarkers accepts null, which means "reuse inlineDoneMarkers"', nullOk,
      'null is the shipped default — rejecting it would reject DEFAULTS itself');
  } finally {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  }
}

// ------------------------------ 11. an ignore entry that cannot match is an error

/**
 * Each rejected shape used to be accepted and match nothing, at any depth, with
 * no output — which is the failure this whole change exists to remove. The
 * final case is the positive control: the shape that USED to be a silent no-op
 * and now works must not be caught by the validator built to reject the others.
 */
function testIgnoreValidation() {
  const root = mkdtempSync(join(tmpdir(), 'todokeeper-ignore-'));
  try {
    const write = (ignore) => writeFileSync(
      join(root, '.todokeeper.json'), `${JSON.stringify({ ignore }, null, 2)}\n`,
    );
    const rejects = (label, entry, wanted) => {
      write([entry]);
      let message = null;
      try {
        loadConfig(root);
      } catch (err) {
        message = err.message;
      }
      check(`ignore rejects ${label}`, message !== null, 'it was accepted');
      if (message) {
        check(`...naming the entry and the reason for ${label}`,
          message.includes(JSON.stringify(entry)) && message.includes(wanted),
          `got ${JSON.stringify(message)}`);
      }
    };

    rejects('a glob', '*.log', 'glob');
    rejects('a directory glob', 'web/**/tmp', 'glob');
    rejects('an absolute path', '/etc/passwd', 'absolute');
    rejects('a backslash path', 'web\\test-results', 'backslash');
    rejects('an escaping path', '../secrets', '..');
    rejects('an empty entry', '', 'empty');
    rejects('a padded entry', ' node_modules ', 'whitespace');

    write(['node_modules', 'web/test-results']);
    let ok = true;
    try {
      loadConfig(root);
    } catch {
      ok = false;
    }
    check('ignore accepts a name and a repo-relative path', ok,
      'positive control — the validator must not reject the shape this change added');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * `entries()` is a GENERATOR, and the line walk inside it replaced
 * `body.split('\n')`. Both are memory changes with no intended effect on what
 * gets reported, so the checks here are equivalence checks: same entries, same
 * text, same boundaries — plus the one behavioural fact callers depend on, that
 * the result is a single-use iterator with no `.length`.
 *
 * The line walk is the part worth pinning. `split('\n')` has two edge results
 * that are easy to lose by hand — the trailing empty string when the input ends
 * in a newline, and the single empty string for empty input — and losing either
 * silently changes where an entry's text ends.
 */
function testEntriesGenerator() {
  const styles = DEFAULTS.entryStyles;

  // ---- A. it is an iterator, not an array. `measure.mjs` used to bind the
  // array and read `.length` twice; if this ever regresses to returning one,
  // the memory win is gone and nothing else in the suite would notice.
  const it = entries('- **One**\n- **Two**\n', styles);
  check('`entries()` returns an iterator, not an array',
    typeof it[Symbol.iterator] === 'function' && typeof it.next === 'function'
      && !Array.isArray(it) && it.length === undefined,
    `Array.isArray=${Array.isArray(it)} length=${it.length}`);
  check('the iterator is single-use',
    [...it].length === 2 && [...it].length === 0,
    'a generator drains; a caller that iterates twice must see the second pass empty');

  // ---- B. the line walk is `split('\n')` exactly. Compared against the real
  // thing on the shapes that distinguish them, including the two empty-string
  // results, and on a body whose last entry runs to a trailing newline.
  const bodies = [
    '',
    '\n',
    '- **Only entry**',
    '- **Only entry**\n',
    '- **First**\n- **Second**\n',
    'preamble with no bullet\n- **After prose**\n\nstill the same entry\n',
    '- **Fenced**\n  ```\n  - **not an entry**\n  ```\n  after the fence\n',
    '- **Trailing blank lines**\n\n\n',
  ];
  for (const body of bodies) {
    const got = [...entries(body, styles)].map((e) => e.text);
    const want = referenceEntries(body, styles);
    check(`line walk matches split('\\n') for ${JSON.stringify(body).slice(0, 44)}`,
      JSON.stringify(got) === JSON.stringify(want),
      `got ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  }
}

/**
 * The pre-generator entry splitter, kept verbatim as the oracle for phase B.
 * It exists to be a SECOND implementation — if it is ever "simplified" to call
 * `entries()`, phase B compares the code under test against itself and passes
 * unconditionally.
 */
function referenceEntries(body, entryStyles) {
  const lines = body.split('\n');
  const out = [];
  let current = null;
  let fence = null;
  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (line.trimStart().startsWith(fence)) fence = null;
      if (current) current.push(line);
      continue;
    }
    if (fence === null && isEntryStartOracle(line, entryStyles)) {
      if (current) out.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) out.push(current);
  return out.map((e) => e.join('\n'));
}

/**
 * Entry-start detection for the oracle. NOT a second copy of the real rule —
 * it covers only the shapes phase B's fixtures use, which is why phase B's
 * bodies are hand-written rather than drawn from a repo.
 */
function isEntryStartOracle(line, entryStyles) {
  const m = /^(\s*)(?:([-*+])\s+|(\d+)[.)]\s+)?(.*)$/.exec(line);
  if (!m) return false;
  const indent = m[1].length;
  if (indent > 1) return false;
  if (m[2] && entryStyles.includes('bullet')) return true;
  if (m[3] && entryStyles.includes('numbered')) return true;
  if (entryStyles.includes('bold') && /^\*\*/.test(m[4])) return true;
  return false;
}

// -------------------------------------------------------------------- driver

let root;
try {
  root = buildFixture();
  // Each phase is isolated so one throw reports as one failed phase rather than
  // truncating the run. The bug that prompted this file threw from the
  // classifier, and a suite that stops at the first throw would have reported
  // only the first of the four places it breaks.
  for (const [name, phase] of [
    ['classifier', testClassifier],
    ['provenance', testProvenance],
    ['scripts', testScripts],
    ['reports', testReportsSurfaceSuppression],
    ['call-form', testCallFormVerdicts],
    ['crlf', testCrlfParsesIdentically],
    ['headingless', testHeadinglessWarning],
    ['control-bytes', testNoControlBytes],
    ['counts', testCounts],
    ['piped-json', testPipedJson],
    ['git-enumeration', testGitEnumeration],
    ['walk-fallback', testWalkFallback],
    ['lead-marked-done', testLeadMarkedDone],
    ['ignore-validation', testIgnoreValidation],
    ['entries-generator', testEntriesGenerator],
  ]) {
    try {
      phase(root);
    } catch (err) {
      check(`phase ${name} ran to completion`, false, err.stack || err.message);
    }
  }
} catch (err) {
  console.error(`ERROR  the fixture itself failed: ${err.stack || err.message}`);
  failures += 1;
} finally {
  if (root) rmSync(root, { recursive: true, force: true });
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
