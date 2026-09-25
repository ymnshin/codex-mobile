import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxBodyBytes = 4096;
const tokenLine = /^(\uFEFF?[\t ]*(?:export[\t ]+)?DISCORD_BOT_TOKEN[\t ]*=[\t ]*)[^\r\n]*/gm;

async function envTarget(fixtureDirectory) {
  if (!fixtureDirectory) return path.join(repoRoot, '.env');
  // Fixtures are only available to Node's test runner in a dedicated temporary directory.
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('Fixture mode is test-only.');
  const allowedRoot = await realpath(tmpdir());
  const fixtureRoot = await realpath(fixtureDirectory);
  if (path.dirname(fixtureRoot) !== allowedRoot || !path.basename(fixtureRoot).startsWith('codex-mobile-token-entry-test-')) {
    throw new Error('Fixture directory is outside the test workspace.');
  }
  return path.join(fixtureRoot, '.env');
}

async function saveToken(envPath, token) {
  const [original, fileStat] = await Promise.all([readFile(envPath, 'utf8'), stat(envPath)]);
  if (!fileStat.isFile()) throw new Error('The environment file is not a file.');
  const next = tokenLine.test(original)
    ? original.replace(tokenLine, (_line, prefix) => `${prefix}${token}`)
    : `${original}${original && !original.endsWith('\n') ? (original.includes('\r\n') ? '\r\n' : '\n') : ''}DISCORD_BOT_TOKEN=${token}${original.includes('\r\n') ? '\r\n' : '\n'}`;
  tokenLine.lastIndex = 0;
  const temporary = `${envPath}.token-entry-${randomBytes(12).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', fileStat.mode & 0o777);
    await file.writeFile(next, 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, envPath);
  } finally {
    await file?.close();
    await unlink(temporary).catch(() => {});
  }
}

function page(content) {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Discord Botの接続設定</title><style>body{font:18px/1.7 system-ui,sans-serif;color:#e9edf6;background:#171b25;max-width:620px;margin:60px auto;padding:24px}h1{font-size:28px}input,button{font:inherit;width:100%;box-sizing:border-box;padding:14px;margin:12px 0;border-radius:8px}input{border:1px solid #7d899e;background:#252d3d;color:white}button{border:0;background:#7289ff;color:#101528;font-weight:bold;cursor:pointer}small{color:#b5bfd3}</style><main>${content}</main></html>`;
}

export async function startTokenEntry({ fixtureDirectory, timeoutMs = 15 * 60 * 1000 } = {}) {
  const envPath = await envTarget(fixtureDirectory);
  await stat(envPath);
  const csrf = randomBytes(32).toString('hex');
  let origin;
  let saving = false;
  let finished = false;
  let timeout;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const server = http.createServer(async (req, res) => {
    const reply = (status, content) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store', 'Pragma': 'no-cache',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin',
        'Connection': 'close'
      });
      res.end(page(content));
    };
    if (req.headers.host !== new URL(origin).host || req.socket.remoteAddress !== '127.0.0.1') {
      reply(403, '<p>このPCの正しいURLから開いてください。</p>'); return;
    }
    if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      reply(403, '<p>別のサイトからの操作は受け付けません。</p>'); return;
    }
    if (req.method === 'GET' && req.url === '/') {
      reply(200, `<h1>Discord Botの接続設定</h1><p>Developer PortalでコピーしたBotトークンを貼り付けてください。</p><form method="post" action="/save" autocomplete="off"><input type="hidden" name="csrf" value="${csrf}"><label for="token">Botトークン</label><input id="token" name="token" type="password" autocomplete="new-password" autocapitalize="none" spellcheck="false" maxlength="512" required autofocus><button type="submit">このPCに保存</button></form><small>この画面はこのPCの中だけで動作します。トークンはローカルの.envへ保存し、チャットには送信しません。保存後、または15分後に入力サービスを終了します。</small>`); return;
    }
    if (req.method !== 'POST' || req.url !== '/save') { reply(404, '<p>ページがありません。</p>'); return; }
    if (req.headers.origin !== origin) { reply(403, '<p>入力画面から保存してください。</p>'); return; }
    if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
      reply(415, '<p>入力形式が正しくありません。</p>'); return;
    }
    if (saving || finished) { reply(409, '<p>保存処理中または保存済みです。</p>'); return; }
    if (Number(req.headers['content-length'] ?? 0) > maxBodyBytes) { reply(413, '<p>入力が長すぎます。</p>'); return; }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) { reply(413, '<p>入力が長すぎます。</p>'); return; }
        chunks.push(chunk);
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const suppliedCsrf = form.get('csrf') ?? '';
      if (form.getAll('csrf').length !== 1 || !/^[a-f0-9]{64}$/.test(suppliedCsrf) || !timingSafeEqual(Buffer.from(suppliedCsrf), Buffer.from(csrf))) {
        reply(403, '<p>入力画面を開き直してください。</p>'); return;
      }
      const rawToken = form.get('token') ?? '';
      const token = rawToken.trim();
      if (form.getAll('token').length !== 1 || [...form.keys()].some((key) => key !== 'token' && key !== 'csrf') || /[\x00-\x1f\x7f]/.test(rawToken) || !/^[A-Za-z0-9._-]{20,512}$/.test(token)) {
        reply(400, '<p>Botトークンを改行なしで貼り付けてください。</p>'); return;
      }
      if (saving || finished) { reply(409, '<p>保存処理中または保存済みです。</p>'); return; }
      saving = true;
      await saveToken(envPath, token);
      finished = true;
      reply(200, '<h1>保存しました</h1><p>トークンをこのPCに保存しました。このタブを閉じて、Codexに「保存した」と伝えてください。</p><p>入力サービスは終了します。Discordへの接続確認はまだ行っていません。</p>');
      setImmediate(() => { void close(); });
    } catch {
      saving = false;
      if (!res.headersSent) reply(500, '<p>保存できませんでした。入力サービスを再起動してください。</p>');
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  const close = async () => {
    clearTimeout(timeout);
    if (!server.listening) return closed;
    server.close(() => resolveClosed());
    server.closeAllConnections();
    return closed;
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  timeout = setTimeout(() => { void close(); }, timeoutMs);
  return { url: `${origin}/`, close, closed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const entry = await startTokenEntry();
    console.log(entry.url);
    process.once('SIGINT', () => { void entry.close(); });
    process.once('SIGTERM', () => { void entry.close(); });
    await entry.closed;
    console.log('Token entry service closed.');
  } catch {
    console.error('Token entry service could not start. Check the local .env file.');
    process.exitCode = 1;
  }
}
