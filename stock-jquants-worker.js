// FUJIWARA stock relay v1.0 — Cloudflare Worker, ES module.
// No API key is embedded, saved, cached, or written to logs by this code.
const APP_ORIGIN = 'https://yakamikoujinen-stack.github.io';
const UPSTREAM = 'https://api.jquants.com/v2';
const ENDPOINTS = {
  '/equities/master': new Set(['code', 'date', 'pagination_key']),
  '/fins/summary': new Set(['code', 'pagination_key']),
  '/equities/bars/daily': new Set(['code', 'from', 'to', 'pagination_key'])
};
const version = 'fujiwara-stock-relay-v1';
function cors(origin) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' };
  if (origin === APP_ORIGIN) {
    h['Access-Control-Allow-Origin'] = APP_ORIGIN;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}
function reply(data, status, origin) { return new Response(JSON.stringify(data), { status, headers: cors(origin) }); }
export default {
  async fetch(request) {
    const url = new URL(request.url), origin = request.headers.get('Origin') || '';
    if (url.pathname === '/health' && request.method === 'GET') return reply({ ok: true, service: version }, 200, origin);
    if (url.pathname === '/' && request.method === 'GET') return new Response('FUJIWARA 株式チェック用の中継サーバーが稼働しています。APIキーはここに入力せず、株式アプリに入力してください。', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    if (origin !== APP_ORIGIN) return reply({ message: 'この中継サーバーは指定の株式アプリ専用です。' }, 403, origin);
    const path = url.pathname.startsWith('/api/') ? url.pathname.slice(4) : '';
    if (!ENDPOINTS[path]) return reply({ message: '対応していない取得項目です。' }, 404, origin);
    if (request.method === 'OPTIONS') {
      if (request.headers.get('Access-Control-Request-Method') !== 'POST') return reply({ message: '取得にはPOSTを使用してください。' }, 405, origin);
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (request.method !== 'POST') return reply({ message: '取得にはPOSTを使用してください。' }, 405, origin);
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) return reply({ message: '送信形式を確認してください。' }, 415, origin);
    for (const [name, value] of url.searchParams) {
      if (!ENDPOINTS[path].has(name) || url.searchParams.getAll(name).length !== 1 || value.length > 1500) return reply({ message: '取得条件が不正です。' }, 400, origin);
      if (name === 'code' && !/^[0-9A-Z]{4}0?$/.test(value)) return reply({ message: '銘柄コードが不正です。' }, 400, origin);
      if (['date', 'from', 'to'].includes(name) && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return reply({ message: '日付の形式が不正です。' }, 400, origin);
    }
    if (path !== '/equities/master' && !url.searchParams.has('code')) return reply({ message: '銘柄コードが必要です。' }, 400, origin);
    if (path === '/equities/master' && !url.searchParams.has('date')) return reply({ message: '銘柄一覧の日付が必要です。' }, 400, origin);
    let key;
    try {
      if (Number(request.headers.get('Content-Length') || 0) > 4096) return reply({ message: '送信内容が大きすぎます。' }, 413, origin);
      const text = await request.text();
      if (text.length > 4096) return reply({ message: '送信内容が大きすぎます。' }, 413, origin);
      const body = JSON.parse(text);
      key = body.apiKey;
      if (typeof key !== 'string' || !/^[\x21-\x7e]{8,1024}$/.test(key)) return reply({ message: 'APIキーの入力形式を確認してください。' }, 400, origin);
    } catch { return reply({ message: 'APIキーの入力形式を確認してください。' }, 400, origin); }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 18000);
    let stage = 'fetch';
    try {
      const upstream = await fetch(UPSTREAM + path + url.search, { method: 'GET', headers: { 'x-api-key': key, 'Accept': 'application/json' }, signal: controller.signal, redirect: 'error', cache: 'no-store' });
      if (!upstream.ok) {
        const errors = { 401: 'J-QuantsのAPIキーを確認してください。', 403: 'J-Quantsが取得を拒否しました。APIキー・実際の契約プラン・取得対象日を確認してください。', 429: 'J-Quantsの取得回数上限です。1分ほど待ってください。' };
        return reply({ message: errors[upstream.status] || 'J-Quantsで取得エラーが発生しました。', upstreamStatus: upstream.status }, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502, origin);
      }
      stage = 'json';
      const data = await upstream.json();
      if (!data || !Array.isArray(data.data)) return reply({ message: 'J-Quantsの応答形式を確認できません。' }, 502, origin);
      // Forward only the documented result, never reflect request body or key.
      return reply({ data: data.data, ...(data.pagination_key ? { pagination_key: data.pagination_key } : {}) }, 200, origin);
    } catch (error) {
      const cacheUnsupported = /cache|RequestInit/i.test(String(error?.message || ''));
      const diagnostic = controller.signal.aborted ? 'timeout' : stage === 'json' ? 'invalid_json' : cacheUnsupported ? 'fetch_options' : error?.name === 'TypeError' ? 'fetch_type_error' : 'fetch_failure';
      const messages = {
        timeout: 'J-Quantsへの接続がタイムアウトしました。',
        invalid_json: 'J-Quantsの応答をJSONとして読み取れませんでした。',
        fetch_options: '中継サーバーの通信設定が実行環境に対応していません。',
        fetch_type_error: '中継サーバーの通信処理でエラーが発生しました。',
        fetch_failure: '中継サーバーからJ-Quantsに接続できませんでした。'
      };
      return reply({ message: messages[diagnostic], diagnostic }, 502, origin);
    }
    finally { key = undefined; clearTimeout(timer); }
  }
};
