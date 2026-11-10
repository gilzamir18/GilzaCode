// Guards the two-theme contract in `src/index.css`.
//
// The light theme is a class on <body>, not on <html>, and a custom property
// whose value contains `var()` is substituted where it is *declared*, not
// where it is used. An alias declared only in `:root` therefore resolves
// against the dark tokens and inherits that frozen value into the light theme
// — which is how the settings, cloud and asset-store modals ended up with
// black title bars on a light body. These tests fail if a token is added to
// one theme block and not the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../index.css'), 'utf8');

// Tokens that carry no color and are the same in both themes, so declaring
// them once is correct. Keep this list short and justified.
const THEME_INDEPENDENT = new Set([
  '--vscode-editor-font-family',
  '--vscode-editor-font',
  '--vscode-font-family',
  '--ui-scale',
]);

// The declarations of one rule, found by its selector. Both theme blocks are
// flat lists of custom properties, so a brace-free slice is enough.
function blockFor(selector) {
  const at = CSS.indexOf(selector + ' {');
  assert.notEqual(at, -1, `no "${selector}" block in index.css`);
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

function declarations(block) {
  const found = new Map();
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(name, value.trim());
  }
  return found;
}

const dark = declarations(blockFor(':root'));
const light = declarations(blockFor('.light-theme'));

test('every alias that resolves through another token is declared in both themes', () => {
  const aliases = [...dark].filter(([name, value]) => value.includes('var(') && !THEME_INDEPENDENT.has(name));
  assert.ok(aliases.length > 0, 'expected the VS Code vocabulary aliases in :root');
  for (const [name, value] of aliases) {
    assert.equal(
      light.get(name),
      value,
      `${name} resolves where it is declared, so the light theme must re-declare it identically`,
    );
  }
});

test('every semantic foreground accent has a light counterpart', () => {
  const accents = [...dark.keys()].filter(name => /^--vscode-(fg-|text-subtle|text-muted)/.test(name));
  assert.ok(accents.length >= 10, 'expected the semantic accent set in :root');
  for (const name of accents) {
    assert.ok(light.has(name), `${name} has no light-theme value, so it keeps its dark hue on a light surface`);
    assert.notEqual(light.get(name), dark.get(name), `${name} repeats its dark value in the light theme`);
  }
});

test('no theme token is left referencing an undefined custom property', () => {
  for (const [block, name] of [[dark, ':root'], [light, '.light-theme']]) {
    for (const [token, value] of block) {
      for (const [, referenced] of value.matchAll(/var\((--[\w-]+)/g)) {
        assert.ok(
          block.has(referenced) || dark.has(referenced),
          `${name} declares ${token} in terms of ${referenced}, which is never defined`,
        );
      }
    }
  }
});
