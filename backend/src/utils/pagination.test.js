const { test } = require('node:test');
const assert = require('node:assert');
const { parsePagination } = require('./pagination');

test('parsePagination returns defaults for empty query', () => {
  const result = parsePagination({});
  assert.deepStrictEqual(result, { limit: 20, offset: 0 });
});

test('parsePagination respects custom defaults', () => {
  const result = parsePagination({}, { limit: 50, max: 200 });
  assert.deepStrictEqual(result, { limit: 50, offset: 0 });
});

test('parsePagination parses limit and offset from query', () => {
  const result = parsePagination({ limit: '10', offset: '5' });
  assert.deepStrictEqual(result, { limit: 10, offset: 5 });
});

test('parsePagination caps limit to max', () => {
  const result = parsePagination({ limit: '999' }, { limit: 20, max: 100 });
  assert.deepStrictEqual(result, { limit: 100, offset: 0 });
});

test('parsePagination floors offset to 0 for negative values', () => {
  const result = parsePagination({ offset: '-5' });
  assert.deepStrictEqual(result, { limit: 20, offset: 0 });
});

test('parsePagination treats non-numeric limit as default', () => {
  const result = parsePagination({ limit: 'abc' });
  assert.deepStrictEqual(result, { limit: 20, offset: 0 });
});

test('parsePagination treats limit=0 as default', () => {
  const result = parsePagination({ limit: '0' });
  assert.deepStrictEqual(result, { limit: 20, offset: 0 });
});

test('parsePagination handles undefined or null query safely', () => {
  assert.deepStrictEqual(parsePagination(), { limit: 20, offset: 0 });
  assert.deepStrictEqual(parsePagination(null), { limit: 20, offset: 0 });
});

test('parsePagination treats non-numeric offset as default 0', () => {
  const result = parsePagination({ offset: 'abc' });
  assert.deepStrictEqual(result, { limit: 20, offset: 0 });
});

test('parsePagination clamps negative limit to minimum of 1', () => {
  const result = parsePagination({ limit: '-5' });
  assert.deepStrictEqual(result, { limit: 1, offset: 0 });
});

test('parsePagination clamps negative offset to 0', () => {
  const result = parsePagination({ offset: '-10' });
  assert.deepStrictEqual(result, { limit: 20, offset: 0 });
});

test('parsePagination treats empty strings as defaults', () => {
  const result = parsePagination({ limit: '', offset: '' });
  assert.deepStrictEqual(result, { limit: 20, offset: 0 });
});

test('parsePagination parses decimal strings to integers', () => {
  const result = parsePagination({ limit: '15.9', offset: '4.2' });
  assert.deepStrictEqual(result, { limit: 15, offset: 4 });
});

test('parsePagination handles excessively large limit and offset', () => {
  const result = parsePagination({ limit: '1000000', offset: '500000' }, { limit: 20, max: 100 });
  assert.deepStrictEqual(result, { limit: 100, offset: 500000 });
});

test('parsePagination preserves valid pagination values', () => {
  const result = parsePagination({ limit: '25', offset: '10' });
  assert.deepStrictEqual(result, { limit: 25, offset: 10 });
});
