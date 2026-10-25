'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const PUB = path.join(__dirname, 'public');
const MAX_ROOMS = 200;
const MAX_CLIENTS_PER_ROOM = 200;
const MAX_HISTORY = 50;
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const redisEnabled = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const MT = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };

async function redisCommand(...args) {
  if (!redisEnabled) return null;
  const response = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(3500)
  });
  if (!response.ok) throw new Error(`Upstash HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}
function historyKey(room) { return `syncdark:v2:history:${Buffer.from(room).toString('base64url')}`; }
async function loadHistory(room) {
  if (!redisEnabled) return [];
  try {
    const rows = await redisCommand('LRANGE', historyKey(room), '0', String(MAX_HISTORY - 1));
    return (Array.isArray(rows) ? rows : []).map(v => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean).reverse();
  } catch (e) {
    console.error('Upstash history read failed:', e.message);
    return [];
  }
}
async function persistMessage(room, message) {
  if (!redisEnabled) return;
  try {
    const key = historyKey(room);
    await redisCommand('LPUSH', key, JSON.stringify(message));
    await redisCommand('LTRIM', key, '0', String(MAX_HISTORY - 1));
    await redisCommand('EXPIRE', key, '2592000');
  } catch (e) {
    console.error('Upstash history write failed:', e.message);
  }
}

const srv = http.createServer(async (req, res) => {
  const pathname = (() => { try { return new URL(req.url, 'http://localhost').pathname; } catch { return ''; } })();
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type':'text/plain; charset=utf-8', 'Cache-Control':'no-store' }).end('ok'); return; }
  if (pathname === '/api/status') {
    const status = {
      ok: true,
      persistence: redisEnabled ? 'upstash-unavailable' : 'memory-only',
      redisConfigured: redisEnabled,
      redisConnected: false,
      historyLimit: MAX_HISTORY,
      historyTtlDays: 30,
      encryption: 'client-side-optional'
    };
    if (redisEnabled) {
      try {
        const pong = await redisCommand('PING');
        status.redisConnected = pong === 'PONG';
        status.persistence = status.redisConnected ? 'upstash-redis' : 'upstash-unavailable';
      } catch (e) {
        console.error('Upstash status check failed:', e.message);
      }
    }
    const body = JSON.stringify(status);
    res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' }).end(body); return;
  }
  let p; try { p = decodeURIComponent(pathname); } catch { res.writeHead(400).end('bad request'); return; }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.resolve(PUB, '.' + p);
  if (f !== PUB && !f.startsWith(PUB + path.sep)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404, { 'Content-Type':'text/plain; charset=utf-8' }).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type':MT[path.extname(f)] || 'application/octet-stream',
      'X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'no-referrer',
      'X-Frame-Options':'DENY',
      'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
      'Cache-Control':p === '/sw.js' || p === '/index.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(d);
  });
});

const wss = new WebSocketServer({ server:srv, maxPayload:16 * 1024, perMessageDeflate:false });
const rooms = new Map();
const send = (ws, obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
const users = room => [...room.clients].map(c => c.name);
const bcast = (room, obj) => { const s = JSON.stringify(obj); room.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(s); }); };
function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients.delete(ws); ws.room = null;
  if (room.clients.size) bcast(room, { t:'users', list:users(room) });
  else setTimeout(() => { if (!room.clients.size && rooms.get(room.id) === room) rooms.delete(room.id); }, 600000).unref?.();
}
function allowHit(ws, bucket, limit, windowMs) {
  const now = Date.now();
  ws[bucket] = (ws[bucket] || []).filter(t => now - t < windowMs);
  if (ws[bucket].length >= limit) return false;
  ws[bucket].push(now); return true;
}

wss.on('connection', ws => {
  ws.alive = true; ws.joinHits = []; ws.msgHits = [];
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return send(ws, { t:'err', x:'消息格式无效' }); }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') {
      if (!allowHit(ws, 'joinHits', 5, 60000)) return send(ws, { t:'err', x:'加入房间过于频繁，请稍后再试' });
      const roomId = String(m.room || '').trim().slice(0, 30);
      const name = String(m.name || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 20);
      const cid = String(m.cid || '').replace(/[^\w-]/g, '').slice(0, 24);
      if (!/^[\w\-\u4e00-\u9fa5]{1,30}$/.test(roomId) || !name) return send(ws, { t:'err', x:'房间名或昵称不合法' });
      leave(ws);
      let room = rooms.get(roomId);
      if (!room) {
        if (rooms.size >= MAX_ROOMS) return send(ws, { t:'err', x:'服务器房间数已满' });
        room = { id:roomId, clients:new Set(), hist:[], loading:null };
        room.loading = loadHistory(roomId).then(hist => { room.hist = hist.slice(-MAX_HISTORY); });
        rooms.set(roomId, room);
      }
      await room.loading;
      if (ws.readyState !== WebSocket.OPEN) return;
      if (room.clients.size >= MAX_CLIENTS_PER_ROOM) return send(ws, { t:'err', x:'房间已满' });
      ws.room = room; ws.name = name; ws.cid = cid; room.clients.add(ws);
      send(ws, { t:'hist', m:room.hist });
      bcast(room, { t:'users', list:users(room) });
      return;
    }
    if (m.t === 'msg') {
      if (!ws.room) return send(ws, { t:'err', x:'请先加入房间' });
      if (!allowHit(ws, 'msgHits', 10, 5000)) return send(ws, { t:'err', x:'发送太快，请稍后再试' });
      const x = typeof m.x === 'string' ? m.x.slice(0, 4000) : '';
      if (!x.trim()) return;
      const room = ws.room;
      const msg = { t:'msg', id:cryptoRandomId(), n:ws.name, c:ws.cid, x, e:m.e ? 1 : 0, ts:Date.now() };
      room.hist.push(msg); if (room.hist.length > MAX_HISTORY) room.hist.shift();
      bcast(room, msg);
      await persistMessage(room.id, msg);
    }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});
function cryptoRandomId() { return require('crypto').randomBytes(9).toString('base64url'); }
const heartbeat = setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 30000);
heartbeat.unref();
srv.listen(PORT, '0.0.0.0', () => {
  console.log(`暗域 · SYNC listening on port ${PORT}`);
  console.log(redisEnabled ? 'Persistent history: Upstash Redis configured (check /api/status for connectivity)' : 'Persistent history: memory only (set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to enable persistence)');
});
