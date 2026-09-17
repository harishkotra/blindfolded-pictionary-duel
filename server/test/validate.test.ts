/**
 * Unit tests for the defensive parser and path validator.
 * Run: npm --workspace server run test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripFences,
  findOutermostObject,
  hasValidStart,
  validatePathData,
  parseDrawing,
} from '../src/validate.ts';

const goodPath = (d) => ({ d, stroke: '#333333', fill: 'none', width: 3 });
const wrap = (paths, label = 'cat') => JSON.stringify({ paths, label });

test('stripFences removes ```json fences', () => {
  const r = stripFences('```json\n{"a":1}\n```');
  assert.equal(r.text, '{"a":1}');
  assert.equal(r.stripped, true);
});

test('stripFences removes bare fences and handles an unterminated fence', () => {
  assert.equal(stripFences('```\n{"a":1}\n```').text, '{"a":1}');
  assert.equal(stripFences('```json\n{"a":1}').text, '{"a":1}');
});

test('stripFences leaves clean JSON alone', () => {
  const r = stripFences('{"a":1}');
  assert.equal(r.text, '{"a":1}');
  assert.equal(r.stripped, false);
});

test('findOutermostObject ignores braces inside strings and handles escapes', () => {
  assert.equal(findOutermostObject('noise {"a":"}"} tail'), '{"a":"}"}');
  assert.equal(findOutermostObject('{"a":"\\"}"}'), '{"a":"\\"}"}');
  assert.equal(findOutermostObject('{"a":{"b":1}} extra'), '{"a":{"b":1}}');
  assert.equal(findOutermostObject('no object here'), null);
});

test('hasValidStart accepts only real SVG path commands', () => {
  for (const c of ['M', 'm', 'L', 'l', 'C', 'c', 'Q', 'q', 'Z', 'z']) {
    assert.equal(hasValidStart(`${c} 0 0`), true, `${c} should be valid`);
  }
  for (const bad of ['x 0 0', '5 5', '<path', '', 'H 10']) {
    assert.equal(hasValidStart(bad), false, `${bad} should be invalid`);
  }
});

test('validatePathData rejects illegal characters and empty data', () => {
  assert.match(validatePathData('') ?? '', /empty/);
  assert.match(validatePathData('M0 0 L10 10 #bad') ?? '', /illegal character/);
  assert.match(validatePathData('x0 0') ?? '', /must start with/);
  assert.match(validatePathData('M') ?? '', /no coordinates/);
  assert.equal(validatePathData('M 0 0 L 10 10 Z'), null);
  assert.equal(validatePathData('M0 0 L10 10'), null);
});

test('parseDrawing accepts clean model output', () => {
  const out = parseDrawing(wrap([goodPath('M0 0 L10 10'), goodPath('M1 1 L2 2'), goodPath('M3 3 L4 4')]));
  assert.equal(out.ok, true);
  assert.equal(out.repaired, false);
  assert.equal(out.drawing.paths.length, 3);
  assert.equal(out.drawing.label, 'cat');
});

test('parseDrawing repairs fenced and prose-wrapped output', () => {
  const body = wrap([goodPath('M0 0 L10 10'), goodPath('M1 1 L2 2'), goodPath('M3 3 L4 4')]);

  // A fence at the very start is stripped as a fence.
  const fenced = parseDrawing(`\`\`\`json\n${body}\n\`\`\``);
  assert.equal(fenced.ok, true);
  assert.ok(fenced.repairs.some((r) => /fence/.test(r)));

  // Prose before the fence means the object is located instead.
  const prose = parseDrawing(`Sure! Here is the drawing:\n\`\`\`json\n${body}\n\`\`\`\nHope that helps.`);
  assert.equal(prose.ok, true);
  assert.equal(prose.repaired, true);
  assert.ok(prose.repairs.some((r) => /outermost JSON object/.test(r)));
  assert.equal(prose.drawing.paths.length, 3);
});

test('parseDrawing clamps out-of-viewBox coordinates and flags it', () => {
  const out = parseDrawing(wrap([goodPath('M-50 0 L900 900'), goodPath('M1 1 L2 2'), goodPath('M3 3 L4 4')]));
  assert.equal(out.ok, true);
  assert.equal(out.repaired, true);
  assert.ok(out.repairs.some((r) => /clamped/.test(r)));
  assert.ok(!out.drawing.paths[0].d.includes('-50'));
  assert.ok(!out.drawing.paths[0].d.includes('900'));
});

test('parseDrawing drops unusable paths but keeps the rest', () => {
  const out = parseDrawing(
    wrap([goodPath('M0 0 L10 10'), goodPath('totally not a path'), goodPath('M1 1 L2 2'), goodPath('M3 3 L4 4')]),
  );
  assert.equal(out.ok, true);
  assert.equal(out.drawing.paths.length, 3);
  assert.ok(out.repairs.some((r) => /dropped 1 unusable/.test(r)));
});

test('parseDrawing fails when fewer than 3 usable paths survive', () => {
  const out = parseDrawing(wrap([goodPath('M0 0 L10 10'), goodPath('nope'), goodPath('also nope')]));
  assert.equal(out.ok, false);
  assert.match(out.reason, /only 1 usable path/);
});

test('parseDrawing fails on empty content, missing paths, and non-object JSON', () => {
  assert.equal(parseDrawing('').ok, false);
  assert.match(parseDrawing('   ').reason, /empty/);
  assert.match(parseDrawing('{"label":"cat"}').reason, /missing "paths"/);
  // A bare string or array contains no object at all.
  assert.match(parseDrawing('"just a string"').reason, /no JSON object/);
  assert.match(parseDrawing('{not json at all').reason, /no JSON object|JSON.parse/);
  // An array of objects: the outermost object is the first element, which is
  // itself an array, so it is rejected as a non-object.
  assert.match(parseDrawing('{"paths":"not an array"}').reason, /missing "paths"/);
});

test('parseDrawing defaults bad colours and widths instead of failing', () => {
  const out = parseDrawing(
    wrap([
      { d: 'M0 0 L10 10', stroke: 'rebeccapurple', fill: 'none', width: 'thick' },
      { d: 'M1 1 L2 2', stroke: '#abc', fill: 'none', width: 2 },
      { d: 'M3 3 L4 4', stroke: '#abcdef', fill: 'none', width: 2 },
    ]),
  );
  assert.equal(out.ok, true);
  assert.equal(out.drawing.paths[0].width, 3);
  assert.ok(out.repairs.some((r) => /stroke width/.test(r)));
});

test('parseDrawing caps a runaway path count at 40', () => {
  const many = Array.from({ length: 60 }, (_, i) => goodPath(`M${i} 0 L${i} 10`));
  const out = parseDrawing(wrap(many));
  assert.equal(out.ok, true);
  assert.equal(out.drawing.paths.length, 40);
  assert.ok(out.repairs.some((r) => /60 paths/.test(r)));
});

test('parseDrawing recovers path data from a malformed key', () => {
  // Observed in real model output: the value is correct, the key is "d: ".
  const out = parseDrawing(
    wrap([
      { 'd: ': 'M140 320 L140 150 L180 150 L180 320 Z', stroke: '#2b2b45', fill: '#2b2b45', width: 1 },
      { d: 'M0 0 L10 10', stroke: '#333333', fill: 'none', width: 2 },
      { d: 'M1 1 L2 2', stroke: '#333333', fill: 'none', width: 2 },
      { d: 'M3 3 L4 4', stroke: '#333333', fill: 'none', width: 2 },
    ]),
  );
  assert.equal(out.ok, true);
  assert.equal(out.drawing.paths.length, 4, 'the typo-keyed path must not be dropped');
  assert.ok(out.repairs.some((r) => /malformed key/.test(r)));
  assert.ok(out.drawing.paths[0].d.startsWith('M140'));
});

test('parseDrawing recovers path data from an unnamed but path-shaped value', () => {
  const out = parseDrawing(
    wrap([
      { pathData: 'M0 0 L10 10', stroke: '#333', fill: 'none', width: 2 },
      { d: 'M1 1 L2 2', stroke: '#333', fill: 'none', width: 2 },
      { d: 'M3 3 L4 4', stroke: '#333', fill: 'none', width: 2 },
    ]),
  );
  assert.equal(out.ok, true);
  assert.equal(out.drawing.paths.length, 3);
});

test('parseDrawing survives a truncated object without throwing', () => {
  const out = parseDrawing('{"paths":[{"d":"M0 0 L10 10","stroke":"#333"');
  assert.equal(out.ok, false);
  assert.ok(typeof out.reason === 'string' && out.reason.length > 0);
});