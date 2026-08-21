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
 *  - Every verdict is now asserted BY NAME, not merely shape-checked: the four
 *    symbol tiers, the three path verdicts, and the two precedence rules that
 *    order them. The precedence rows assert the losing hit is present as well,
 *    because a label alone cannot tell "code outranks a comment" from "the
 *    comment was never found". Measured, not assumed: collapsing DOC-ONLY into
 *    ABSENT fails 1, inverting the comment/doc ladder fails 2, and reporting an
 *    excluded path as missing fails 4. What is still NOT asserted is any
 *    verdict on a corpus larger than a fixture that fits on one screen — the
 *    caps, the ordering of a long report, and anything that only emerges at
 *    scale are still caught only by the real-repo parity diff described above.
 *  - The control-byte scan reads every TRACKED file, binary extensions aside,
 *    and covers C0-minus-layout, DEL, C1 and the bidi overrides and isolates
 *    that `safeField` escapes on output. What it still does not cover: a file
 *    that is not tracked, a binary extension named in `BINARY_EXTS`, and every
 *    other format character in Unicode — the set is `FIELD_UNSAFE`'s, chosen to
 *    match the escaping helper rather than to be complete, so a zero-width or a
 *    tag character passes. And nothing runs this suite for you, so it protects
 *    the edits of whoever remembers to run it.
 *  - The escaping and flush conventions are checked by reading the scripts as
 *    TEXT, not by parsing them. A value assembled in one function and printed
 *    in another is invisible; only a bare identifier's own local `const` is
 *    followed, by name and by nearest definition, with no scope analysis. The
 *    flush half decides ordering from position in the file, so a `console.log`
 *    reached through a branch or a callback reads as correctly ordered. What
 *    the phase does prove is that nothing NEW passes silently: an expression
 *    nobody has classified fails, and the two allowlists fail on a stale entry
 *    as well as on a grown one.
 *  - The symlink escapes are covered only where the PLATFORM can create a
 *    symlink. An unprivileged Windows account cannot, and phase 8 then prints
 *    a SKIP and proves nothing about links — read the run's output, not this
 *    file, to know which happened. The skip is loud on purpose: the same four
 *    checks passing and never running look identical in a summary line.
 *  - It runs on one platform, in one shell, with whatever git is installed.
 *    `stale.mjs` shells out to `git log -S`; a git old enough to lack a flag it
 *    uses fails here as a test error, which is the right outcome but is not the
 *    same as supporting that git.
 *  - The enumeration phases cover a work-tree root, a non-git root, and a root
 *    BELOW a work tree's toplevel — the last asserted through the verdict it
 *    changes, not through the mode string, since a tool could report the mode
 *    honestly and then not act on it. They do NOT cover a git binary that is
 *    missing rather than failing, a listing past the 64MB buffer, a submodule
 *    gitlink, or any other git failure: those need a doctored PATH, roughly
 *    800,000 files, and a fault injector respectively, and take the same
 *    fallback branch as the two that are covered.
 *  - Nothing here sees personal data that was never gitignored and never named
 *    in `ignore`. No test can: there is no property of such a file that
 *    distinguishes it from source.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, lstatSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULTS, classifyReferent, buildFileIndex, loadConfig, entries,
  MAX_ENTRIES as DEAD_ENTRY_CAP, MAX_FROM as DEAD_FROM_CAP,
  notedList, MAX_NOTED, isEntryStart, isCompletedHeading,
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
/**
 * Extensions this scan will not read. A DENY list, not an allow list, and the
 * direction is the point: a tracked file with an unlisted extension IS scanned,
 * so a `.md` or a `.json` added tomorrow is covered the day it lands. Adding a
 * binary asset fails this phase loudly and the fix is one line here — which is
 * the failure this repo wants, because the alternative silently stops scanning
 * whatever nobody remembered to allow.
 */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.zip', '.gz', '.tgz', '.woff', '.woff2', '.ttf', '.otf',
]);

/**
 * Every TRACKED file, not a hand-kept list of five.
 *
 * The list this replaced named the four `scripts/*.mjs` and this file, so a
 * control byte in `skills/todokeeper/SKILL.md` — a file an agent LOADS AND
 * FOLLOWS — was exactly as invisible as one in source, and so was one in
 * `README.md`, `CLAUDE.md` or either TODOS file. `git ls-files` follows the repo
 * instead, so nobody has to remember to add the next file.
 *
 * Falls back to the old five with a loud SKIP when git does not run, because a
 * narrowed scan reporting like a full one is the failure this phase exists to
 * prevent.
 */
function trackedTextFiles() {
  const repoRoot = join(SCRIPTS, '..');
  const res = spawnSync('git', ['-C', repoRoot, 'ls-files', '-z'], { encoding: 'buffer' });
  if (res.error || res.status !== 0) return null;
  return res.stdout.toString('utf8').split('\0')
    .filter(Boolean)
    .filter((f) => !BINARY_EXTS.has(extensionOf(f)))
    .map((f) => join(repoRoot, f));
}

/**
 * The extension, or the empty string when there is none.
 *
 * Written out rather than inlined because `slice(lastIndexOf('.'))` returns the
 * filename's LAST CHARACTER when the name has no dot — `LICENSE` yields `E` —
 * and that is only harmless while no entry in `BINARY_EXTS` is one character
 * long. A deny list has to fail toward scanning; a comparison that silently
 * changes meaning on extensionless files is the wrong thing to leave load-bearing.
 */
function extensionOf(file) {
  const dot = file.lastIndexOf('.');
  return dot === -1 ? '' : file.slice(dot).toLowerCase();
}

function testNoControlBytes() {
  let files = trackedTextFiles();
  if (files === null) {
    console.error('SKIP  full-tree control-byte scan — `git ls-files` did not run here; '
      + 'falling back to the four scripts and this file.');
    files = ['lib.mjs', 'dead.mjs', 'stale.mjs', 'measure.mjs']
      .map((f) => join(SCRIPTS, f))
      .concat([fileURLToPath(import.meta.url)]);
  }
  check('the control-byte scan reads the tracked tree, not five files',
    files.length >= 10,
    `scanned ${files.length} file(s)`);

  for (const file of files) {
    const bytes = readFileSync(file);
    const bad = [];
    for (let i = 0; i < bytes.length; i += 1) {
      const b = bytes[i];
      const isLayout = b === 0x09 || b === 0x0A || b === 0x0D;
      // C1 arrives as UTF-8 (0xC2 followed by 0x80..0x9F), so the lead byte is
      // what to spot.
      const isC1 = b === 0xC2 && bytes[i + 1] >= 0x80 && bytes[i + 1] <= 0x9F;
      // Bidi overrides and isolates are FORMAT characters, not control ones, so
      // no `b < 0x20` test sees them — which is how four literal ones reached
      // `lib.mjs` while the regex that escapes them was being written, found by
      // a hand-run scan rather than by this suite. The set is exactly the one
      // `FIELD_UNSAFE` escapes on output: U+202A..U+202E is E2 80 AA..AE, and
      // U+2066..U+2069 is E2 81 A6..A9.
      const isBidi = b === 0xE2
        && ((bytes[i + 1] === 0x80 && bytes[i + 2] >= 0xAA && bytes[i + 2] <= 0xAE)
          || (bytes[i + 1] === 0x81 && bytes[i + 2] >= 0xA6 && bytes[i + 2] <= 0xA9));
      if ((b < 0x20 && !isLayout) || b === 0x7F || isC1 || isBidi) {
        const line = bytes.subarray(0, i).toString('utf8').split('\n').length;
        const cp = isBidi
          ? 0x2000 | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)
          : null;
        const what = cp === null
          ? `0x${b.toString(16).padStart(2, '0')}`
          : `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
        bad.push(`${what} at line ${line}`);
      }
    }
    check(`${relFromRoot(file)} carries no literal control or bidi character`,
      bad.length === 0, bad.slice(0, 5).join(', '));
  }
}

/** Repo-relative path for a check label, so 15 of them stay readable. */
function relFromRoot(file) {
  const root = join(SCRIPTS, '..');
  return file.startsWith(root) ? file.slice(root.length).replace(/^[/\\]/, '') : file;
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
  const base = mkdtempSync(join(tmpdir(), 'todokeeper-pipe-'));
  // A directory name that is SYNTAX to a shell, so the shell-out below is a
  // real assertion about argument passing rather than a claim about it. Inside
  // double quotes a shell still expands `$(...)` and backticks, and
  // `JSON.stringify` escapes neither — so the interpolated form this replaced
  // resolves `--root` to a DIFFERENT directory and the phase fails. Nothing
  // hostile can reach here (`mkdtempSync` and this repo's own script path are
  // the only inputs); the point is that the test would notice if it could.
  const root = join(base, 'a$(exit 7)`echo x`b');
  mkdirSync(root, { recursive: true });
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

    // Positional arguments, not interpolation. `JSON.stringify` escapes `\"` and
    // backslash and leaves `$` and backticks alone, so the old quoting was
    // incidental rather than principled: it happened to hold because both
    // values are internally generated — this repo's own script path and an
    // `mkdtempSync` name. `"$1"` and `"$2"` hold because the shell never parses
    // them as syntax at all.
    const piped = execFileSync('sh',
      ['-c', 'node "$1" --root "$2" --json | cat', 'sh', dead, root],
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

    checkWriteFailures(dead, root);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/**
 * The two ways a write can fail, which are not the same fact.
 *
 * `writeStdout` used to listen for neither the callback error nor the stream's
 * `'error'` event, so BOTH ways surfaced as Node's default unhandled-event
 * throw: a native stack trace on stderr, from a tool whose whole contract is a
 * report an operator can read. Measured before the fix, on Node 24.17.0:
 * `dead.mjs --json | head -c 10` printed 497 bytes of stack on 5 runs out of 5
 * and exited 0, and `--json > /dev/full` printed the same shape with `ENOSPC`
 * and exited 1.
 *
 * They are asserted separately because the correct answers differ. A closed
 * pipe is the CONSUMER's decision — `| head` is what it is for — so the right
 * output is nothing at all and status 0. Anything else is a real failure and
 * must not exit 0, which is what the original entry was filed about.
 *
 * NOT covered: only `dead.mjs` is exercised, for the same reason the pipe test
 * above only covers `dead.mjs` — it is the one script whose fixture reliably
 * exceeds one pipe buffer. `stale.mjs` and `measure.mjs` share the helper and
 * are not run here. Nor does this cover a failure of the stderr line itself.
 */
function checkWriteFailures(dead, root) {
  // `> /dev/full` is the cheapest real non-EPIPE write error there is, and it
  // is Linux-only. A missing one is announced rather than skipped in silence.
  let full = false;
  try {
    full = statSync('/dev/full').isCharacterDevice();
  } catch { full = false; }

  if (full) {
    const res = spawnSync('sh', ['-c', 'node "$1" --root "$2" --json > /dev/full', 'sh', dead, root],
      { encoding: 'utf8' });
    check('a non-EPIPE write failure does not exit 0',
      res.status === 3, `exit ${res.status}`);
    check('a non-EPIPE write failure prints one line, not a stack',
      /^todokeeper: could not write the report to stdout \(ENOSPC\)\./.test(res.stderr)
        && !res.stderr.includes("Unhandled 'error' event"),
      JSON.stringify(res.stderr.slice(0, 120)));
  } else {
    console.error('SKIP  non-EPIPE write-failure check — no /dev/full on this host.');
  }

  // `head -c` is POSIX.1-2024 but was a GNU extension for a long time; if this
  // host has not got it the pipeline fails for the wrong reason, so prove it
  // works before trusting what it reports.
  const probe = spawnSync('sh', ['-c', 'printf abcdef | head -c 2'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout === 'ab') {
    const res = spawnSync('sh',
      ['-c', '{ node "$1" --root "$2" --json; echo "NODE_EXIT=$?" >&2; } | head -c 10 > /dev/null',
        'sh', dead, root],
      { encoding: 'utf8' });
    check('a consumer closing the pipe leaves stderr empty and the status 0',
      res.stderr === 'NODE_EXIT=0\n',
      JSON.stringify(res.stderr.slice(0, 160)));
  } else {
    console.error('SKIP  EPIPE check — `head -c` is unavailable here, so an early pipe close '
      + 'cannot be provoked.');
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

// ------------------ 12. the three drops that used to happen in silence

/**
 * Three things the index discards, each of which makes the report understate
 * the repo it audited: a symlink (dropped by `lstat`, so a link out of the
 * tree cannot be read), an `ignore` entry that matched nothing (usually a
 * typo, and a typo'd exclusion excludes nothing), and a manifest this tool
 * REFUSED — too big, not a regular file, or resolving outside the repo.
 *
 * Built in both enumeration modes on purpose. The symlink drop is written
 * TWICE, once in the `ls-files` branch and once in `walkDisk`, and a fix
 * applied to one of the two is the exact shape of bug this repo keeps
 * shipping. The manifest and ignore assertions are mode-independent and are
 * re-run in both anyway, cheaply, rather than reasoned about.
 */
function buildSkipsFixture({ init }) {
  const root = mkdtempSync(join(tmpdir(), 'todokeeper-skips-'));
  const put = (p, body) => {
    mkdirSync(join(root, dirname(p)), { recursive: true });
    writeFileSync(join(root, p), body);
  };

  put('src/app.ts', "export const skipsCanary = 'CANARY-SKIPS-8815';\n");
  put('web/test-results/report.html', '<p>build output</p>\n');
  // A directory where a manifest is expected. Platform-independent, unlike the
  // symlink below, so the manifest announcement is proven even where an
  // unprivileged account cannot create a link.
  put('composer.json/placeholder', 'not a manifest\n');

  // One entry that matches, one that is a typo of it, and the seven shipped
  // defaults copied in — which is how a user actually adds an entry, since a
  // user `ignore` array REPLACES the defaults rather than extending them.
  put('.todokeeper.json', `${JSON.stringify({
    ignore: [...DEFAULTS.ignore, 'web/test-results', 'web/test-resluts'],
  }, null, 2)}\n`);

  put('TODOS.md', [
    '# TODOS',
    '',
    '## Open',
    '',
    '- **A live symbol** — `skipsCanary` is defined in src.',
    '- **Build output** — `web/test-results/report.html` is excluded.',
    '',
  ].join('\n'));

  try {
    writeFileSync(`${root}-outside.json`, `${JSON.stringify({ dependencies: { outsidepkg: '1.0.0' } })}\n`);
    symlinkSync(join('src', 'app.ts'), join(root, 'link.md'));
    // `package.json` is git-trackable as a symlink, so this ships in a clone.
    symlinkSync(`${root}-outside.json`, join(root, 'package.json'));
  } catch {
    rmSync(`${root}-outside.json`, { force: true });
  }

  if (init) {
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'smoke@example.invalid');
    git('config', 'user.name', 'smoke');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
  }
  return root;
}

function skipsLinksPlanted(root) {
  try {
    return lstatSync(join(root, 'link.md')).isSymbolicLink()
      && lstatSync(join(root, 'package.json')).isSymbolicLink();
  } catch {
    return false;
  }
}

function testSilentSkipsAnnounced() {
  for (const init of [true, false]) {
    const mode = init ? 'git' : 'walk';
    const root = buildSkipsFixture({ init });
    try {
      const config = loadConfig(root);
      const index = buildFileIndex(root, config.ignore);
      check(`[${mode}] the fixture enumerates the way this phase intends`,
        index.mode === (init ? 'git' : 'walk'), `got ${JSON.stringify(index.mode)}`);

      // The typo, and only the typo. The other two assertions are what stop
      // this becoming noise: a matching entry must stay silent, and so must
      // every name this tool ships — most repos have no `vendor` or `.next`,
      // and the first draft of this check fired on all of them.
      check(`[${mode}] an ignore entry that matched nothing is reported`,
        index.unusedIgnores.includes('web/test-resluts'),
        `got ${JSON.stringify(index.unusedIgnores)}`);
      check(`[${mode}] ...while the entry that DID match is not`,
        !index.unusedIgnores.includes('web/test-results'),
        'positive control — without this the check above passes on a list of everything');
      check(`[${mode}] ...and no default of this tool's own is`,
        !index.unusedIgnores.some((e) => DEFAULTS.ignore.includes(e)),
        `crying wolf on the default config: ${JSON.stringify(index.unusedIgnores)}`);

      // A refused manifest read as a repo with no dependencies, in silence.
      const composer = index.depsSkipped.find((s) => s.file === 'composer.json');
      check(`[${mode}] a manifest that is not a regular file is announced`,
        Boolean(composer), `got ${JSON.stringify(index.depsSkipped)}`);
      check(`[${mode}] ...and the note says why`,
        /not a regular file/.test(composer?.reason ?? ''),
        `got ${JSON.stringify(composer?.reason)}`);

      const stderr = spawnSync('node', [join(SCRIPTS, 'dead.mjs'), '--root', root],
        { encoding: 'utf8' }).stderr;
      const text = execFileSync('node', [join(SCRIPTS, 'dead.mjs'), '--root', root],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const json = JSON.parse(execFileSync('node',
        [join(SCRIPTS, 'dead.mjs'), '--root', root, '--json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));

      check(`[${mode}] stderr names the unmatched ignore entry`,
        stderr.includes('web/test-resluts'), `stderr was ${JSON.stringify(stderr)}`);
      check(`[${mode}] stderr names the refused manifest`,
        stderr.includes('composer.json'), `stderr was ${JSON.stringify(stderr)}`);
      check(`[${mode}] the text report carries the ignore note too`,
        text.includes('IGNORE ENTRY MATCHED NOTHING'),
        'a reader of the report alone must not have to have watched stderr');
      check(`[${mode}] ...and the manifest note`, text.includes('MANIFEST NOT READ'));
      check(`[${mode}] --json carries both`,
        json.unusedIgnores.includes('web/test-resluts')
          && json.skippedManifests.some((s) => s.file === 'composer.json'),
        `got ${JSON.stringify({ u: json.unusedIgnores, m: json.skippedManifests })}`);

      if (skipsLinksPlanted(root)) {
        check(`[${mode}] a dropped symlink is announced`,
          index.droppedSymlinks.includes('link.md'),
          `got ${JSON.stringify(index.droppedSymlinks)}`);
        check(`[${mode}] ...in the text report`, text.includes('SYMLINK NOT SCANNED'));
        check(`[${mode}] ...and in --json`, json.droppedSymlinks.includes('link.md'),
          `got ${JSON.stringify(json.droppedSymlinks)}`);
        const pkg = index.depsSkipped.find((s) => s.file === 'package.json');
        check(`[${mode}] a manifest resolving outside the repo is announced`,
          /does not resolve/.test(pkg?.reason ?? ''), `got ${JSON.stringify(pkg)}`);
        check(`[${mode}] ...and its contents never reach the report`,
          !text.includes('outsidepkg'),
          'the read is refused, so the package name must not appear anywhere');
      } else {
        console.error(`SKIP  [${mode}] symlink drops — this platform would not create one.`);
        console.error('      The ignore and manifest halves of phase 12 still ran.');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(`${root}-outside.json`, { force: true });
    }
  }

  // A list item must not be able to forge the list's own punctuation. Asserted
  // on `notedList` directly rather than through a fixture, because the input
  // that matters is a filename this suite would then have to create.
  check('a list item cannot forge a truncation notice',
    notedList(['a, +9 more']) === '"a, +9 more"',
    `got ${notedList(['a, +9 more'])}`);
  check('...nor close its own quoting',
    notedList(['say "hi"']) === '"say \\"hi\\""',
    `got ${notedList(['say "hi"'])}`);
  check('...nor with a backtick, which is why backticks were not the fix',
    notedList(['a`, +9 more']) === '"a`, +9 more"',
    `got ${notedList(['a`, +9 more'])}`);
  const capped = notedList(Array.from({ length: MAX_NOTED + 2 }, (_, i) => `f${i}`));
  check('...while a GENUINE truncation is still announced',
    capped.endsWith(', +2 more'), `got ${capped}`);
  check('...showing exactly MAX_NOTED items',
    (capped.match(/"/g) || []).length === MAX_NOTED * 2, `got ${capped}`);

  // The control for all of the above: a repo that configures nothing must say
  // nothing. This is the check that would have caught the first draft, which
  // reported this tool's own seven defaults on every clean repo in the suite.
  const bare = mkdtempSync(join(tmpdir(), 'todokeeper-bare-'));
  try {
    mkdirSync(join(bare, 'src'));
    writeFileSync(join(bare, 'src/app.ts'), 'export const bareCanary = 1;\n');
    writeFileSync(join(bare, 'TODOS.md'),
      '# TODOS\n\n## Open\n\n- **A live symbol** — `bareCanary` is defined.\n');
    const index = buildFileIndex(bare, loadConfig(bare).ignore);
    check('a repo with no .todokeeper.json reports no unmatched ignore entry',
      index.unusedIgnores.length === 0, `got ${JSON.stringify(index.unusedIgnores)}`);
    const run = spawnSync('node', [join(SCRIPTS, 'dead.mjs'), '--root', bare],
      { encoding: 'utf8' });
    check('...and its run says nothing on stderr at all',
      run.stderr === '', `got ${JSON.stringify(run.stderr)}`);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
}

// ------------------- 13. a relative `--root` answers the same as an absolute

/**
 * `--root` used to be taken verbatim, and `resolveTargets` builds its answers
 * with `join(root, target)` while `listFiles` always returns absolute paths.
 * So a relative `--root` put the two path families out of alignment and
 * `dead.mjs`'s one-line filter — "the deferred-work file names everything; it
 * proves nothing" — stopped matching. Every referent then scored a free doc
 * hit from its own entry, and ABSENT, the verdict `dead.mjs` exists to
 * produce, became unreachable.
 *
 * Asserted as PARITY between the two invocations rather than as a list of
 * expected verdicts, because the defect was never in one verdict: it was the
 * corpus differing underneath all of them. A parity check fails on whichever
 * verdict a future misalignment happens to move. The one named assertion
 * beside it is ABSENT, because that is the verdict that went missing and a
 * parity check alone is satisfied by two runs that are equally wrong.
 */
function testRelativeRootParity() {
  const root = mkdtempSync(join(tmpdir(), 'todokeeper-root-'));
  try {
    const put = (p, body) => {
      mkdirSync(join(root, dirname(p)), { recursive: true });
      writeFileSync(join(root, p), body);
    };
    put('src/app.ts', 'export function liveThing() { return 1; }\n// deadThing was removed\n');
    put('docs/notes.md', 'The `prosedThing` is described here only.\n');
    put('TODOS.md', [
      '# TODOS',
      '',
      '## Open',
      '',
      '- **A live symbol** — `liveThing` is called.',
      '- **A tombstoned symbol** — `deadThing` is gone.',
      '- **A prose-only symbol** — `prosedThing` appears in docs.',
      '- **A symbol nowhere at all** — `neverThing` does not exist.',
      '- **A path that exists** — `src/app.ts` is here.',
      '- **A path that does not** — `src/gone.ts` is not.',
      '',
    ].join('\n'));

    // A real repo, because the alternative this rejects — `repoRoot(value)` —
    // only differs from `resolve(value)` INSIDE a work tree: outside one,
    // `repoRoot` falls back to `resolve(from)` and the two are the same
    // function. On a bare temp directory the subdirectory assertion below
    // would pass against the very design it exists to rule out.
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'smoke@example.invalid');
    git('config', 'user.name', 'smoke');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');

    const run = (args, cwd) => JSON.parse(execFileSync(
      'node', [join(SCRIPTS, 'dead.mjs'), '--json', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ));
    const verdicts = (r) => r.referents.map((x) => `${x.needle}=${x.verdict}`).sort().join(' ');

    const abs = run(['--root', root], undefined);
    const dot = run(['--root', '.'], root);

    check('a relative --root gives the same verdicts as an absolute one',
      verdicts(abs) === verdicts(dot),
      `absolute: ${verdicts(abs)}\n      relative: ${verdicts(dot)}`);

    // The verdict that actually went missing. Without this, two equally-wrong
    // runs satisfy the parity check above.
    check('...and a symbol that occurs nowhere reads ABSENT, not DOC-ONLY',
      dot.referents.find((x) => x.needle === 'neverThing')?.verdict === 'ABSENT',
      `got ${JSON.stringify(dot.referents.find((x) => x.needle === 'neverThing')?.verdict)}`);

    // The mechanism, asserted directly: the deferred-work file must not be in
    // the scanned corpus, or every referent it names scores a free doc hit.
    const hitPaths = (r) => r.referents.flatMap((x) => (x.hits || []).map((h) => h.path));
    check('...because the deferred-work file is not scanned for referents',
      !hitPaths(dot).includes('TODOS.md') && !hitPaths(abs).includes('TODOS.md'),
      `got ${JSON.stringify(hitPaths(dot))}`);

    // A relative root must not resolve UP to the enclosing work tree. `--root
    // web` on a monorepo means `web`, and `repoRoot(value)` would have audited
    // the whole repo while reporting the subdirectory's name — the failure
    // being that it reports a PASS-shaped answer for the wrong corpus.
    mkdirSync(join(root, 'sub'));
    const sub = spawnSync('node', [join(SCRIPTS, 'measure.mjs'), '--root', 'sub'],
      { cwd: root, encoding: 'utf8' });
    check('a relative --root names that directory, not the enclosing repo',
      sub.status === 2 && /no deferred-work file found/.test(sub.stderr + sub.stdout),
      `status=${sub.status} stderr=${JSON.stringify(sub.stderr)}`);

    // `resolve(undefined)` throws a TypeError, so the missing-value case had to
    // be handled when the resolution was added rather than left to crash.
    const bare = spawnSync('node', [join(SCRIPTS, 'dead.mjs'), '--root'],
      { cwd: root, encoding: 'utf8' });
    check('--root with no value exits 2 with one line, not a stack',
      bare.status === 2 && bare.stderr.trim().split('\n').length === 1,
      `status=${bare.status} stderr=${JSON.stringify(bare.stderr)}`);

    // All three scripts share the one entry point, because a fix applied to
    // two of three call sites reads exactly like a fix.
    for (const script of ['dead.mjs', 'stale.mjs', 'measure.mjs']) {
      const r = spawnSync('node', [join(SCRIPTS, script), '--root', '.', '--json'],
        { cwd: root, encoding: 'utf8' });
      check(`${script} accepts a relative --root and reports an absolute root`,
        r.status === 0 && JSON.parse(r.stdout).root === realpathSync(root),
        `status=${r.status} root=${JSON.stringify(r.stdout.slice(0, 120))}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------- 14. the two parsing rules, as a table rather than by hand

/**
 * `isEntryStart` and `isCompletedHeading` decide what a deferred-work file
 * MEANS: which lines are entries and which section holds finished work. They
 * replaced a pair of regexes and were checked by 26 hand-run cases in a
 * throwaway script, which is to say they have had no net since. These are
 * those cases, derived from the rules rather than from current output, so a
 * disagreement is a finding and not a diff to accept.
 *
 * Two shapes are asserted here deliberately even though they are WRONG in the
 * abstract, because both are documented standing limits with the reasoning
 * written down: `Done criteria` reads as completed (anchoring cannot see that
 * the heading goes on to mean something else — the retired regex behaved
 * identically), and a ten-digit ordinal is not an entry (the marker is capped
 * at nine to bound the match). Changing either is a decision, and it should
 * have to change a line here that says so.
 */
function testParsingRules() {
  const BULLET = ['bullet'];
  const NUMBERED = ['numbered'];
  const BOLD = ['bold-lead'];
  const ALL = ['bullet', 'numbered', 'bold-lead'];

  const entryCases = [
    // the three bullet markers, and the separator that makes them one
    [BULLET, '- an entry', true, 'hyphen bullet'],
    [BULLET, '* an entry', true, 'asterisk bullet'],
    [BULLET, '+ an entry', true, 'plus bullet'],
    [BULLET, '-\tan entry', true, 'a tab separates as well as a space'],
    [BULLET, '-an entry', false, 'no separator is not a bullet'],
    [BULLET, '--- an entry', false, 'a horizontal rule is not a bullet'],
    // indent: one level in is still an entry, two is a nested list
    [BULLET, ' - an entry', true, 'one space of indent'],
    [BULLET, '  - a sub-item', false, 'two spaces is a nested item, not an entry'],
    [BULLET, '\t- an entry', true, 'one tab counts as one column here'],
    // blockquote prefixes are stripped before anything else is decided
    [BULLET, '> - an entry', true, 'quoted'],
    [BULLET, '>- an entry', true, 'quoted with no space after the marker'],
    [BULLET, '> > - an entry', true, 'nested quote'],
    [BULLET, '>>- an entry', true, 'nested quote, no spaces'],
    // a style that is not enabled must not fire
    [BULLET, '1. an entry', false, 'numbered is off'],
    [BULLET, '**an entry**', false, 'bold-lead is off'],
    [BULLET, 'plain prose', false, 'prose'],
    [BULLET, '', false, 'the empty line'],
    // numbered, including the nine-digit cap
    [NUMBERED, '1. an entry', true, 'dot form'],
    [NUMBERED, '1) an entry', true, 'paren form'],
    [NUMBERED, '1.an entry', false, 'no separator'],
    [NUMBERED, '123456789. an entry', true, 'nine digits is the cap and is inside it'],
    [NUMBERED, '1234567890. an entry', false, 'ten digits is past the cap — deliberate'],
    [NUMBERED, '- an entry', false, 'bullet is off'],
    // bold-lead
    [BOLD, '**an entry**', true, 'bold lead'],
    [BOLD, '***an entry**', true, 'a third star still opens with two'],
    [BOLD, '*an entry*', false, 'one star is emphasis, not a lead'],
    [BOLD, '- **an entry**', false, 'a bullet is not a bold lead — bullet is off'],
    // several styles at once, and a name outside the closed set
    [ALL, '- an entry', true, 'all three enabled'],
    [ALL, '1. an entry', true, 'all three enabled'],
    [ALL, '**an entry**', true, 'all three enabled'],
    [['nope'], '- an entry', false, 'an unknown style name matches nothing'],
    [[], '- an entry', false, 'no styles enabled matches nothing'],
  ];

  for (const [styles, line, want, why] of entryCases) {
    let got;
    try {
      got = isEntryStart(line, styles);
    } catch (err) {
      check(`isEntryStart(${JSON.stringify(line)}, ${JSON.stringify(styles)}) — ${why}`,
        false, `threw: ${err.message}`);
      continue;
    }
    check(`isEntryStart(${JSON.stringify(line)}, ${JSON.stringify(styles)}) is ${want} — ${why}`,
      got === want, `got ${got}`);
  }

  const W = DEFAULTS.completedHeadings;
  const headingCases = [
    ['Completed', true, 'the plain case'],
    ['completed', true, 'case-insensitive'],
    ['   Completed   ', true, 'trimmed'],
    ['Done', true, 'a shorter word in the list'],
    ['Shipped', true, 'another'],
    ['Merged', true, 'another'],
    ['Landed', true, 'another'],
    ['Closed', true, 'another'],
    ['Archive', true, 'another'],
    ['Archives', true, 'the plural is listed separately, not stemmed'],
    // Anchoring is the whole rule, and these are the cases that PROVE it.
    // `Not completed` does not: the boundary check reads `text[w.length]`,
    // which for a word found later in the string lands inside that word and
    // rejects by accident, so unanchoring the match leaves it false either
    // way. The two below are the shapes where the index lands on a space —
    // unanchor the match and both flip to completed. Both are headings a real
    // repo would write, which is the point.
    ['Not completed', false, 'the word is present but does not start the heading'],
    ['Work completed this week', false, 'same'],
    ['Work done', false, 'ANCHORING: unanchor the match and this reads as finished'],
    ['Features complete', false, 'ANCHORING: same, and it hides a whole live section'],
    // the word boundary stops a longer word
    ['Doneness', false, 'a longer word is not the word'],
    ['Archiver notes', false, 'same'],
    ['Done2', false, 'a digit continues the word'],
    ['Done_list', false, 'an underscore continues the word'],
    ['Done: v2', true, 'punctuation does not continue the word'],
    ['Done — v2', true, 'nor does a dash'],
    // one qualifier may precede the word
    ['Recently completed', true, 'qualifier'],
    ['Previously shipped', true, 'qualifier'],
    ['Already done', true, 'qualifier'],
    ['Recentlycompleted', false, 'a qualifier needs whitespace after it'],
    ['Recently', false, 'a qualifier alone is not a completed heading'],
    // Only ONE qualifier is stripped, and the case has to use two DIFFERENT
    // ones in list order to prove it: the loop never revisits an earlier
    // qualifier, so a repeated word is rejected whether the `break` is there
    // or not.
    ['Recently recently done', false, 'a repeated qualifier — does not prove the break'],
    ['Recently already done', false, 'only ONE qualifier is stripped'],
    ['Previously already shipped', false, 'same, further down the list'],
    // the documented standing limit, asserted so changing it is a decision
    ['Done criteria', true, 'STANDING LIMIT: reads as completed, and understates live work'],
    // shapes that are not headings at all
    ['Open', false, 'a live section'],
    ['', false, 'the empty heading'],
    [null, false, 'a non-string'],
    [42, false, 'a non-string'],
  ];

  for (const [heading, want, why] of headingCases) {
    let got;
    try {
      got = isCompletedHeading(heading, W);
    } catch (err) {
      check(`isCompletedHeading(${JSON.stringify(heading)}) — ${why}`, false, `threw: ${err.message}`);
      continue;
    }
    check(`isCompletedHeading(${JSON.stringify(heading)}) is ${want} — ${why}`,
      got === want, `got ${got}`);
  }

  // A repo-supplied word list is untrusted, and an empty string in it matches
  // at index 0 of every heading — which is every heading. The guard is the
  // `!w` in the loop, and `Open` does NOT prove it is there: with the guard
  // removed the boundary check reads `text[0]`, finds a letter, and rejects
  // for the wrong reason. A heading whose first character is not a letter is
  // what separates the two, and a tick in a heading is not a contrived input.
  check('an empty word in the list does not make every heading completed',
    isCompletedHeading('\u2705 Open', ['']) === false,
    'an empty needle matches everywhere; the guard is the `!w`, not the boundary check');
  check('...and the same heading is not completed under the real word list',
    isCompletedHeading('\u2705 Open', W) === false);
  check('...and a real word beside it still matches',
    isCompletedHeading('Done', ['', 'done']) === true);
  // The list is ordered and a prefix must not shadow a longer sibling.
  check('a shorter word before a longer one does not shadow it',
    isCompletedHeading('Completed', ['complete', 'completed']) === true,
    'the boundary check continues the loop rather than returning false');
}

// -------------- 15. every verdict by name, and the ladder that orders them

/**
 * Until this phase, `test/smoke.mjs` asserted that verdicts were WELL-FORMED
 * and named exactly two of them: the call-form pair pinned CODE and
 * COMMENT-ONLY. Everything below CODE and every path verdict was caught only
 * by diffing `--json` against real repos by hand, which is a step that happens
 * when someone remembers.
 *
 * The fixture is separate from the shared one on purpose. The verdicts here
 * are the assertion, so the corpus that produces them has to be readable in
 * one screen — and the shared fixture is also counted by the `counts` phase,
 * which would make every added entry here a change there.
 *
 * The ladder is asserted through the HIT COUNTS as well as the label, because
 * the label alone cannot tell "code wins over comment" from "there was only
 * ever a code hit". `tierBoth` carries both and must read CODE; `tierCommentDoc`
 * carries both of its own and must read COMMENT-ONLY.
 */
function buildVerdictFixture() {
  const root = mkdtempSync(join(tmpdir(), 'todokeeper-verdict-'));
  const put = (p, body) => {
    mkdirSync(join(root, dirname(p)), { recursive: true });
    writeFileSync(join(root, p), body);
  };

  put('src/live.ts', [
    'export function tierCode(n) { return n + 1; }',
    'export const useIt = tierCode(1);',
    'export function tierBoth(n) { return n; }',
    'export const alsoUseIt = tierBoth(2);',
    '',
  ].join('\n'));
  put('src/tomb.ts', [
    '// tierComment went away with the old pipeline.',
    '// tierBoth used to live here too, before it moved.',
    '// tierCommentDoc was removed in the same pass.',
    'export const nothing = 1;',
    '',
  ].join('\n'));
  put('docs/notes.md', [
    '# notes',
    'The `tierDoc` helper is described here and nowhere else.',
    '`tierCommentDoc` is also written up here.',
    '',
  ].join('\n'));
  put('excluded/thing.ts', 'export const hidden = 1;\n');

  // `ignore` REPLACES the defaults, so they are restated; `excluded` is this
  // fixture's addition and is what makes one referent PATH-NOT-SCANNED.
  put('.todokeeper.json', `${JSON.stringify({
    ignore: [...DEFAULTS.ignore, 'excluded'],
  }, null, 2)}\n`);

  put('TODOS.md', [
    '# TODOS',
    '',
    '## Open',
    '',
    '- **code** — `tierCode` is called in source.',
    '- **comment** — `tierComment` survives only as a tombstone.',
    '- **doc** — `tierDoc` appears only in prose.',
    '- **absent** — `tierAbsent` is nowhere at all.',
    '- **code beats comment** — `tierBoth` is in both.',
    '- **comment beats doc** — `tierCommentDoc` is in both.',
    '- **path exists** — `src/live.ts` is here.',
    '- **path missing** — `src/nope.ts` is not.',
    '- **path excluded** — `excluded/thing.ts` is ignored by config.',
    '- **a directory** — `docs` exists.',
    '',
  ].join('\n'));
  return root;
}

function testEveryVerdict() {
  const root = buildVerdictFixture();
  try {
    const out = execFileSync('node', [join(SCRIPTS, 'dead.mjs'), '--root', root, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const by = new Map(JSON.parse(out).referents.map((r) => [r.raw, r]));

    const want = [
      ['tierCode', 'CODE', 'called in source'],
      ['tierComment', 'COMMENT-ONLY', 'a tombstone comment and nothing else'],
      ['tierDoc', 'DOC-ONLY', 'prose only'],
      ['tierAbsent', 'ABSENT', 'nowhere in the repo'],
      ['tierBoth', 'CODE', 'code outranks a comment'],
      ['tierCommentDoc', 'COMMENT-ONLY', 'a comment outranks prose'],
      ['src/live.ts', 'PATH-EXISTS', 'a file that is there'],
      ['src/nope.ts', 'PATH-MISSING', 'a file that is not'],
      ['excluded/thing.ts', 'PATH-NOT-SCANNED', 'excluded by config, not absent'],
      ['docs', 'PATH-EXISTS', 'a directory counts as present'],
    ];
    for (const [raw, verdict, why] of want) {
      const r = by.get(raw);
      check(`\`${raw}\` reads ${verdict} — ${why}`,
        r && r.verdict === verdict, `got ${r ? r.verdict : 'no such referent'}`);
    }

    // The ladder, through the counts. Without these the two precedence rows
    // above are satisfied by a tool that never found the losing hit at all.
    const both = by.get('tierBoth');
    check('code beats comment with BOTH hits present, not because the comment was missed',
      both && both.codeHits > 0 && both.commentHits > 0,
      `code=${both && both.codeHits} comment=${both && both.commentHits}`);
    const cd = by.get('tierCommentDoc');
    check('a comment beats prose with BOTH hits present',
      cd && cd.codeHits === 0 && cd.commentHits > 0 && cd.docHits > 0,
      `code=${cd && cd.codeHits} comment=${cd && cd.commentHits} doc=${cd && cd.docHits}`);

    // ABSENT has to mean what it says, or it is DOC-ONLY wearing another name —
    // which is exactly the shape the relative-root defect produced.
    const absent = by.get('tierAbsent');
    check('ABSENT carries no hit of any kind',
      absent && absent.codeHits === 0 && absent.commentHits === 0
      && absent.docHits === 0 && absent.hits.length === 0,
      `got ${absent ? JSON.stringify(absent.hits) : 'no such referent'}`);

    // Excluded-by-config and absent-from-the-repo are different facts and the
    // report has to carry which one it is — an operator acts on the difference.
    const skipped = by.get('excluded/thing.ts');
    check('PATH-NOT-SCANNED names the entry that excluded it and where it came from',
      skipped && skipped.ignoredBy === 'excluded' && skipped.ignoredBySource === 'config',
      `got ignoredBy=${skipped && skipped.ignoredBy} source=${skipped && skipped.ignoredBySource}`);
    check('...and it did NOT resolve, which is why it is not PATH-EXISTS',
      skipped && skipped.resolved === null,
      `got resolved=${skipped && JSON.stringify(skipped.resolved)}`);

    // A missing path must not borrow the excluded one's provenance.
    const missing = by.get('src/nope.ts');
    check('PATH-MISSING is not marked ignored',
      missing && !missing.ignored && !missing.ignoredBy,
      `got ignored=${missing && missing.ignored} by=${missing && missing.ignoredBy}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------- 16. a root BELOW the work tree's toplevel takes the walk as well

/**
 * `gitEnumerate` returns null — and the plain walk runs — on five conditions.
 * Phase 9 covers one: a root with no `.git` anywhere above it. This covers the
 * second, and it is the one worth having, because it is reachable by an
 * ordinary `--root web` on a monorepo and because its absence is the least
 * visible: the walk still produces a report that reads as complete.
 *
 * The other three are still uncovered and deliberately so — a missing git
 * binary needs a doctored PATH, a listing past `GIT_LIST_BUFFER` needs roughly
 * 800,000 files, and "any other git failure" needs a fault injector.
 *
 * The assertion that matters is not the mode string, it is the VERDICT: the
 * same referent in the same tree reads PATH-NOT-SCANNED from the toplevel and
 * PATH-EXISTS from the subdirectory, because `.gitignore` is consulted in one
 * and not the other. A test that only checked `mode` would pass against a tool
 * that reported the mode honestly and then ignored it.
 */
function buildMonorepoFixture() {
  const root = mkdtempSync(join(tmpdir(), 'todokeeper-mono-'));
  const put = (p, body) => {
    mkdirSync(join(root, dirname(p)), { recursive: true });
    writeFileSync(join(root, p), body);
  };

  put('web/src/app.ts', 'export function liveThing() { return 1; }\n');
  // `generated` is NOT one of the shipped `ignore` names, deliberately: a
  // default-ignored directory would be excluded in BOTH modes and the contrast
  // would prove nothing about enumeration.
  put('web/.gitignore', 'generated/\n');
  put('web/generated/stale.md', 'liveThing was written up here.\n');

  const todos = [
    '# TODOS',
    '',
    '## Open',
    '',
    '- **A gitignored doc** — `generated/stale.md` is generated.',
    '',
  ].join('\n');
  put('web/TODOS.md', todos);
  // The same referent, root-relative to each root, so the two runs are asking
  // the identical question of the identical file.
  put('TODOS.md', todos.replace('generated/stale.md', 'web/generated/stale.md'));

  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'smoke@example.invalid');
  git('config', 'user.name', 'smoke');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return root;
}

function testBelowToplevelFallback() {
  const root = buildMonorepoFixture();
  const web = join(root, 'web');
  try {
    const config = loadConfig(web);
    const below = buildFileIndex(web, config.ignore);
    check('a root below the work tree toplevel falls back to the walk',
      below.mode === 'walk', `got ${JSON.stringify(below.mode)}`);

    // The control. Without it this phase passes on a fixture whose git init
    // silently failed, which would take the SAME branch for the wrong reason.
    const top = buildFileIndex(root, loadConfig(root).ignore);
    check('...while the toplevel of the same tree enumerates with git',
      top.mode === 'git', `got ${JSON.stringify(top.mode)}`);

    const verdictFrom = (r) => {
      const out = execFileSync('node', [join(SCRIPTS, 'dead.mjs'), '--root', r, '--json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return JSON.parse(out).referents[0];
    };
    const fromTop = verdictFrom(root);
    const fromWeb = verdictFrom(web);
    check('from the toplevel the gitignored file reads PATH-NOT-SCANNED',
      fromTop && fromTop.verdict === 'PATH-NOT-SCANNED',
      `got ${fromTop ? fromTop.verdict : 'no referent'}`);
    check('from the subdirectory the SAME file reads PATH-EXISTS',
      fromWeb && fromWeb.verdict === 'PATH-EXISTS',
      `got ${fromWeb ? fromWeb.verdict : 'no referent'}`);
    check('...so the enumeration mode changes the answer, not just the banner',
      fromTop && fromWeb && fromTop.verdict !== fromWeb.verdict,
      'if these ever agree, one of the two modes stopped doing its job');

    // A downgrade nobody is told about reads as coverage. This asserts that the
    // report says a walk happened and that .gitignore went unconsulted — both
    // true here. It does NOT assert the sentence's stated REASON, which is
    // "this root is not a git work tree" and is false on this branch; that is
    // filed in TODOS.md rather than pinned here, because a test that fixes a
    // wrong sentence in place has to be deleted to fix it.
    const text = execFileSync('node', [join(SCRIPTS, 'dead.mjs'), '--root', web],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    check('the downgrade is announced from a subdirectory root too',
      text.includes('directory walk') && text.includes('.gitignore was'),
      'the walk was chosen for a different reason here, and it must still say so');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --------------------------- 17. the two conventions that nothing enforced

/**
 * `safeField` at every print sink, and `writeStdout` before every exit.
 *
 * TODOS.md carried these as two entries of one shape - "no lint rule, no
 * test, no wrapper type" - and both fail SILENTLY in review. A
 * `${safe(heading)}` in a one-line report reads correctly in a diff and forges
 * a report line at runtime, because `safe()` lets CR and LF through by design.
 * A `process.exit()` added after a `console.log` truncates a piped report at
 * one 65,536-byte pipe buffer and exits 0. Neither is visible without reading
 * the whole call site, and both are the kind of line a hurried change adds.
 *
 * So this reads the scripts as TEXT and decides four things:
 *
 *  1. No interpolation inside a print sink may carry a repo-derived value
 *     outside an escaping call. This one cannot be waived: `KNOWN_UNESCAPED`
 *     below is matched afterwards and never suppresses it.
 *  2. Every remaining interpolation must be escaper-covered, provably
 *     non-text by shape, resolvable to a local `const` that is, or listed by
 *     hand in `REVIEWED_NON_TEXT`. A new one fails until somebody classifies
 *     it, which IS the enforcement - there is no shape that silently passes.
 *  3. No print sink may use `safe()` where `safeField()` is meant. The tool
 *     prints no multi-line body today; when `## Triage` gives it one, this is
 *     the check that has to be relaxed deliberately rather than eroded.
 *  4. `writeStdout` is awaited, is the only route for a `--json` payload, and
 *     is followed by the exit rather than by more output.
 *
 * The file list comes from `readdirSync`, so a fifth script is covered the day
 * it lands rather than the day someone remembers this list.
 *
 * WHAT IT CANNOT SEE, written here because an unstated limit reads as coverage:
 *  - It is a text scan, not a parser. A value assembled by a FUNCTION - built
 *    in one place, printed in another - is invisible; only a one-level local
 *    `const` is followed. That resolution is by name and by nearest preceding
 *    definition, with no scope analysis, so two `const key` in one file
 *    resolve to whichever is nearer. That is why an unresolvable identifier
 *    lands in the reviewed list rather than passing.
 *  - The flush half is stdout-only, matching `writeStdout`. `console.error`
 *    is scanned for escaping and not for flushing, so the stderr path keeps
 *    the same shape of exposure at smaller payloads.
 *  - The repo-derived list is a closed list of NAMES (`raw`, `lead`,
 *    `subject`, ...). A repo-derived value reaching a sink under a name that
 *    is not on it is caught only by check 2, as an unreviewed expression -
 *    which is the backstop, and is why check 2 has no shape-based escape hatch.
 *  - It proves nothing about the escaping helpers themselves. That
 *    `safeField` escapes what it claims to is asserted elsewhere; this phase
 *    only proves it is CALLED.
 */

/**
 * A copy of the source with comments, string contents and regex bodies blanked
 * to spaces, template LITERAL segments blanked, and `${...}` contents kept.
 *
 * Byte-for-byte the same length, so an offset into the mask is an offset into
 * the source. Blanking rather than deleting is the whole trick: it lets a
 * paren count run over code without a paren inside `'//'` - which `dead.mjs`
 * really does contain - closing a call that never opened.
 */
function maskSource(src) {
  const out = src.split('');
  const blank = (a, b) => { for (let k = a; k < b; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  // A string frame is pushed for a template; `${` pushes a NUMBER, whose value
  // is the brace depth inside the interpolation. That is what tells an object
  // literal's brace from the one that closes the interpolation.
  const stack = [];
  const prevCode = (p) => {
    let k = p - 1;
    while (k >= 0 && /\s/.test(src[k])) k -= 1;
    return k >= 0 ? src[k] : '\n';
  };
  const literalRun = (from) => {
    let j = from;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`' || (src[j] === '$' && src[j + 1] === '{')) break;
      j += 1;
    }
    return j;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
      blank(i, end); i = end; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      blank(i, end); i = end; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j += 1; j += 1; }
      blank(i + 1, j); i = j + 1; continue;
    }
    if (c === '`') {
      stack.push('template');
      const j = literalRun(i + 1);
      blank(i + 1, j); i = j;
      if (src[i] === '`') { stack.pop(); i += 1; }
      continue;
    }
    if (c === '$' && src[i + 1] === '{' && stack[stack.length - 1] === 'template') {
      stack.push(0); i += 2; continue;
    }
    if (typeof stack[stack.length - 1] === 'number') {
      if (c === '{') { stack[stack.length - 1] += 1; i += 1; continue; }
      if (c === '}') {
        if (stack[stack.length - 1] > 0) { stack[stack.length - 1] -= 1; i += 1; continue; }
        stack.pop(); i += 1;
        const j = literalRun(i);
        blank(i, j); i = j;
        if (src[i] === '`') { stack.pop(); i += 1; }
        continue;
      }
    }
    // A `/` after an operator or a delimiter opens a regex; after an
    // identifier or a `)` it is division. `kb()` divides, `CONTROL_CHARS` does
    // not, and blanking the wrong one loses a whole call from the scan.
    if (c === '/' && '=(,:[!&|?{};+*%<>~^\n'.includes(prevCode(i))) {
      let j = i + 1; let inClass = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '\n') break;
        else if (src[j] === '/' && !inClass) break;
        j += 1;
      }
      if (src[j] === '/') { blank(i + 1, j); i = j + 1; continue; }
    }
    i += 1;
  }
  return out.join('');
}

const PRINT_SINK = /(?:console\.(?:log|error)|writeStdout|process\.(?:stdout|stderr)\.write)\s*\(/g;

/** `[start, end)` of every print-sink call, paren-balanced over the mask. */
function printSinks(masked) {
  const spans = [];
  PRINT_SINK.lastIndex = 0;
  let hit;
  while ((hit = PRINT_SINK.exec(masked))) {
    let i = hit.index + hit[0].length; let depth = 1;
    while (i < masked.length && depth > 0) {
      if (masked[i] === '(') depth += 1;
      else if (masked[i] === ')') depth -= 1;
      i += 1;
    }
    spans.push([hit.index, i]);
  }
  return spans;
}

/** `[start, end)` of each `${...}` body between two offsets. */
function interpolations(masked, from, to) {
  const out = [];
  for (let i = from; i < to - 1; i += 1) {
    if (masked[i] !== '$' || masked[i + 1] !== '{') continue;
    let j = i + 2; let depth = 0;
    while (j < to) {
      if (masked[j] === '{') depth += 1;
      else if (masked[j] === '}') { if (depth === 0) break; depth -= 1; }
      j += 1;
    }
    out.push([i + 2, j]);
    i = j;
  }
  return out;
}

const ESCAPERS = ['safeField', 'jsonSafe', 'notedList'];

/**
 * Which characters of an expression sit inside an escaping call.
 *
 * `.map(safeField)` covers the member chain to its LEFT, because
 * `config.targets.map(safeField).join(', ')` escapes every element while the
 * name it reads from is bare.
 */
function escaperCoverage(expr) {
  const covered = new Array(expr.length).fill(false);
  const mark = (a, b) => { for (let k = a; k < b; k += 1) covered[k] = true; };
  const call = new RegExp(`\\b(?:${ESCAPERS.join('|')})\\s*\\(`, 'g');
  let hit;
  while ((hit = call.exec(expr))) {
    let i = hit.index + hit[0].length; let depth = 1;
    while (i < expr.length && depth > 0) {
      if (expr[i] === '(') depth += 1;
      else if (expr[i] === ')') depth -= 1;
      i += 1;
    }
    mark(hit.index, i);
    call.lastIndex = hit.index + hit[0].length;
  }
  const mapped = new RegExp(`\\.map\\(\\s*(?:${ESCAPERS.join('|')})\\s*\\)`, 'g');
  while ((hit = mapped.exec(expr))) {
    let k = hit.index - 1;
    while (k >= 0 && /[\w$.\]['"]/.test(expr[k])) k -= 1;
    mark(k + 1, hit.index + hit[0].length);
  }
  return covered;
}

/**
 * The names that carry text out of the audited repo.
 *
 * Closed on purpose, and short on purpose: it exists to give a SPECIFIC
 * failure message for the case that matters, not to be the coverage. Check 2
 * is what makes a value under some other name fail.
 */
const REPO_DERIVED = new Set([
  'raw', 'lead', 'file', 'path', 'text', 'heading', 'subject', 'ignoredBy',
  'root', '_source', 'name', 'label', 'reason', 'target', 'msg', 'message', 'word',
]);

function repoDerivedNames(expr) {
  const covered = escaperCoverage(expr);
  const found = new Set();
  const ident = /[A-Za-z_$][\w$]*/g;
  let hit;
  while ((hit = ident.exec(expr))) {
    if (REPO_DERIVED.has(hit[0]) && !covered[hit.index]) found.add(hit[0]);
  }
  return [...found];
}

/** Shapes that carry no text at all. Every one is a whole-expression match. */
const NON_TEXT_SHAPES = [
  [/^\d[\d_e.]*$/, 'a number literal'],
  [/^[A-Z][A-Z0-9_]*$/, 'a module constant'],
  [/\.(?:length|size)$/, 'a count'],
  [/\.toLocaleString\(\)$/, 'a formatted number'],
  [/\.toFixed\(\d*\)$/, 'a formatted number'],
  [/\?\s*'[^']*'\s*:\s*'[^']*'$/, 'a ternary of two string literals'],
  [/^'[^']*'\.repeat\(/, 'a literal repeated'],
  [/^[\w$.]+\s*[-+*/]\s*[\w$.]+$/, 'arithmetic'],
  [new RegExp(`^(?:${ESCAPERS.join('|')})\\(`), 'an escaping call'],
  [new RegExp(`\\.map\\(\\s*(?:${ESCAPERS.join('|')})\\s*\\)(?:\\.join\\([^)]*\\))?$`), 'each element escaped'],
];

function nonTextShape(expr) {
  const hit = NON_TEXT_SHAPES.find(([re]) => re.test(expr));
  return hit ? hit[1] : null;
}

/**
 * The right-hand side of the nearest `const`/`let` of that name above `before`.
 *
 * By name and by position, with no scope analysis - see the non-goals above.
 * Returns null when there is no definition, which sends the identifier to the
 * reviewed list rather than passing it.
 */
function resolveLocalConst(masked, id, before) {
  const def = new RegExp(`\\b(?:const|let)\\s+${id}\\s*=`, 'g');
  let hit; let at = -1;
  while ((hit = def.exec(masked)) && hit.index < before) at = hit.index + hit[0].length;
  if (at === -1) return null;
  let i = at; let depth = 0;
  while (i < masked.length) {
    const c = masked[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ';' && depth === 0) break;
    i += 1;
  }
  return masked.slice(at, i).replace(/\s+/g, ' ').trim();
}

/** True when a `const` right-hand side carries no text of its own. */
function resolvesNonText(rhs) {
  const inner = [];
  for (let i = 0; i < rhs.length - 1; i += 1) {
    if (rhs[i] !== '$' || rhs[i + 1] !== '{') continue;
    let j = i + 2; let depth = 0;
    while (j < rhs.length) {
      if (rhs[j] === '{') depth += 1;
      else if (rhs[j] === '}') { if (depth === 0) break; depth -= 1; }
      j += 1;
    }
    inner.push(rhs.slice(i + 2, j).trim());
    i = j;
  }
  const parts = inner.length ? inner : [rhs];
  return parts.every((p) => nonTextShape(p) !== null);
}

/**
 * Every interpolation that is neither escaped nor mechanically non-text,
 * classified by hand. An expression not on this list fails the phase.
 *
 * The list is the point, not the friction: it is the whole set of values these
 * scripts print without escaping them, readable on one screen.
 */
const REVIEWED_NON_TEXT = new Map([
  ['h.line', 'a line number'],
  ['f.lines', 'a line count'],
  ['f.liveEntries', 'a count'],
  ['f.completedEntries', 'a count'],
  ['f.completedPercent', 'a percentage'],
  ['f.entriesMarkedDone', 'a count'],
  ['f.inlineDoneMarkers', 'a count'],
  ['verdict.completedPercent', 'a percentage'],
  ['r.gapDays', 'a day count'],
  ['totalLive', 'a reduce over per-file counts'],
  ['totalMarked', 'a reduce over per-file counts'],
  ['kb(f.diskBytes)', 'kb() formats a byte count'],
  ['kb(f.completedBytes)', 'kb() formats a byte count'],
  ['kb(totalDiskBytes)', 'kb() formats a byte count'],
  ['kb(config.splitThresholdBytes)', 'kb() of a value loadConfig validated as a number'],
  ['pad(kb(s.bytes), 8)', 'pad() of a formatted byte count'],
  ['pad(`${s.entries} `, 5)', 'pad() of an entry count; the mask blanked the literal'],
  ['day(r.entryCommit?.date)', 'day() formats a git author date, not a subject'],
  ['day(r.newestReferent.commit.date)', 'day() formats a git author date, not a subject'],
  ['r.newestReferent.commit.hash.slice(0, 8)', 'a hash git itself produced'],
  ["r.entryCommit?.hash.slice(0, 8) ?? ' '", 'that hash or a dash literal the mask blanked'],
  ['key', 'a verdict name from the closed list this tool writes itself'],
  ['explain[key]', "this tool's own sentence for that verdict"],
  ["parts.join(' ')", 'two counts and two caps, assembled just above the sink'],
]);

/**
 * Reached stdout unescaped, reviewed, and filed rather than fixed here.
 *
 * `root` is normally the operator's own argv and `config._source` is a fixed
 * filename made relative, so neither is reachable from the audited repo's
 * CONTENT - which is how they survived every round of "send everything
 * human-readable through the escaping helpers". What is left is a clone
 * directory NAMED from a URL rather than typed: git derives the directory from
 * the URL path, so a percent-escaped CR there lands in the name and then in
 * the report's first line.
 *
 * Listed rather than fixed because that edit is a `scripts/` change and this
 * is a test; it is filed in TODOS.md. What the list buys today is that the set
 * cannot GROW without this phase failing, and cannot shrink without somebody
 * deleting the entry.
 */
const KNOWN_UNESCAPED = [
  ['dead.mjs', 'root'],
  ['stale.mjs', 'root'],
  ['measure.mjs', 'root'],
  ['measure.mjs', 'config._source'],
];

/**
 * The mask itself, against the shapes that break a naive scanner.
 *
 * Every one of these is in the scripts today: `dead.mjs` really does push the
 * string `'//'`, `lib.mjs` really does hold a regex with a bracket class, and
 * `measure.mjs` really does nest a template inside an interpolation. Driving
 * the mask through the corpus alone cannot fail on any of them, because the
 * corpus is currently clean - measured: a mask that stops blanking block
 * comments still passes every corpus check, and merely scans two more "sinks"
 * out of a docblock that happens to quote `console.log`.
 */
function checkMaskSource() {
  const sinks = (src) => printSinks(maskSource(src));
  const exprs = (src) => {
    const masked = maskSource(src);
    return sinks(src).flatMap(([a, b]) => interpolations(masked, a, b)
      .map(([x, y]) => masked.slice(x, y).trim()));
  };

  check('the mask blanks a line comment',
    !maskSource('const a = 1; // ${lead}\n').includes('${'));
  check('the mask blanks a block comment',
    sinks('/* console.log(`${lead}`) */\nconst a = 1;\n').length === 0);
  check('a string holding // does not open a comment',
    sinks("openers.push('//');\nconsole.log(`${safeField(a)}`);\n").length === 1);
  // Both of these assert where the call ENDS, not what it contains: a stray
  // `)` that closes the span early leaves the interpolation before it intact,
  // so an expression-level assertion passes while the scan has lost the rest
  // of the statement. Measured - both of these read clean until the span was
  // the thing being checked.
  const parenInString = "console.log(`${safeField(a)}`, ')');\n";
  check('a paren inside a string does not close the call',
    sinks(parenInString)[0][1] === parenInString.indexOf(';'));
  const regexInSink = "console.log(`${safeField(a.replace(/[)]/g, ''))}`);\n";
  check('a regex body is blanked rather than scanned',
    sinks(regexInSink)[0][1] === regexInSink.indexOf(';'));
  check('division is not read as a regex',
    exprs('const n = a / b;\nconst m = c / d;\nconsole.log(`${n}`);\n').join() === 'n');
  // The outer expression is returned whole, which is why a tainted name nested
  // inside a formatter is still seen by the repo-derived check below.
  check('a nested template comes back as one expression',
    exprs('console.log(`${pad(`${x}`, 5)}`);\n').join() === 'pad(`${x}`, 5)');
  check('a repo-derived name nested inside a formatter is still found',
    repoDerivedNames(exprs('console.log(`${pad(`${lead}`, 5)}`);\n').join()).join() === 'lead');
}

function testEscapingConventions() {
  checkMaskSource();

  const names = readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs')).sort();
  check('the convention scan reads every script, not a remembered list',
    names.length >= 4, `found ${names.join(', ')}`);

  const unescaped = [];
  const unreviewed = [];
  const wrongHelper = [];
  let interpolationCount = 0;
  let escapedCount = 0;

  for (const name of names) {
    const src = readFileSync(join(SCRIPTS, name), 'utf8');
    const masked = maskSource(src);
    check(`${name}: the mask preserves offsets`, masked.length === src.length);

    for (const [from, to] of printSinks(masked)) {
      // 3. `safe()` where `safeField()` is meant. The two longer names are
      //    removed first so their own `safe`/`Field` prefix cannot match.
      const bare = masked.slice(from, to).replace(/\b(?:safeField|jsonSafe)\s*\(/g, '');
      if (/\bsafe\s*\(/.test(bare)) wrongHelper.push(`${name}:${src.slice(0, from).split('\n').length}`);

      for (const [x, y] of interpolations(masked, from, to)) {
        const expr = masked.slice(x, y).replace(/\s+/g, ' ').trim();
        const line = src.slice(0, x).split('\n').length;
        interpolationCount += 1;

        const derived = repoDerivedNames(expr);
        if (derived.length) { unescaped.push({ name, line, expr, derived }); continue; }

        const shape = nonTextShape(expr);
        if (shape) {
          if (shape === 'an escaping call' || shape === 'each element escaped') escapedCount += 1;
          continue;
        }
        if (REVIEWED_NON_TEXT.has(expr)) continue;
        if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
          const rhs = resolveLocalConst(masked, expr, x);
          if (rhs !== null && resolvesNonText(rhs)) continue;
        }
        unreviewed.push(`${name}:${line} \`${expr}\``);
      }
    }
  }

  // A scan that reached nothing looks exactly like a scan that found nothing
  // wrong, which is a failure this repo has already shipped once.
  check('the scan actually reached the print sinks',
    interpolationCount >= 80 && escapedCount >= 20,
    `${interpolationCount} interpolation(s), ${escapedCount} escaper-covered`);

  // 1. Repo-derived text outside an escaping call. The allowlist is applied
  //    here and nowhere earlier, so it can excuse a KNOWN site and nothing else.
  const allowed = new Set(KNOWN_UNESCAPED.map(([f, e]) => `${f} ${e}`));
  const surprises = unescaped.filter((u) => !allowed.has(`${u.name} ${u.expr}`));
  check('no repo-derived value reaches a print sink unescaped',
    surprises.length === 0,
    surprises.map((u) => `${u.name}:${u.line} \`${u.expr}\` carries ${u.derived.join(', ')}`).join('; '));
  check('the reviewed-unescaped list has no stale entries',
    unescaped.length === KNOWN_UNESCAPED.length,
    `${unescaped.length} found, ${KNOWN_UNESCAPED.length} listed - delete the entry when the site is fixed`);

  // 2. Everything else classified by shape, by a local const, or by hand.
  check('every other interpolation is escaped, non-text by shape, or reviewed',
    unreviewed.length === 0,
    unreviewed.join('; '));

  // 3.
  check('no print sink uses safe() where safeField() is meant',
    wrongHelper.length === 0, wrongHelper.join(', '));

  checkFlushConvention(names);
}

/**
 * 4. The flush half.
 *
 * `console.log(big); process.exit(0)` delivered exactly 65,536 bytes of a
 * 596,029-byte document on a real 439-file repo and exited 0. The three
 * `--json` sinks route through `writeStdout` instead; nothing enforced that
 * they keep doing so, or that a later `console.log` does not run after one and
 * lose both the flush and - since the `'error'` listener is process-wide - the
 * stack trace it would otherwise have thrown.
 */
function checkFlushConvention(names) {
  for (const name of names) {
    const src = readFileSync(join(SCRIPTS, name), 'utf8');
    const masked = maskSource(src);
    const sites = [...masked.matchAll(/writeStdout\s*\(/g)]
      // The definition in lib.mjs is not a call site.
      .filter((hit) => !/(?:function|const)\s+$/.test(masked.slice(Math.max(0, hit.index - 24), hit.index)));

    for (const hit of sites) {
      const line = src.slice(0, hit.index).split('\n').length;
      check(`${name}:${line} awaits writeStdout`,
        /await\s+$/.test(masked.slice(Math.max(0, hit.index - 12), hit.index)),
        'unawaited, the text report below runs before the exit lands');

      const after = masked.slice(hit.index);
      const exitAt = after.search(/process\.exit\s*\(/);
      const logAt = after.search(/console\.log\s*\(/);
      check(`${name}:${line} exits before it prints again`,
        exitAt !== -1 && (logAt === -1 || exitAt < logAt),
        'output after a writeStdout is neither flushed nor able to report its own failure');
    }

    check(`${name} routes any --json payload through writeStdout`,
      !/console\.log\s*\(\s*(?:jsonSafe|JSON\.stringify)\s*\(/.test(masked),
      'console.log on a pipe truncates at one 65,536-byte buffer and exits 0');
  }
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
    ['silent-skips', testSilentSkipsAnnounced],
    ['relative-root', testRelativeRootParity],
    ['parsing-rules', testParsingRules],
    ['every-verdict', testEveryVerdict],
    ['below-toplevel', testBelowToplevelFallback],
    ['escaping-conventions', testEscapingConventions],
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
