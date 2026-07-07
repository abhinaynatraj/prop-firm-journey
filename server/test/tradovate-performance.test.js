const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMoney } = require('../csv-import');

test('parseMoney parses positive dollars', () => {
  assert.equal(parseMoney('$294.00'), 294);
});

test('parseMoney parses parenthesized negatives', () => {
  assert.equal(parseMoney('$(205.00)'), -205);
});

test('parseMoney strips thousands commas', () => {
  assert.equal(parseMoney('$(1,150.00)'), -1150);
});

test('parseMoney handles zero and empty', () => {
  assert.equal(parseMoney('$0.00'), 0);
  assert.equal(parseMoney(''), 0);
  assert.equal(parseMoney(undefined), 0);
});
