// 아몰랑아일랜드 실시간 서버 — Cloudflare Worker + Durable Object (WebSocket Hibernation)
// - Island: 섬(방) 하나당 정원 CAP명. 상태 중계 + 채팅(최근 50개만 보관) + 수조 구경 요청 중계
// - Vault : 아이디/비밀번호 계정과 저장 데이터 (전체 섬 공용, 인스턴스 1개)
import { DurableObject } from 'cloudflare:workers';

const CAP = 40;          // 섬 하나 정원
const MAX_ISLANDS = 30;  // 섬 개수 상한
const MAX_MSG = 4096;    // 메시지 최대 크기(바이트)
const MAX_RATE = 20;     // 접속자 1명당 초당 최대 메시지 수
const CHAT_KEEP = 50;    // 섬마다 보관하는 최근 채팅 수 (넘으면 오래된 것부터 삭제)
const CHAT_LEN = 60;     // 채팅 한 줄 최대 글자 수
const CHAT_GAP = 1500;   // 같은 사람이 채팅을 보낼 수 있는 최소 간격(ms)

const EMOJI = new Set(["👋", "🙇", "🙏", "🤝", "✌️", "🫡", "🙌", "👀", "😊", "😆", "🥹", "😌", "😴", "🤔", "😮", "😭", "😤", "🥶", "🫠", "😎", "🤣", "😇", "🥳", "😑", "👍", "👏", "🔥", "💪", "🎉", "✨", "❤️", "💯", "🎣", "🐟", "🐠", "🐡", "🦑", "🦀", "🐙", "🦈", "🐳", "🌊", "⚓", "🪝", "☕", "🍜", "🍙", "🍎", "🍊", "🍑", "🌸", "🌳", "🏕️", "🔥", "🌙", "⭐", "🌧️", "🍀", "🦋", "🐚", "😋"]);
const SPECIES_LIST = ["goby", "halfbeak", "jack", "mackerel", "rockfish", "greenling", "schlegeli", "porgy", "bass", "flounder", "starfish", "chub", "crucian", "loach", "carp", "catfish", "mandarin", "goldfish", "filefish", "puffer", "redbream", "oplegnathus", "hairtail", "mullet", "dodari", "stingray", "moray", "tuna", "sunfish", "octopus", "squid", "webfoot", "seahorse", "bluecrab", "snowcrab", "prawn", "spinylobster", "jellyfish", "urchin", "catshark", "blueshark", "hammerhead", "whaleshark", "clownfish", "bluetang", "emperorangel", "butterfly", "mandarinfish", "lionfish", "parrotfish", "boxfish", "medaka", "minnow", "kkeokji", "sweetfish", "masu", "snakehead", "eel", "crayfish", "freshshrimp", "turtle", "koi", "guppy", "betta", "arowana", "seal", "dolphin", "orca", "seaotter", "otter", "anchovy", "bekasquid", "hermitcrab", "seacucumber", "sandlance", "shorecrab", "bitterling", "topmouth", "gizzardshad", "yellowcroaker", "saury", "herring", "flatfish", "wrasse", "sillago", "damsel", "darkchub", "sandgudgeon", "monkfish", "scorpionfish", "spanishmack", "croaker", "cuttlefish", "conger", "gurnard", "yellowtang", "bagrid", "skygager", "amberjack", "yellowtail", "kobudai", "bigfinsquid", "hairycrab", "sevenband", "lobster", "moorishidol", "triggerfish", "leopardshark", "lenok", "stickleback", "giantgrouper", "marlin", "swordfish", "sailfish", "kingcrab", "giantoctopus", "dumbo", "vampiresquid", "opah", "tigershark", "greatwhite", "thresher", "footballfish", "napoleon", "chimaera", "giantmoray", "sturgeon", "giantcatfish", "mutae", "goldkoi", "humpback", "bluewhale", "spermwhale", "beluga", "narwhal", "sealion", "walrus", "dugong", "manatee", "leatherback", "greenturtle", "giantsquid", "oarfish", "coelacanth", "mantaray", "leafyseadragon", "goldmandarin", "eoreumchi", "arapaima", "mihojonggae", "rainbowwhale", "auroraray", "rainbowflyer", "prismjelly", "rainbowseahorse", "chaeunryong", "chilbokoi", "rainbowtrout"];
// 생물별 최대 크기(cm): 명예의 전당 기록 검증용
const SPECIES_MAX = {"goby": 24.0, "halfbeak": 35.0, "jack": 30.0, "mackerel": 38.0, "rockfish": 28.0, "greenling": 35.0, "schlegeli": 45.0, "porgy": 55.0, "bass": 80.0, "flounder": 80.0, "starfish": 20.0, "chub": 16.0, "crucian": 32.0, "loach": 18.0, "carp": 80.0, "catfish": 70.0, "mandarin": 45.0, "goldfish": 16.0, "filefish": 30.0, "puffer": 40.0, "redbream": 80.0, "oplegnathus": 60.0, "hairtail": 150.0, "mullet": 60.0, "dodari": 35.0, "stingray": 120.0, "moray": 120.0, "tuna": 250.0, "sunfish": 300.0, "octopus": 90.0, "squid": 45.0, "webfoot": 20.0, "seahorse": 18.0, "bluecrab": 25.0, "snowcrab": 40.0, "prawn": 25.0, "spinylobster": 40.0, "jellyfish": 35.0, "urchin": 12.0, "catshark": 60.0, "blueshark": 300.0, "hammerhead": 400.0, "whaleshark": 900.0, "clownfish": 11.0, "bluetang": 30.0, "emperorangel": 40.0, "butterfly": 20.0, "mandarinfish": 8.0, "lionfish": 35.0, "parrotfish": 60.0, "boxfish": 20.0, "medaka": 4.0, "minnow": 15.0, "kkeokji": 20.0, "sweetfish": 28.0, "masu": 40.0, "snakehead": 90.0, "eel": 90.0, "crayfish": 12.0, "freshshrimp": 4.0, "turtle": 30.0, "koi": 80.0, "guppy": 6.0, "betta": 7.0, "arowana": 100.0, "seal": 200.0, "dolphin": 260.0, "orca": 300.0, "seaotter": 145.0, "otter": 120.0, "anchovy": 14.0, "bekasquid": 15.0, "hermitcrab": 8.0, "seacucumber": 30.0, "sandlance": 18.0, "shorecrab": 6.0, "bitterling": 9.0, "topmouth": 12.0, "gizzardshad": 30.0, "yellowcroaker": 30.0, "saury": 35.0, "herring": 35.0, "flatfish": 35.0, "wrasse": 25.0, "sillago": 30.0, "damsel": 12.0, "darkchub": 20.0, "sandgudgeon": 25.0, "monkfish": 100.0, "scorpionfish": 30.0, "spanishmack": 100.0, "croaker": 90.0, "cuttlefish": 35.0, "conger": 100.0, "gurnard": 40.0, "yellowtang": 20.0, "bagrid": 30.0, "skygager": 80.0, "amberjack": 130.0, "yellowtail": 100.0, "kobudai": 90.0, "bigfinsquid": 50.0, "hairycrab": 15.0, "sevenband": 80.0, "lobster": 50.0, "moorishidol": 25.0, "triggerfish": 30.0, "leopardshark": 180.0, "lenok": 70.0, "stickleback": 8.0, "giantgrouper": 250.0, "marlin": 400.0, "swordfish": 350.0, "sailfish": 300.0, "kingcrab": 80.0, "giantoctopus": 300.0, "dumbo": 30.0, "vampiresquid": 30.0, "opah": 180.0, "tigershark": 450.0, "greatwhite": 550.0, "thresher": 450.0, "footballfish": 60.0, "napoleon": 200.0, "chimaera": 120.0, "giantmoray": 300.0, "sturgeon": 250.0, "giantcatfish": 250.0, "mutae": 200.0, "goldkoi": 90.0, "humpback": 700.0, "bluewhale": 950.0, "spermwhale": 600.0, "beluga": 450.0, "narwhal": 500.0, "sealion": 250.0, "walrus": 350.0, "dugong": 320.0, "manatee": 380.0, "leatherback": 200.0, "greenturtle": 130.0, "giantsquid": 950.0, "oarfish": 800.0, "coelacanth": 200.0, "mantaray": 600.0, "leafyseadragon": 35.0, "goldmandarin": 50.0, "eoreumchi": 45.0, "arapaima": 300.0, "mihojonggae": 10.0, "rainbowwhale": 950.0, "auroraray": 450.0, "rainbowflyer": 60.0, "prismjelly": 90.0, "rainbowseahorse": 35.0, "chaeunryong": 900.0, "chilbokoi": 120.0, "rainbowtrout": 110.0};
const SPECIES = new Set(SPECIES_LIST);
const N_ADJ = 40, N_NOUN = 40;
const STATES = new Set(['idle', 'cast', 'wait', 'bite', 'fight']);

const num = (v, a, b, d) => { v = +v; return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
const r2 = v => Math.round(v * 100) / 100;
const idx = (v, mod) => Math.abs(v | 0) % mod;
const arr = (x, k) => (Array.isArray(x) && x.length === k ? x : null);

// ---------- 채팅 필터 (욕설·연락처·링크 가리기) ----------
const BAD = ['씨발', '시발', '씨빨', '시빨', 'ㅅㅂ', 'ㅆㅂ', '병신', '븅신', 'ㅂㅅ', '개새끼', '개새', '새끼', '좆', '존나', '졸라', 'ㅈㄴ', '지랄', 'ㅈㄹ', '미친놈', '미친년', '닥쳐', '꺼져', '애미', '에미', '느금', '니미', '엠창', '섹스', '야동', '자살', 'fuck', 'shit', 'bitch', 'sex', 'porn'];
function maskText(s) {
  // 링크·도메인
  s = s.replace(/(https?:\/\/|www\.)\S*/gi, '(링크)').replace(/\b[\w-]+\.(com|net|org|kr|co|io|me|gg|xyz|ly|link|site|shop)\b\S*/gi, '(링크)');
  // 전화번호·긴 숫자
  s = s.replace(/\d[\d .-]{7,}\d/g, '(숫자)');
  // 욕설 (띄어쓰기·기호를 끼워 넣은 경우도 잡는다)
  for (const w of BAD) {
    const re = new RegExp(Array.from(w).map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s._\\-~*!0-9]*'), 'gi');
    if (re.test(s)) s = s.replace(re, m => '♡'.repeat(Math.min(4, Array.from(m).length)));
  }
  return s;
}
function cleanChat(s) {
  s = String(s ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064]/g, '').replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, CHAT_LEN).join('');
  return s ? maskText(s) : '';
}
const BOARD_LEN = 200, BOARD_KEEP = 300;
function cleanBoard(s) {
  s = String(s ?? '').replace(/\r/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064]/g, '')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  s = Array.from(s).slice(0, BOARD_LEN).join('');
  return s ? maskText(s) : '';
}

// 직접 정한 닉네임 검사 (2~10자, 한글·영문·숫자·띄어쓰기·_, 금지어 없음). 통과 못 하면 '' → 랜덤 이름으로 보인다
const NICK_BAN = ['용왕', '운영자', '관리자', '운영진', 'admin', 'gm', 'system', '시스템', 'claude'];
function cleanNick(v) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064]/g, '').replace(/\s+/g, ' ').trim();
  const len = Array.from(s).length;
  if (len < 2 || len > 10 || !/^[가-힣a-zA-Z0-9 _]+$/.test(s)) return '';
  const low = s.toLowerCase().replace(/[\s_]/g, '');
  if (NICK_BAN.some(w => low.includes(w))) return '';
  if (cleanChat(s) !== s) return '';
  return s;
}

// 받은 상태값을 알려진 필드·범위로만 다시 만든다 (악성 입력 차단)
function sanitize(d) {
  if (!d || typeof d !== 'object') return null;
  const p = arr(d.p, 4); if (!p) return null;
  const n = arr(d.n, 2) || [0, 0], lk = arr(d.lk, 4) || [0, 0, 0, 0], f = arr(d.f, 2) || [0, 0];
  const ck = arr(d.ck, 5);
  return {
    v: 3,
    n: [idx(n[0], N_ADJ), idx(n[1], N_NOUN)],
    nk: cleanNick(d.nk),
    lk: [idx(lk[0], 7), idx(lk[1], 12), idx(lk[2], 5), idx(lk[3], 12)],
    p: [r2(num(p[0], -120, 120, 0)), r2(num(p[1], -120, 120, 0)), r2(num(p[2], -50, 50, 0)), r2(num(p[3], 0, 3, 0))],
    m: d.m === 1 ? 1 : 0,
    st: STATES.has(d.st) ? d.st : 'idle',
    f: [r2(num(f[0], -200, 200, 0)), r2(num(f[1], -200, 200, 0))],
    fd: r2(num(d.fd, 0, 1, 1)), ft: r2(num(d.ft, 0, 1, 0)), cd: r2(num(d.cd, 1, 40, 10)),
    eid: idx(d.eid, 1e9), e: EMOJI.has(d.e) ? d.e : '',
    cid: idx(d.cid, 1e9), cs: SPECIES.has(d.cs) ? d.cs : '', cz: r2(num(d.cz, 0, 1000, 0)),
    j: num(d.j, 0, 1e13, 0),
    ai: idx(d.ai, 32), ak: d.ak === 1 ? 1 : 0, an: idx(d.an, 1e9),
    lv: Array.isArray(d.lv) ? d.lv.slice(0, 5).filter(e => Array.isArray(e) && e.length === 2).map(e => [idx(e[0], 32), Math.floor(num(e[1], 0, 1e6, 0))]) : [],
    rd: num(d.rd | 0, 1, 7, 1),
    bt: d.bt === 1 ? 1 : 0,
    sd: typeof d.sd === 'string' && /^[a-z0-9]{6,16}$/.test(d.sd) ? d.sd : '',
    ck: ck ? [idx(ck[0], 3), idx(ck[1], 40), r2(num(ck[2], -120, 120, 0)), r2(num(ck[3], -120, 120, 0)), r2(num(ck[4], -50, 50, 0))] : [0, 0, 0, 0, 0],
  };
}
// 수조 자랑용 프로필
function sanitizeProfile(d) {
  if (!d || typeof d !== 'object') return null;
  const k = Array.isArray(d.k) ? d.k.slice(0, 50) : [];
  return {
    r: num(d.r | 0, 1, 7, 1),
    k: k.filter(x => Array.isArray(x) && x.length === 2).map(x => [idx(x[0], SPECIES_LIST.length), r2(num(x[1], 0.5, 1000, 10))]),
    m: num(d.m | 0, 0, 1e9, 0),
    b: num(d.b | 0, 0, 200, 0),
  };
}

export class Island extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // 'ping' → 'pong' 자동 응답: 객체를 깨우지 않아 비용이 들지 않는다
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS chat2(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, a INTEGER, b INTEGER, nk TEXT, m TEXT)');
    this.sql.exec('DROP TABLE IF EXISTS chat'); // 예전 형식 채팅 표는 정리
  }

  recentChat() {
    return this.sql.exec('SELECT ts, a, b, nk, m FROM chat2 ORDER BY id DESC LIMIT ?', CHAT_KEEP).toArray().reverse()
      .map(r => ({ ts: r.ts, n: [r.a, r.b], nk: r.nk || '', m: r.m }));
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    this.lastPrune = 0; this.prune();
    const live = this.ctx.getWebSockets().filter(w => { const a = w.deserializeAttachment(); return a && !a.full && !a.gone; });
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
    server.serializeAttachment({ id, p: null, sec: 0, cnt: 0, lc: 0, t0: Date.now() });
    const peers = [];
    for (const w of live) { const a = w.deserializeAttachment(); if (a && a.p) peers.push({ id: a.id, p: a.p }); }
    server.send(JSON.stringify({ t: 'welcome', id, peers, cap: CAP, chat: this.recentChat() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > MAX_MSG) return;
    const a = ws.deserializeAttachment();
    if (!a || a.full) return;
    const sec = Math.floor(Date.now() / 1000);
    if (a.sec !== sec) { a.sec = sec; a.cnt = 0; }
    if (++a.cnt > MAX_RATE) { ws.serializeAttachment(a); return; }
    let m; try { m = JSON.parse(msg); } catch { ws.serializeAttachment(a); return; }
    if (!m || typeof m !== 'object') { ws.serializeAttachment(a); return; }
    if (m.t === 'p') {
      const p = sanitize(m.d);
      if (p) {
        // 같은 화면(sd)이 다시 연결됐다면, 남아 있던 예전 연결(유령)을 정리
        if (p.sd && a.sd !== p.sd) {
          a.sd = p.sd;
          for (const w of this.ctx.getWebSockets()) {
            if (w === ws) continue;
            const b = w.deserializeAttachment();
            if (b && !b.full && !b.gone && b.p && b.p.sd === p.sd) { this.leave(w); try { w.close(4002, 'replaced'); } catch {} }
          }
        }
        a.p = p; a.la = Date.now(); ws.serializeAttachment(a); this.broadcast({ t: 'p', id: a.id, p }, ws); this.prune(); return;
      }
    } else if (m.t === 'c') {
      const now = Date.now();
      const text = cleanChat(m.m);
      if (text && a.p && now - (a.lc || 0) >= CHAT_GAP) {
        a.lc = now; ws.serializeAttachment(a);
        const n = a.p.n, nk = a.p.nk || '';
        this.sql.exec('INSERT INTO chat2(ts, a, b, nk, m) VALUES (?, ?, ?, ?, ?)', now, n[0], n[1], nk, text);
        this.sql.exec('DELETE FROM chat2 WHERE id NOT IN (SELECT id FROM chat2 ORDER BY id DESC LIMIT ?)', CHAT_KEEP);
        this.broadcast({ t: 'c', id: a.id, n, nk, m: text, ts: now }, null);
        return;
      }
    } else if (m.t === 'gp' && typeof m.id === 'string') {
      // 다른 사람의 수조를 보고 싶다는 요청 → 그 사람에게 전달
      const target = this.findWs(m.id);
      if (target) { try { target.send(JSON.stringify({ t: 'gp', from: a.id })); } catch {} }
    } else if (m.t === 'pf' && typeof m.to === 'string') {
      const target = this.findWs(m.to);
      const d = sanitizeProfile(m.d);
      if (target && d) { try { target.send(JSON.stringify({ t: 'pf', id: a.id, d })); } catch {} }
    }
    ws.serializeAttachment(a);
  }

  findWs(id) {
    for (const w of this.ctx.getWebSockets()) { const a = w.deserializeAttachment(); if (a && a.id === id && !a.full && !a.gone) return w; }
    return null;
  }

  webSocketClose(ws, code) { this.leave(ws); try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch {} }
  webSocketError(ws) { this.leave(ws); }

  // 응답이 끊긴 지 오래된 연결(앱 전환·네트워크 끊김으로 닫힘 신호를 못 받은 경우)을 정리
  prune() {
    if (typeof this.ctx.getWebSocketAutoResponseTimestamp !== 'function') return; // 지원 안 되면 정리하지 않음(안전)
    const now = Date.now();
    if (now - (this.lastPrune || 0) < 20000) return;
    this.lastPrune = now;
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment();
      if (!a || a.full || a.gone) continue;
      let last = a.la || a.t0 || 0;
      try { const ar = this.ctx.getWebSocketAutoResponseTimestamp(w); if (ar) last = Math.max(last, ar.getTime()); } catch {}
      if (last && now - last > 180000) { this.leave(w); try { w.close(4003, 'stale'); } catch {} }
    }
  }

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

// ---------- 계정 / 저장 ----------
const ID_RE = /^[a-z0-9가-힣_]{3,12}$/;
const PW_MIN = 4, PW_MAX = 40;
const SAVE_MAX = 60000;            // 저장 데이터 최대 크기(바이트)
const SESSION_DAYS = 60;
const PBKDF2_ITER = 50000;
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
async function hashPw(pw, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256));
}
function sameStr(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const J = (obj, status = 200) => Response.json(obj, { status, headers: { 'cache-control': 'no-store' } });

export class Vault extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, salt TEXT, hash TEXT, data TEXT, created INTEGER, updated INTEGER, fails INTEGER DEFAULT 0, lock_until INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, id TEXT, exp INTEGER);`);
    this.regByIp = new Map();
    this.sql.exec('CREATE TABLE IF NOT EXISTS hof(id TEXT PRIMARY KEY, s REAL, n TEXT, ts INTEGER, ip TEXT)');
    this.hofByIp = new Map();
    this.sql.exec('CREATE TABLE IF NOT EXISTS collectors(k TEXT PRIMARY KEY, n TEXT, c INTEGER, ts INTEGER, ip TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS board(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, name TEXT, text TEXT, dk TEXT, ip TEXT)');
  }
  newSession(id) {
    const token = randHex(24), exp = Date.now() + SESSION_DAYS * 864e5;
    this.sql.exec('INSERT INTO sessions(token, id, exp) VALUES (?, ?, ?)', token, id, exp);
    return token;
  }
  who(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{48}$/.test(token)) return null;
    const r = this.sql.exec('SELECT id, exp FROM sessions WHERE token = ?', token).toArray()[0];
    if (!r || r.exp < Date.now()) return null;
    return r.id;
  }
  colTop() { return this.sql.exec('SELECT n, MAX(c) AS c, MIN(ts) AS ts FROM collectors GROUP BY n ORDER BY c DESC, ts ASC LIMIT 5').toArray(); }
  async fetch(request) {
    const url = new URL(request.url);
    const op = url.pathname.split('/').pop();
    let body = {};
    try { const text = await request.text(); if (text.length > SAVE_MAX + 2000) return J({ error: '데이터가 너무 커요' }, 413); body = text ? JSON.parse(text) : {}; } catch { return J({ error: '잘못된 요청' }, 400); }
    const now = Date.now();
    const ip = request.headers.get('x-ip') || '';

    if (op === 'hof-list') {
      const list = this.sql.exec('SELECT id, s, n, ts FROM hof').toArray();
      return J({ ok: true, list, top: this.colTop() });
    }
    if (op === 'hof-submit') {
      const id = String(body.id || '');
      const mx = SPECIES_MAX[id];
      if (!mx) return J({ error: '알 수 없는 생물이에요' }, 400);
      const sz = Math.round(Number(body.s) * 10) / 10;
      if (!Number.isFinite(sz) || sz <= 0 || sz > mx + 0.05) return J({ error: '크기가 이상해요' }, 400);
      const ipKey = ip.slice(0, 64);
      const list = (this.hofByIp.get(ipKey) || []).filter(x => now - x < 60e3);
      if (list.length >= 30) return J({ error: '잠시 후 다시 시도해 주세요' }, 429);
      list.push(now); this.hofByIp.set(ipKey, list);
      const name = cleanNick(body.name) || '익명의 낚시꾼';
      const row = this.sql.exec('SELECT s, n, ts FROM hof WHERE id = ?', id).toArray()[0];
      if (row && row.s >= sz) return J({ ok: true, top: false, rec: { s: row.s, n: row.n, ts: row.ts } });
      this.sql.exec('INSERT OR REPLACE INTO hof(id, s, n, ts, ip) VALUES (?, ?, ?, ?, ?)', id, sz, name, now, ipKey);
      return J({ ok: true, top: true, name, prev: row ? { s: row.s, n: row.n } : null });
    }
    if (op === 'hof-collect') {
      // 도감왕: 도감에 등록한 생물 종류 수. 계정(a_아이디)은 로그인 토큰이 맞아야만 기록
      const k = String(body.key || '');
      if (!/^(a_[a-z0-9가-힣_]{3,12}|g_[a-z0-9]{12,20})$/.test(k)) return J({ error: '잘못된 요청' }, 400);
      if (k.startsWith('a_') && this.who(body.token) !== k.slice(2)) return J({ error: '다시 로그인해 주세요' }, 401);
      const c = Math.floor(Number(body.c));
      if (!Number.isFinite(c) || c < 1 || c > SPECIES_LIST.length) return J({ error: '잘못된 숫자' }, 400);
      const ipKey = ip.slice(0, 64);
      const lst = (this.hofByIp.get(ipKey) || []).filter(x => now - x < 60e3);
      if (lst.length >= 30) return J({ error: '잠시 후 다시 시도해 주세요' }, 429);
      lst.push(now); this.hofByIp.set(ipKey, lst);
      const name = cleanNick(body.name) || '익명의 낚시꾼';
      const row = this.sql.exec('SELECT c FROM collectors WHERE k = ?', k).toArray()[0];
      if (!row) this.sql.exec('INSERT INTO collectors(k, n, c, ts, ip) VALUES (?, ?, ?, ?, ?)', k, name, c, now, ipKey);
      else if (c > row.c) this.sql.exec('UPDATE collectors SET n = ?, c = ?, ts = ?, ip = ? WHERE k = ?', name, c, now, ipKey, k);
      else this.sql.exec('UPDATE collectors SET n = ? WHERE k = ?', name, k);
      return J({ ok: true, top: this.colTop() });
    }
    if (op === 'board-list') {
      const rows = this.sql.exec('SELECT id, ts, name, text FROM board ORDER BY id DESC LIMIT 100').toArray();
      const total = this.sql.exec('SELECT COUNT(*) AS n FROM board').toArray()[0].n;
      return J({ ok: true, posts: rows, total });
    }
    if (op === 'board-post') {
      const text = cleanBoard(body.text);
      if (Array.from(text).length < 2) return J({ error: '두 글자 이상 적어 주세요' }, 400);
      const name = cleanNick(body.name) || '익명의 낚시꾼';
      const ipKey = ip.slice(0, 64);
      const last = this.sql.exec('SELECT MAX(ts) AS t, COUNT(*) AS n FROM board WHERE ip = ? AND ts > ?', ipKey, now - 86400e3).toArray()[0];
      if (last && last.t && now - last.t < 20e3) return J({ error: '조금 천천히 남겨 주세요 (20초에 1개)' }, 429);
      if (last && last.n >= 30) return J({ error: '오늘은 글을 많이 남겼어요. 내일 다시 남겨 주세요' }, 429);
      const dk = randHex(12);
      this.sql.exec('INSERT INTO board(ts, name, text, dk, ip) VALUES (?, ?, ?, ?, ?)', now, name, text, dk, ip.slice(0, 64));
      this.sql.exec('DELETE FROM board WHERE id NOT IN (SELECT id FROM board ORDER BY id DESC LIMIT ?)', BOARD_KEEP);
      const id = this.sql.exec('SELECT last_insert_rowid() AS id').toArray()[0].id;
      return J({ ok: true, post: { id, ts: now, name, text }, dk });
    }
    if (op === 'board-del') {
      const id = body.id | 0;
      const row = this.sql.exec('SELECT dk FROM board WHERE id = ?', id).toArray()[0];
      if (!row) return J({ ok: true });
      const admin = this.env.ADMIN_KEY && typeof body.admin === 'string' && sameStr(body.admin, String(this.env.ADMIN_KEY));
      if (!admin && !(typeof body.dk === 'string' && sameStr(body.dk, row.dk))) return J({ error: '내가 쓴 글만 지울 수 있어요' }, 403);
      this.sql.exec('DELETE FROM board WHERE id = ?', id);
      return J({ ok: true });
    }
    if (op === 'register' || op === 'login') {
      const id = String(body.id ?? '').trim().toLowerCase();
      const pw = String(body.pw ?? '');
      if (!ID_RE.test(id)) return J({ error: '아이디는 한글·영문 소문자·숫자·_ 로 3~12자예요' }, 400);
      if (pw.length < PW_MIN || pw.length > PW_MAX) return J({ error: `비밀번호는 ${PW_MIN}~${PW_MAX}자예요` }, 400);
      const row = this.sql.exec('SELECT * FROM users WHERE id = ?', id).toArray()[0];
      if (op === 'register') {
        if (row) return J({ error: '이미 있는 아이디예요. 다른 아이디를 써 주세요' }, 409);
        const list = (this.regByIp.get(ip) || []).filter(x => now - x < 3600e3);
        if (list.length >= 5) return J({ error: '같은 곳에서 계정을 너무 많이 만들었어요. 1시간 뒤에 다시 해 주세요' }, 429);
        list.push(now); this.regByIp.set(ip, list);
        const salt = randHex(16), hash = await hashPw(pw, salt);
        this.sql.exec('INSERT INTO users(id, salt, hash, data, created, updated) VALUES (?, ?, ?, NULL, ?, ?)', id, salt, hash, now, now);
        return J({ ok: true, id, token: this.newSession(id), data: null });
      }
      if (!row) return J({ error: '아이디 또는 비밀번호가 맞지 않아요' }, 401);
      if (row.lock_until > now) return J({ error: `비밀번호를 여러 번 틀렸어요. ${Math.ceil((row.lock_until - now) / 60000)}분 뒤에 다시 해 주세요` }, 429);
      const hash = await hashPw(pw, row.salt);
      if (!sameStr(hash, row.hash)) {
        const fails = (row.fails || 0) + 1;
        this.sql.exec('UPDATE users SET fails = ?, lock_until = ? WHERE id = ?', fails >= 5 ? 0 : fails, fails >= 5 ? now + 5 * 60e3 : 0, id);
        return J({ error: '아이디 또는 비밀번호가 맞지 않아요' }, 401);
      }
      this.sql.exec('UPDATE users SET fails = 0, lock_until = 0 WHERE id = ?', id);
      if (Math.random() < 0.05) this.sql.exec('DELETE FROM sessions WHERE exp < ?', now);
      let data = null; try { data = row.data ? JSON.parse(row.data) : null; } catch { data = null; }
      return J({ ok: true, id, token: this.newSession(id), data });
    }
    const id = this.who(body.token);
    if (!id) return J({ error: '다시 로그인해 주세요' }, 401);
    if (op === 'load') {
      const row = this.sql.exec('SELECT data FROM users WHERE id = ?', id).toArray()[0];
      let data = null; try { data = row && row.data ? JSON.parse(row.data) : null; } catch { data = null; }
      return J({ ok: true, id, data });
    }
    if (op === 'save') {
      const d = body.data;
      if (!d || typeof d !== 'object' || Array.isArray(d)) return J({ error: '잘못된 데이터' }, 400);
      const s = JSON.stringify(d);
      if (s.length > SAVE_MAX) return J({ error: '데이터가 너무 커요' }, 413);
      this.sql.exec('UPDATE users SET data = ?, updated = ? WHERE id = ?', s, now, id);
      return J({ ok: true, at: now });
    }
    if (op === 'logout') { this.sql.exec('DELETE FROM sessions WHERE token = ?', body.token); return J({ ok: true }); }
    return J({ error: 'not found' }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/hello') {
      return Response.json({ monggeul: true, cap: CAP, accounts: true, board: true, hof: true }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname.startsWith('/api/acct/') || url.pathname.startsWith('/api/board/') || url.pathname.startsWith('/api/hof/')) {
      const isBoard = url.pathname.startsWith('/api/board/'), isHof = url.pathname.startsWith('/api/hof/');
      const op = isBoard ? 'board-' + url.pathname.slice('/api/board/'.length) : isHof ? 'hof-' + url.pathname.slice('/api/hof/'.length) : url.pathname.slice('/api/acct/'.length);
      if (![ 'register', 'login', 'load', 'save', 'logout', 'board-list', 'board-post', 'board-del', 'hof-list', 'hof-submit', 'hof-collect'].includes(op)) return J({ error: 'not found' }, 404);
      if (op !== 'board-list' && op !== 'hof-list' && request.method !== 'POST') return J({ error: 'POST only' }, 405);
      if (!env.VAULT) return J({ error: '서버 설정 파일(wrangler.jsonc)에 계정 저장소(VAULT)가 없어요. 새 wrangler.jsonc를 올려 주세요' }, 500);
      try {
        const stub = env.VAULT.get(env.VAULT.idFromName('vault'));
        const headers = new Headers({ 'content-type': 'application/json', 'x-ip': request.headers.get('cf-connecting-ip') || '' });
        return await stub.fetch(new Request('https://vault/' + op, { method: 'POST', headers, body: request.method === 'POST' ? await request.text() : '{}' }));
      } catch (e) {
        return J({ error: '계정 서버 오류: ' + String(e && e.message || e).slice(0, 120) }, 500);
      }
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
