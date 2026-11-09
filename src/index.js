// 아몰랑아일랜드 실시간 서버 — Cloudflare Worker + Durable Object (WebSocket Hibernation)
// 섬(방) 하나당 정원 CAP명. 꽉 차면 클라이언트가 다음 섬 번호로 자동 이동한다.
import { DurableObject } from 'cloudflare:workers';

const CAP = 40;          // 섬 하나 정원
const MAX_ISLANDS = 30;  // 섬 개수 상한
const MAX_MSG = 2048;    // 메시지 최대 크기(바이트)
const MAX_RATE = 20;     // 접속자 1명당 초당 최대 메시지 수

// 클라이언트와 같은 목록 (자유 텍스트는 받지 않는다 — 이름도 단어 번호로만 주고받음)
const EMOJI = new Set(["👋", "🙇", "🙏", "🤝", "✌️", "🫡", "🙌", "👀", "😊", "😆", "🥹", "😌", "😴", "🤔", "😮", "😭", "😤", "🥶", "🫠", "😎", "🤣", "😇", "🥳", "😑", "👍", "👏", "🔥", "💪", "🎉", "✨", "❤️", "💯", "🎣", "🐟", "🐠", "🐡", "🦑", "🦀", "🐙", "🦈", "🐳", "🌊", "⚓", "🪝", "☕", "🍜", "🍙", "🍎", "🍊", "🍑", "🌸", "🌳", "🏕️", "🔥", "🌙", "⭐", "🌧️", "🍀", "🦋", "🐚"]);
const SPECIES = new Set(["goby", "halfbeak", "jack", "mackerel", "rockfish", "greenling", "schlegeli", "porgy", "bass", "flounder", "starfish", "chub", "crucian", "loach", "carp", "catfish", "mandarin", "goldfish", "filefish", "puffer", "redbream", "oplegnathus", "hairtail", "mullet", "dodari", "stingray", "moray", "tuna", "sunfish", "octopus", "squid", "webfoot", "seahorse", "bluecrab", "snowcrab", "prawn", "spinylobster", "jellyfish", "urchin", "catshark", "blueshark", "hammerhead", "whaleshark", "clownfish", "bluetang", "emperorangel", "butterfly", "mandarinfish", "lionfish", "parrotfish", "boxfish", "medaka", "minnow", "kkeokji", "sweetfish", "masu", "snakehead", "eel", "crayfish", "freshshrimp", "turtle", "koi", "guppy", "betta", "arowana"]);
const N_ADJ = 40, N_NOUN = 40;
const STATES = new Set(['idle', 'cast', 'wait', 'bite', 'fight']);

const num = (v, a, b, d) => { v = +v; return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
const r2 = v => Math.round(v * 100) / 100;
const idx = (v, mod) => Math.abs(v | 0) % mod;
const arr = (x, k) => (Array.isArray(x) && x.length === k ? x : null);

// 받은 상태값을 알려진 필드·범위로만 다시 만든다 (악성 입력 차단)
function sanitize(d) {
  if (!d || typeof d !== 'object') return null;
  const p = arr(d.p, 4); if (!p) return null;
  const n = arr(d.n, 2) || [0, 0], lk = arr(d.lk, 4) || [0, 0, 0, 0], f = arr(d.f, 2) || [0, 0];
  return {
    v: 3,
    n: [idx(n[0], N_ADJ), idx(n[1], N_NOUN)],
    lk: [idx(lk[0], 7), idx(lk[1], 12), idx(lk[2], 5), idx(lk[3], 12)],
    p: [r2(num(p[0], -120, 120, 0)), r2(num(p[1], -120, 120, 0)), r2(num(p[2], -50, 50, 0)), r2(num(p[3], 0, 3, 0))],
    m: d.m === 1 ? 1 : 0,
    st: STATES.has(d.st) ? d.st : 'idle',
    f: [r2(num(f[0], -200, 200, 0)), r2(num(f[1], -200, 200, 0))],
    fd: r2(num(d.fd, 0, 1, 1)), ft: r2(num(d.ft, 0, 1, 0)), cd: r2(num(d.cd, 1, 40, 10)),
    eid: idx(d.eid, 1e9), e: EMOJI.has(d.e) ? d.e : '',
    cid: idx(d.cid, 1e9), cs: SPECIES.has(d.cs) ? d.cs : '', cz: r2(num(d.cz, 0, 1000, 0)),
    j: num(d.j, 0, 1e13, 0),
    ai: idx(d.ai, 16), ak: d.ak === 1 ? 1 : 0, an: idx(d.an, 1e9),
  };
}

export class Island extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // 'ping' → 'pong' 자동 응답: 객체를 깨우지 않아 비용이 들지 않는다
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const live = this.ctx.getWebSockets().filter(w => { const a = w.deserializeAttachment(); return a && !a.full; });
    const { 0: client, 1: server } = new WebSocketPair();
    if (live.length >= CAP) {
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ full: true });
      server.send(JSON.stringify({ t: 'full' }));
      server.close(4001, 'full');
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    server.serializeAttachment({ id, p: null, sec: 0, cnt: 0 });
    const peers = [];
    for (const w of live) { const a = w.deserializeAttachment(); if (a && a.p) peers.push({ id: a.id, p: a.p }); }
    server.send(JSON.stringify({ t: 'welcome', id, peers, cap: CAP }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > MAX_MSG) return;
    const a = ws.deserializeAttachment();
    if (!a || a.full) return;
    const sec = Math.floor(Date.now() / 1000);
    if (a.sec !== sec) { a.sec = sec; a.cnt = 0; }
    if (++a.cnt > MAX_RATE) { ws.serializeAttachment(a); return; }
    let m; try { m = JSON.parse(msg); } catch { return; }
    if (m && m.t === 'p') {
      const p = sanitize(m.d);
      if (!p) { ws.serializeAttachment(a); return; }
      a.p = p; ws.serializeAttachment(a);
      this.broadcast({ t: 'p', id: a.id, p }, ws);
    } else ws.serializeAttachment(a);
  }

  webSocketClose(ws, code) { this.leave(ws); try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch {} }
  webSocketError(ws) { this.leave(ws); }

  leave(ws) {
    const a = ws.deserializeAttachment();
    if (a && a.id && !a.gone) { a.gone = true; try { ws.serializeAttachment(a); } catch {} this.broadcast({ t: 'leave', id: a.id }, ws); }
  }

  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const w of this.ctx.getWebSockets()) {
      if (w === except) continue;
      const a = w.deserializeAttachment();
      if (!a || a.full || a.gone) continue;
      try { w.send(s); } catch {}
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/hello') {
      return Response.json({ monggeul: true, cap: CAP }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/ws') {
      let n = parseInt(url.searchParams.get('island') || '1', 10);
      if (!Number.isInteger(n) || n < 1 || n > MAX_ISLANDS) n = 1;
      const stub = env.ISLAND.get(env.ISLAND.idFromName('island-' + n));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
