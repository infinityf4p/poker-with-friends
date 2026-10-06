import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.POKER_BRIDGE_PORT || 44191);
const HOST = process.env.POKER_BRIDGE_HOST || '127.0.0.1';
const MAX_BODY = 96 * 1024;
const allowedOrigins = new Set(['https://poker.infinityf4p.com']);
let latestSnapshot = null;

function json(res, status, body) {
  const requestOrigin = typeof res.req?.headers?.origin === 'string' ? res.req.headers.origin : '';
  const extensionOrigin = requestOrigin.startsWith('chrome-extension://') ? requestOrigin : '';
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(extensionOrigin ? { 'access-control-allow-origin': extensionOrigin, vary: 'Origin' } : {}),
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function isAllowedRequest(req) {
  const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  return !requestOrigin || requestOrigin.startsWith('chrome-extension://');
}

function safeUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().slice(0, 300);
  } catch {
    return '';
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sanitizeSnapshot(input) {
  if (!input || typeof input !== 'object') throw new Error('invalid snapshot');
  const origin = typeof input.origin === 'string' ? input.origin : '';
  if (!allowedOrigins.has(origin)) throw new Error('origin is not allowed');
  return {
    origin,
    url: safeUrl(input.url),
    title: typeof input.title === 'string' ? input.title.slice(0, 200) : '',
    capturedAt: new Date().toISOString(),
    visibleText: typeof input.visibleText === 'string' ? input.visibleText.slice(0, 12000) : '',
    headings: Array.isArray(input.headings)
      ? input.headings
          .filter((value) => typeof value === 'string')
          .slice(0, 80)
          .map((value) => value.slice(0, 160))
      : [],
    errorMessages: Array.isArray(input.errorMessages)
      ? input.errorMessages
          .filter((value) => typeof value === 'string')
          .slice(0, 40)
          .map((value) => value.slice(0, 300))
      : [],
    buttons: Array.isArray(input.buttons)
      ? input.buttons
          .filter((value) => typeof value === 'string')
          .slice(0, 80)
          .map((value) => value.slice(0, 120))
      : [],
  };
}

async function handleDiagnose(snapshot) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { configured: false, message: '未设置 OPENAI_API_KEY；已保存页面诊断快照。' };
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const response = await fetch(`${base}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: '你是 Poker with Friends 的本地诊断助手。只分析页面可见状态，指出登录、连接或 UI 问题。不要索要密码、cookie、token 或任何隐私信息。用中文简洁回答。',
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: JSON.stringify(snapshot) }],
        },
      ],
      max_output_tokens: 700,
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      configured: true,
      ok: false,
      status: response.status,
      message: '模型诊断请求失败。',
      detail: body?.error?.message || null,
    };
  }
  const output = Array.isArray(body?.output)
    ? body.output
        .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
        .map((item) => item?.text)
        .filter(Boolean)
        .join('\n')
    : '';
  return { configured: true, ok: true, model, diagnosis: output.slice(0, 6000) };
}

const server = http.createServer(async (req, res) => {
  if (!isAllowedRequest(req)) return json(res, 403, { message: '仅允许本地扩展访问诊断桥。' });
  if (req.method === 'OPTIONS') return json(res, 204, null);
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      status: 'ok',
      service: 'chrome-poker-bridge',
      snapshot: Boolean(latestSnapshot),
      apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
    });
  }
  if (req.method === 'GET' && url.pathname === '/snapshot') {
    return json(res, 200, latestSnapshot || { snapshot: null });
  }
  if (req.method === 'POST' && url.pathname === '/snapshot') {
    try {
      const snapshot = sanitizeSnapshot(JSON.parse(await readBody(req)));
      latestSnapshot = snapshot;
      return json(res, 201, { accepted: true, snapshot });
    } catch (error) {
      return json(res, 400, {
        accepted: false,
        message: error instanceof Error ? error.message : 'invalid request',
      });
    }
  }
  if (req.method === 'POST' && url.pathname === '/diagnose') {
    try {
      const snapshot = sanitizeSnapshot(JSON.parse(await readBody(req)));
      latestSnapshot = snapshot;
      return json(res, 200, await handleDiagnose(snapshot));
    } catch (error) {
      return json(res, 400, {
        ok: false,
        message: error instanceof Error ? error.message : 'invalid request',
      });
    }
  }
  return json(res, 404, { message: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`chrome-poker-bridge listening on http://${HOST}:${PORT}`);
});
