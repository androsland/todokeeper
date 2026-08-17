/**
 * Shared parsing for todokeeper's three scripts.
 *
 * Everything here is deliberately structural rather than semantic. It counts
 * bytes, splits on headings, and pulls backticked spans out of prose. It never
 * decides what an entry MEANS — that is the reading model's job, and a script
 * that guessed at it would be wrong silently.
 */

import { readFileSync, existsSync, statSync, readdirSync, realpathSync } from 'node:fs';
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

export function loadConfig(root) {
  const path = join(root, '.todokeeper.json');
  if (!existsSync(path)) return { ...DEFAULTS, _source: 'defaults' };
  // A `.todokeeper.json` symlinked out of the repo would be parsed as config,
  // and a JSON parse error quotes the offending bytes back in its message —
  // enough to read a line of any file the process can open.
  if (!contained(root, path)) {
    throw new Error('.todokeeper.json resolves outside the repository; refusing to read it');
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`.todokeeper.json is not valid JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('.todokeeper.json must contain a JSON object');
  }
  // Unknown keys are rejected rather than ignored. Without this, a config
  // carrying `entryPattern` — the regex knob this tool deliberately no longer
  // has — would be accepted in silence and quietly run on defaults, which reads
  // as "my pattern is in effect" and is the worst of the three outcomes.
  const unknown = Object.keys(parsed).filter((k) => !(k in DEFAULTS));
  if (unknown.length) {
    throw new Error(
      `.todokeeper.json: unknown key(s) ${unknown.map((k) => `\`${k}\``).join(', ')}. `
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
  if (!Array.isArray(config.completedHeadings)
    || config.completedHeadings.some((t) => typeof t !== 'string')) {
    throw new Error('.todokeeper.json: `completedHeadings` must be an array of strings');
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
 * CLI entry point for the above. A rejected pattern or a target that escapes
 * the repo is a thing the user typed, and a V8 stack trace buries the one line
 * that says which key to fix.
 */
export function loadConfigOrExit(root) {
  try {
    return loadConfig(root);
  } catch (err) {
    process.stderr.write(`todokeeper: ${err.message}\n`);
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
        process.stderr.write(`todokeeper: skipping \`${target}\` — it resolves outside the repository\n`);
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
        else process.stderr.write(`todokeeper: skipping \`${target}/${name}\` — it resolves outside the repository\n`);
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

/**
 * Entries within a section. An entry runs from its opening bullet to the line
 * before the next bullet at the same-or-shallower indent, so a multi-paragraph
 * entry stays one entry rather than becoming one per line.
 */
export function entries(body, entryStyles) {
  const lines = body.split('\n');
  const out = [];
  let current = null;
  let fence = null;

  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (line.trimStart().startsWith(fence)) fence = null;
      if (current) current.lines.push(line);
      continue;
    }
    if (fence === null && isEntryStart(line, entryStyles)) {
      if (current) out.push(current);
      current = { lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) out.push(current);

  return out.map((e) => {
    const text = e.lines.join('\n');
    return {
      text, lead: leadPhrase(text), needle: searchNeedle(text), referents: referentsIn(text),
    };
  });
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
  for (const abs of walkFiles(root, ignore)) {
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
  return { byPath, byBase, dirs, ignore: new Set(ignore), deps: declaredDependencies(root) };
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
      const json = JSON.parse(readFileSync(join(root, file), 'utf8'));
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
  // A leading slash with no file extension is a site route, not a path in the
  // tree — `/`, `/el/`, `/terms`. Reporting those as missing files is noise.
  if (stripped.startsWith('/') && !KNOWN_EXT.test(stripped)) {
    return { kind: 'route', needle: stripped, raw };
  }
  if (/[*?]/.test(stripped) && stripped.includes('/')) {
    const dir = stripped.slice(0, stripped.lastIndexOf('/'));
    return {
      kind: 'glob',
      needle: stripped,
      dir,
      resolved: index && index.dirs.has(dir) ? dir : null,
      ignored: isIgnoredPath(dir, index),
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
  if (NOT_A_PATH.test(stripped)) return { kind: 'symbol', needle: stripped, raw };
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
    return {
      kind: 'path', needle: stripped, resolved: null, ignored: isIgnoredPath(stripped, index), raw,
    };
  }
  return { kind: 'symbol', needle: stripped.replace(/\(\)$/, ''), raw };
}

/** Does this path sit under a directory the scan was told to skip? */
function isIgnoredPath(path, index) {
  if (!index || !index.ignore) return false;
  const first = path.split('/')[0];
  return index.ignore.has(first);
}

/* ------------------------------------------------------------------ commit */

export function lastCommitTouching(root, pathspecs, extraArgs = []) {
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%H%x09%cI%x09%s', ...extraArgs, '--', ...pathspecs],
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
      ['log', '-1', '--format=%H%x09%cI%x09%s', `-S${phrase}`, '--', ...pathspecs],
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

export function walkFiles(root, ignore) {
  const skip = new Set(ignore);
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      if (skip.has(item.name)) continue;
      const abs = join(dir, item.name);
      if (item.isDirectory()) stack.push(abs);
      else if (item.isFile()) out.push(abs);
    }
  }
  return out;
}

export const isText = (path) =>
  !/\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|pdf|zip|gz|mp4|webm|wasm)$/i.test(path);

export const rel = (root, abs) => relative(root, abs).split(sep).join('/');

export const daysBetween = (a, b) =>
  Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
