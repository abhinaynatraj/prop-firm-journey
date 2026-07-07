const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMoney, detectFormat } = require('../csv-import');

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

test('detectFormat recognizes Tradovate Performance headers', () => {
  const headers = ['Symbol','Qty','Buy Price','Buy Time','Duration','Sell Time','Sell Price','P&L'];
  assert.equal(detectFormat(headers), 'tradovate-performance');
});

test('detectFormat still recognizes generic entry/exit trades', () => {
  const headers = ['Symbol','Entry Price','Exit Price'];
  assert.equal(detectFormat(headers), 'generic-trades');
});

test('detectFormat prefers tradovate-performance over generic when both could match', () => {
  const headers = ['Symbol','Qty','Buy Price','Buy Time','Sell Time','Sell Price','P&L','Entry Price','Exit Price'];
  assert.equal(detectFormat(headers), 'tradovate-performance');
});
