import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { startTokenEntry } from './token-entry.mjs';

const workRoot = tmpdir();
// Only synthetic credentials and IDs are used in these fixtures.
const initial = '# keep this comment\r\nDISCORD_BOT_TOKEN=old_fixture_only_value\r\nDISCORD_APPLICATION_ID=3333333333333333333\r\nDISCORD_CONTROLLER_USER_ID=fixture_controller\r\nOTHER="keep $ and = exactly"\r\n';
const fakeToken = 'fixture_only_token_not_a_credential_1234567890';
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(workRoot, 'codex-mobile-token-entry-test-'));
  await writeFile(path.join(dir, '.env'), initial);
  const entry = await startTokenEntry({ fixtureDirectory: dir, ...options });
  t.after(async () => { await entry.close(); await rm(dir, { recursive: true, force: true }); });
  const response = await fetch(entry.url);
  const html = await response.text();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(html, /type="password"/);
  assert.ok(!html.includes('old_fixture_only_value'));
  return { dir, entry, csrf: html.match(/name="csrf" value="([a-f0-9]+)"/)[1] };
}
function post(entry, csrf, token = fakeToken, headers = {}) {
  if (headers.Host) {
    return new Promise((resolve, reject) => {
      const body = new URLSearchParams({ csrf, token }).toString();
      const request = http.request(`${entry.url}save`, { method: 'POST', headers: {
        Origin: new URL(entry.url).origin, 'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body), ...headers
      } }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, text: async () => text }));
      });
      request.on('error', reject);
      request.end(body);
    });
  }
  return fetch(`${entry.url}save`, { method: 'POST', headers: {
    Origin: new URL(entry.url).origin, 'Content-Type': 'application/x-www-form-urlencoded', ...headers
  }, body: new URLSearchParams({ csrf, token }) });
}

test('token save preserves all other fields and stops without echoing either token', async (t) => {
  const { dir, entry, csrf } = await fixture(t);
  const response = await post(entry, csrf, ` ${fakeToken} `);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /保存しました/);
  assert.ok(!html.includes(fakeToken));
  assert.ok(!html.includes('old_fixture_only_value'));
  assert.equal(await readFile(path.join(dir, '.env'), 'utf8'), initial.replace('old_fixture_only_value', fakeToken));
  await entry.closed;
  assert.deepEqual(await readdir(dir), ['.env']);
  await assert.rejects(fetch(entry.url));
});

test('bad origin, host, csrf, content type, token and oversized payload cannot save', async (t) => {
  const { dir, entry, csrf } = await fixture(t);
  for (const [expected, token, headers, submittedCsrf] of [
    [403, fakeToken, { Origin: 'https://example.com' }, csrf],
    [403, fakeToken, { Origin: '' }, csrf],
    [403, fakeToken, { Host: 'localhost:9999' }, csrf],
    [403, fakeToken, {}, 'a'.repeat(64)],
    [415, fakeToken, { 'Content-Type': 'text/plain' }, csrf],
    [400, `${fakeToken}\nOTHER=changed`, {}, csrf],
    [413, 'a'.repeat(5000), {}, csrf]
  ]) {
    const response = await post(entry, submittedCsrf, token, headers);
    const html = await response.text();
    assert.equal(response.status, expected);
    assert.ok(!html.includes(fakeToken));
    assert.equal(await readFile(path.join(dir, '.env'), 'utf8'), initial);
  }
});

test('short test timeout closes the server without touching credentials', async (t) => {
  const { dir, entry } = await fixture(t, { timeoutMs: 100 });
  await entry.closed;
  assert.equal(await readFile(path.join(dir, '.env'), 'utf8'), initial);
  await assert.rejects(fetch(entry.url));
});

test('fixture path cannot point outside the workspace fixture directory', async () => {
  await assert.rejects(startTokenEntry({ fixtureDirectory: path.dirname(workRoot) }), /outside the test workspace/);
});
