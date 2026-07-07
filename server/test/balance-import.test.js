const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMoney } = require('../balance-import');

test('parseMoney parses quoted comma values', () => {
  assert.equal(parseMoney('51,126.40'), 51126.4);
});
test('parseMoney parses negative comma values', () => {
  assert.equal(parseMoney('-1,377.50'), -1377.5);
});
test('parseMoney parses zero and plain numbers', () => {
  assert.equal(parseMoney('0.00'), 0);
  assert.equal(parseMoney('881.60'), 881.6);
});
test('parseMoney handles empty/undefined', () => {
  assert.equal(parseMoney(''), 0);
  assert.equal(parseMoney(undefined), 0);
});
