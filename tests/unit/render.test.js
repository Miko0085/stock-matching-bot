'use strict';

// Pagination controls (2026-09-28, /stock?market=moscow was silently
// truncated to a hardcoded LIMIT 500 with no indication of it -- see
// dashboard/render.js's renderPagination header comment). Pure
// data-in/HTML-out, no DB/HTTP.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderPagination } = require('../../dashboard/render');

test('renderPagination: shows an honest "showing X-Y of Z" range for a middle page', () => {
  const html = renderPagination({ page: 3, pageSize: 200, totalCount: 10411, totalPages: 53 }, (p) => `/stock?page=${p}`);
  assert.match(html, /Показано 401–600 из 10411/);
  assert.match(html, /страница 3 из 53/);
});

test('renderPagination: the last (partial) page shows the correct "to" bound, not pageSize past the end', () => {
  const html = renderPagination({ page: 53, pageSize: 200, totalCount: 10411, totalPages: 53 }, (p) => `/stock?page=${p}`);
  assert.match(html, /Показано 10401–10411 из 10411/);
});

test('renderPagination: page 1 of many has an active "next" link but a disabled "prev"', () => {
  const html = renderPagination({ page: 1, pageSize: 200, totalCount: 500, totalPages: 3 }, (p) => `/stock?page=${p}`);
  assert.match(html, /<span class="disabled">&larr; Назад<\/span>/);
  assert.match(html, /<a href="\/stock\?page=2">Вперёд &rarr;<\/a>/);
});

test('renderPagination: the last page has an active "prev" link but a disabled "next"', () => {
  const html = renderPagination({ page: 3, pageSize: 200, totalCount: 500, totalPages: 3 }, (p) => `/stock?page=${p}`);
  assert.match(html, /<a href="\/stock\?page=2">&larr; Назад<\/a>/);
  assert.match(html, /<span class="disabled">Вперёд &rarr;<\/span>/);
});

test('renderPagination: a single page (everything fits) disables both prev and next', () => {
  const html = renderPagination({ page: 1, pageSize: 200, totalCount: 50, totalPages: 1 }, (p) => `/stock?page=${p}`);
  assert.match(html, /<span class="disabled">&larr; Назад<\/span>/);
  assert.match(html, /<span class="disabled">Вперёд &rarr;<\/span>/);
});

test('renderPagination: zero results renders a plain empty message, not "showing 1-0 of 0"', () => {
  const html = renderPagination({ page: 1, pageSize: 200, totalCount: 0, totalPages: 1 }, (p) => `/stock?page=${p}`);
  assert.match(html, /Ничего не найдено/);
  assert.doesNotMatch(html, /Показано/);
});

test('renderPagination: linkFor is used to build hrefs, so the caller controls other query params (e.g. ?market=moscow)', () => {
  const html = renderPagination({ page: 1, pageSize: 200, totalCount: 500, totalPages: 3 }, (p) => `/stock?market=moscow&page=${p}`);
  assert.match(html, /href="\/stock\?market=moscow&page=2"/);
});
