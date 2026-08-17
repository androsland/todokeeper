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
 *  - It asserts that verdicts are WELL-FORMED, not that they are CORRECT. The
 *    fixture is small enough to reason about, but this is not a corpus test:
 *    a change that reclassified every symbol as prose would pass here and be
 *    caught only by the real-repo parity diff described above.
 *  - The control-byte scan covers the four `scripts/*.mjs` and this file. Not
 *    SKILL.md, not README.md, not any config or fixture — and nothing runs this
 *    suite for you, so it protects the edits of whoever remembers to run it.
 *  - It runs on one platform, in one shell, with whatever git is installed.
 *    `stale.mjs` shells out to `git log -S`; a git old enough to lack a flag it
 *    uses fails here as a test error, which is the right outcome but is not the
 *    same as supporting that git.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS, classifyReferent, buildFileIndex, loadConfig } from '../scripts/lib.mjs';

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
    '- **A symbol** — `buildFileIndex` changed shape.',
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
    ['/el/', 'route'],
    ['@scope/pkg', 'external'],
    ['https://example.com', 'external'],
    ['example.com', 'external'],
    ['origin/main', 'ref'],
    ['two words here', 'prose'],
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

// ------------------------------------- 5. no literal control byte in source

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
    ['control-bytes', testNoControlBytes],
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
