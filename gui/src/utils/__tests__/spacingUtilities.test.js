// Guards the utility layer in `src/index.css`.
//
// Components across the app are written in Tailwind's class vocabulary, but
// Tailwind is not a dependency: a class with no rule in index.css is simply
// dropped, and the global reset (`* { margin: 0; padding: 0 }`) means the
// element then renders with no inset at all. That failure is silent in review
// and glaring on screen — it is how the settings, asset-store and cloud
// dialogs ended up with their labels, inputs, tab strips and footers flush
// against the frame while the JSX plainly said `p-4` and `px-4`.
//
// These tests fail when a component reaches for a utility the stylesheet does
// not define, and when a dialog band drifts off the shared gutter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CSS = readFileSync(join(SRC, 'index.css'), 'utf8');

// Class selectors, with CSS escapes (`.px-1\.5`, `.text-\[13px\]`) unescaped
// so they compare equal to the token written in the JSX.
const DEFINED = new Set(
  [...CSS.matchAll(/\.((?:[A-Za-z0-9_-]|\\.)+)/g)].map(([, name]) => name.replace(/\\/g, '')),
);

// A class is a utility when it is named like one. Bespoke component classes in
// this codebase are all prefixed by their surface (`vscode-`, `pdf-`,
// `rich-text-`, `ltx-`), so they never match.
const UTILITY = [
  /^(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|space-[xy])-/,
  /^(?:text|font|leading|tracking)-/,
  /^(?:w|h|min-w|min-h|max-w|max-h)-/,
  /^(?:cursor|transition|animate|opacity|z)-/,
  /^(?:rounded|border|shadow|bg|flex|items|justify|self|overflow|group)(?:-|$)/,
  /^(?:truncate|uppercase|lowercase|capitalize|relative|absolute|fixed|sticky|shrink|grow|hidden|block)$/,
  /^(?:whitespace|break)-/,
];

function jsxFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...jsxFiles(path));
    else if (entry.endsWith('.jsx')) found.push(path);
  }
  return found;
}

// Every class token written in a `className`, from both the plain-string and
// the template-literal form. A `${...}` interpolation is blanked out: what it
// evaluates to is not readable here, which is why the class-toggling helpers
// in this codebase interpolate whole class names rather than name fragments.
function classTokens(source) {
  const tokens = [];
  for (const [, value] of source.matchAll(/className\s*=\s*"([^"]*)"/g)) {
    tokens.push(...value.split(/\s+/));
  }
  for (const [, value] of source.matchAll(/className\s*=\s*\{`([^`]*)`\}/g)) {
    tokens.push(...value.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/));
  }
  // A brace-free expression — `className={spin ? 'animate-spin' : undefined}`.
  // Only its string literals are class names; anything else is an identifier
  // this file cannot resolve, and identifiers do not look like utilities.
  for (const [, expression] of source.matchAll(/className\s*=\s*\{([^{}]*)\}/g)) {
    for (const [, single, double] of expression.matchAll(/'([^']*)'|"([^"]*)"/g)) {
      const literal = single ?? double;
      if (literal) tokens.push(...literal.split(/\s+/));
    }
  }
  return tokens.filter(Boolean);
}

test('every utility class a component writes has a rule in index.css', () => {
  const orphans = new Map();
  for (const file of jsxFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const token of classTokens(source)) {
      if (!UTILITY.some(pattern => pattern.test(token))) continue;
      if (DEFINED.has(token)) continue;
      if (!orphans.has(token)) orphans.set(token, relative(SRC, file));
    }
  }
  assert.deepEqual(
    [...orphans].map(([token, file]) => `${token} (${file})`),
    [],
    'these classes are dropped by the browser, so the element renders with no inset at all',
  );
});

test('the utility layer is recognised — the matcher itself still finds classes', () => {
  // A regression in `classTokens` or `UTILITY` would make the test above pass
  // vacuously, which is the only way it can go quietly wrong.
  const seen = jsxFiles(SRC)
    .flatMap(file => classTokens(readFileSync(file, 'utf8')))
    .filter(token => UTILITY.some(pattern => pattern.test(token)));
  assert.ok(seen.length > 100, `expected the utility vocabulary to be in use, saw ${seen.length}`);
});

// The declarations of one rule, found by its selector.
function ruleFor(selector) {
  const at = CSS.indexOf(selector + ' {');
  assert.notEqual(at, -1, `no "${selector}" rule in index.css`);
  const open = CSS.indexOf('{', at);
  return CSS.slice(open + 1, CSS.indexOf('}', open));
}

test('every band of a dialog is inset by the same gutter token', () => {
  // Header, tab strip, body and footer stack on top of each other, so a band
  // that sets its own inset lands visibly off the vertical rule the others
  // share. They may differ in the block direction; they may not differ here.
  for (const selector of [
    '.vscode-modal-header',
    '.vscode-modal-tabs',
    '.vscode-modal-content',
    '.vscode-modal-footer',
  ]) {
    const padding = /padding:\s*([^;]+);/.exec(ruleFor(selector));
    assert.ok(padding, `${selector} declares no padding, so its content sits on the frame`);
    assert.match(
      padding[1],
      /var\(--modal-gutter\)/,
      `${selector} sets its own horizontal inset instead of the shared gutter`,
    );
  }
});

test('the spacing scale is declared before anything consumes it', () => {
  const root = ruleFor(':root');
  for (const token of ['--space-1', '--space-2', '--space-4', '--modal-gutter', '--modal-body-padding']) {
    assert.match(root, new RegExp(`${token}\\s*:`), `${token} is missing from :root`);
  }
});
