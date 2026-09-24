import http from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaults, validateSettings } from '../shared/config.mjs';
import { textExcerpt } from '../shared/diagnostics.mjs';
import { extractSource } from '../shared/source.mjs';
import { messagesFor, systemPrompt } from './prompt.mjs';
import { ApiError, upstream, upstreamChatStream } from './upstream.mjs';

const ROOT = resolve(import.meta.dirname, '..');
export async function startServer({
  port = Number(process.env.PORT || 4173),
  vite,
  persist = true,
} = {}) {
  const token = randomBytes(32).toString('hex');
  const promptHash = createHash('sha256').update(systemPrompt).digest('hex');
  let apiKey = '';
  let active = null;
  let settings = { ...defaults };
  let vision = null;
  const settingsPath = resolve(ROOT, '.local/settings.json');
  if (persist)
    try {
      settings = validateSettings(JSON.parse(await readFile(settingsPath, 'utf8')));
    } catch {
      /* first run */
    }
  function send(res, status, value) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
  }
  async function body(req) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 12 * 1024 * 1024)
        throw new ApiError('送信データが12MBを超えました。', 'budget', 413);
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw new ApiError('JSON形式が不正です。', 'validation', 400);
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const actualPort = server.address()?.port;
    const allowed = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    if (!allowed.includes(req.headers.host))
      return send(res, 403, { error: 'Host が許可されていません。', code: 'forbidden' });
    const origin = `http://${req.headers.host}`;
    const pathname = new URL(req.url, origin).pathname;
    if (pathname.startsWith('/api/')) {
      if (
        (req.headers.origin && req.headers.origin !== origin) ||
        (req.headers['sec-fetch-site'] &&
          !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))
      )
        return send(res, 403, { error: '同一オリジンからのみ利用できます。', code: 'forbidden' });
      if (pathname === '/api/session' && req.method === 'GET')
        return send(res, 200, { token, settings, hasApiKey: Boolean(apiKey), vision, promptHash });
      const supplied = Buffer.from(String(req.headers['x-session-token'] || ''));
      if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token)))
        return send(res, 403, {
          error: 'セッションが無効です。ページを再読込してください。',
          code: 'session',
        });
      let streamingResponse = false;
      const streamEvent = (value) => res.write(JSON.stringify(value) + '\n');
      try {
        if (pathname === '/api/settings' && req.method === 'PUT') {
          if (active) throw new ApiError('処理中は接続設定を変更できません。', 'busy', 409);
          const input = await body(req);
          const next = validateSettings(input);
          if (
            Object.hasOwn(input, 'apiKey') &&
            (typeof input.apiKey !== 'string' ||
              input.apiKey.length > 4096 ||
              /[\r\n]/.test(input.apiKey))
          )
            throw new ApiError('APIキーの形式が不正です。', 'validation', 400);
          if (persist) {
            await mkdir(resolve(ROOT, '.local'), { recursive: true });
            await writeFile(settingsPath, JSON.stringify(next, null, 2));
          }
          if (
            settings.baseUrl !== next.baseUrl ||
            settings.model !== next.model ||
            Object.hasOwn(input, 'apiKey')
          )
            vision = null;
          settings = next;
          if (Object.hasOwn(input, 'apiKey')) apiKey = input.apiKey.trim();
          return send(res, 200, { settings, hasApiKey: Boolean(apiKey), vision });
        }
        if (pathname === '/api/cancel' && req.method === 'POST') {
          active?.controller.abort();
          return send(res, 200, { cancelled: Boolean(active) });
        }
        if (
          req.method !== 'POST' ||
          !['/api/models', '/api/test', '/api/generate'].includes(pathname)
        )
          return send(res, 404, { error: '見つかりません。' });
        if (active)
          throw new ApiError(
            '別の推論を実行中です。完了または停止後に実行してください。',
            'busy',
            409,
          );
        const input = await body(req);
        // Recheck after reading the request: two clients may finish bodies together.
        if (active) throw new ApiError('別の推論を実行中です。', 'busy', 409);
        const job = { controller: new AbortController() };
        active = job;
        res.on('close', () => {
          if (!res.writableEnded) job.controller.abort();
        });
        try {
          const signal = job.controller.signal;
          if (pathname === '/api/models') {
            const { data } = await upstream(settings, apiKey, '/models', null, signal);
            if (!Array.isArray(data.data))
              throw new ApiError('モデル一覧の形式が不正です。', 'protocol');
            return send(res, 200, {
              models: data.data.map((x) => x.id).filter((x) => typeof x === 'string'),
            });
          }
          if (!settings.model)
            throw new ApiError(
              'モデル一覧を取得するか、Model IDを入力してください。',
              'validation',
              400,
            );
          if (pathname === '/api/test') {
            const useImage = typeof input.image === 'string';
            if (useImage && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(input.image))
              throw new ApiError('検証画像が不正です。', 'validation', 400);
            const result = await upstream(
              settings,
              apiKey,
              '/chat/completions',
              {
                model: settings.model,
                max_tokens: 256,
                temperature: 0,
                stream: false,
                messages: [
                  {
                    role: 'user',
                    content: useImage
                      ? [
                          {
                            type: 'text',
                            text: 'What color fills this image? Reply with only one English color word.',
                          },
                          { type: 'image_url', image_url: { url: input.image } },
                        ]
                      : 'Reply with only OK.',
                  },
                ],
              },
              signal,
            );
            const choice = result.data.choices?.[0];
            const answer = choice?.message?.content;
            if (typeof answer !== 'string' || !answer.trim() || choice.finish_reason !== 'stop')
              throw new ApiError('確認応答が空か途中終了です。', 'protocol');
            if (useImage)
              vision = {
                accepted: true,
                answer: answer.slice(0, 300),
                checkedAt: new Date().toISOString(),
                model: settings.model,
              };
            return send(res, 200, {
              answer: answer.slice(0, 300),
              elapsedMs: result.elapsedMs,
              usage: result.data.usage ?? null,
              vision,
            });
          }
          if (
            typeof input.prompt !== 'string' ||
            !input.prompt.trim() ||
            input.prompt.length > 16000 ||
            (input.source && (typeof input.source !== 'string' || input.source.length > 500000)) ||
            (input.error && (typeof input.error !== 'string' || input.error.length > 4000)) ||
            !Number.isInteger(input.seed) ||
            input.seed < 0 ||
            input.seed > 2147483647
          )
            throw new ApiError('指示・ソース・seed の形式が不正です。', 'validation', 400);
          const images = input.images ?? [];
          if (
            !Array.isArray(images) ||
            images.length > 4 ||
            images.some(
              (s) =>
                typeof s !== 'string' ||
                s.length > 2800000 ||
                !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s),
            )
          )
            throw new ApiError(
              '画像はPNG/JPEG/WebP、4枚まで、各約2MBにしてください。',
              'validation',
              400,
            );
          const request = {
            model: settings.model,
            max_tokens: settings.maxTokens,
            temperature: settings.temperature,
            stream: false,
            ...(settings.reasoningEffort !== 'default'
              ? { chat_template_kwargs: { reasoning_effort: settings.reasoningEffort } }
              : {}),
            messages: messagesFor({ ...input, images }),
          };
          if (input.streamOutput === true) {
            res.writeHead(200, {
              'Content-Type': 'application/x-ndjson; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            });
            streamingResponse = true;
            streamEvent({ type: 'start' });
          }
          const result = streamingResponse
            ? await upstreamChatStream(settings, apiKey, request, signal, (channel, text) =>
                streamEvent({ type: 'delta', channel, text }),
              )
            : await upstream(settings, apiKey, '/chat/completions', request, signal);
          const choice = result.data.choices?.[0];
          let source;
          try {
            source = extractSource(choice?.message?.content, choice?.finish_reason);
          } catch (err) {
            err.details = {
              elapsedMs: result.elapsedMs,
              usage: result.data.usage ?? null,
              finishReason: choice?.finish_reason,
              output: textExcerpt(choice?.message?.content),
              reasoning: textExcerpt(choice?.message?.reasoning_content),
              ...(err.code === 'contract' &&
              choice?.finish_reason === 'stop' &&
              typeof choice.message.content === 'string' &&
              choice.message.content.length <= 500000
                ? { rejectedSource: choice.message.content }
                : {}),
            };
            throw err;
          }
          if (streamingResponse) {
            streamEvent({
              type: 'result',
              source,
              elapsedMs: result.elapsedMs,
              usage: result.data.usage ?? null,
              model: settings.model,
            });
            res.end();
            return;
          }
          return send(res, 200, {
            source,
            elapsedMs: result.elapsedMs,
            usage: result.data.usage ?? null,
            model: settings.model,
          });
        } finally {
          if (active === job) active = null;
        }
      } catch (err) {
        if (!res.destroyed) {
          const error = {
            error: err.message || '処理に失敗しました。',
            code: err.code || 'validation',
            ...(err.details ? { details: err.details } : {}),
          };
          if (streamingResponse) {
            streamEvent({ type: 'error', ...error, status: err.status || 400 });
            res.end();
          } else send(res, err.status || 400, error);
        }
      }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method))
      return send(res, 405, { error: 'Method not allowed' });
    if (vite && pathname !== '/runtime-worker.js') return vite.middlewares(req, res);
    // Parent CSP is also inherited by srcdoc; permit only the local sandbox bootstrap.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob: data:; worker-src blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    let asset;
    try {
      asset = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
    } catch {
      return send(res, 400, { error: 'URLの文字コードが不正です。' });
    }
    const file = resolve(ROOT, 'dist', asset);
    if (
      !file.startsWith(resolve(ROOT, 'dist') + '\\') &&
      !file.startsWith(resolve(ROOT, 'dist') + '/')
    )
      return send(res, 403, { error: 'Forbidden' });
    try {
      const content = await readFile(file);
      res.writeHead(200, {
        'Content-Type':
          {
            '.html': 'text/html; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.svg': 'image/svg+xml',
          }[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch {
      send(res, 404, { error: 'ファイルがありません。npm run build を実行してください。' });
    }
  });
  await new Promise((yes, no) => {
    server.once('error', no);
    server.listen(port, '127.0.0.1', yes);
  });
  console.log(`Qwen Model Studio: http://127.0.0.1:${server.address().port}`);
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await startServer();
