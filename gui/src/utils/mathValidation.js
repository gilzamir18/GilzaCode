const MATH_ENVIRONMENTS = new Set([
  'array',
  'Bmatrix',
  'bmatrix',
  'cases',
  'CD',
  'gather',
  'gathered',
  'matrix',
  'pmatrix',
  'smallmatrix',
  'split',
  'Vmatrix',
  'vmatrix',
  'aligned',
  'alignedat',
]);

const LIMIT_OPERATORS = [
  'bigcap',
  'bigcup',
  'coprod',
  'int',
  'oint',
  'prod',
  'sum',
];

export function sanitizeDisplayMath(math) {
  return (math || '')
    .replace(/\\label\s*\{[^{}]*\}/g, '')
    .replace(/\\(?:nonumber|notag)\b/g, '')
    .trim();
}

export function validateRenderableMath(math, { displayMode = false } = {}) {
  const source = displayMode ? sanitizeDisplayMath(math) : (math || '').trim();
  if (!source) return invalidMath('empty');

  const quickFailure = findMalformedMathPattern(source);
  if (quickFailure) return quickFailure;

  const delimiterFailure = validateDelimiters(source);
  if (delimiterFailure) return delimiterFailure;

  const environmentFailure = validateEnvironments(source);
  if (environmentFailure) return environmentFailure;

  const leftRightFailure = validateLeftRightPairs(source);
  if (leftRightFailure) return leftRightFailure;

  return { ok: true, math: source };
}

export function invalidMath(reasonKey, params = {}) {
  return { ok: false, reasonKey: `richTextEditor.math.${reasonKey}`, reasonParams: params };
}

function findMalformedMathPattern(source) {
  if (/\\\\(?:left|right)\b/.test(source)) {
    return invalidMath('lineBreakBeforeDelimiter');
  }

  if (/(^|[^\\])\*\s*\{/.test(source)) {
    return invalidMath('asteriskSubscript');
  }

  const limitOperatorPattern = new RegExp(`\\\\(?:${LIMIT_OPERATORS.join('|')})\\s*\\{`);
  if (limitOperatorPattern.test(source)) {
    return invalidMath('operatorLimits');
  }

  if (/\\(?:begin|end)\s*(?!\{)/.test(source)) {
    return invalidMath('malformedEnvironment');
  }

  return '';
}

function validateDelimiters(source) {
  const stack = [];
  const pairs = { '}': '{', ']': '[', ')': '(' };
  const opens = new Set(['{', '[', '(']);
  const closes = new Set(Object.keys(pairs));

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\') {
      const leftRight = source.slice(i).match(/^\\(?:left|right)\b/);
      if (leftRight) {
        i = skipLeftRightDelimiter(source, i + leftRight[0].length) - 1;
        continue;
      }

      const next = source[i + 1];
      if (next && '{}[]()'.includes(next)) i += 1;
      continue;
    }

    if (opens.has(char)) {
      stack.push(char);
      continue;
    }

    if (closes.has(char)) {
      const expected = pairs[char];
      if (stack.pop() !== expected) {
        return invalidMath('unmatchedDelimiter', { delimiter: char });
      }
    }
  }

  if (stack.length) {
    return invalidMath('unmatchedDelimiter', { delimiter: stack[stack.length - 1] });
  }

  return '';
}

function skipLeftRightDelimiter(source, start) {
  let i = start;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (source[i] === '\\' && source[i + 1]) return i + 2;
  if (source[i]) return i + 1;
  return i;
}

function validateEnvironments(source) {
  const stack = [];
  const envPattern = /\\(begin|end)\s*\{([^{}]+)\}/g;
  let match;

  while ((match = envPattern.exec(source)) !== null) {
    const [, command, name] = match;
    if (!MATH_ENVIRONMENTS.has(name)) {
      return invalidMath('unsupportedEnvironment', { name });
    }

    if (command === 'begin') {
      stack.push(name);
      continue;
    }

    if (stack.pop() !== name) {
      return invalidMath('unmatchedEndEnvironment', { name });
    }
  }

  if (stack.length) {
    return invalidMath('unmatchedBeginEnvironment', { name: stack[stack.length - 1] });
  }

  return '';
}

function validateLeftRightPairs(source) {
  const stack = [];
  const commandPattern = /\\(left|right)\b/g;
  let match;

  while ((match = commandPattern.exec(source)) !== null) {
    if (match[1] === 'left') {
      stack.push('left');
      continue;
    }

    if (!stack.length) {
      return invalidMath('unmatchedRightDelimiter');
    }
    stack.pop();
  }

  if (stack.length) return invalidMath('unmatchedLeftDelimiter');
  return '';
}
