// 아몰랑아일랜드 실시간 서버 — Cloudflare Worker + Durable Object (WebSocket Hibernation)
// - Island: 섬(방) 하나당 정원 CAP명. 상태 중계 + 채팅(최근 50개만 보관) + 수조 구경 요청 중계
// - Vault : 아이디/비밀번호 계정과 저장 데이터 (전체 섬 공용, 인스턴스 1개)
import { DurableObject } from 'cloudflare:workers';

const CAP = 40;          // 섬 하나 정원
const MAX_ISLANDS = 30;  // 섬 개수 상한
const HOF_CACHE_MS = 15000; // 명예의 전당 목록 기억 시간
const LEGEND_MS = 3 * 60 * 1000; // ★7을 잡으면 모두에게 축하 알림 + 무지개 이벤트 (3분)
const LEGEND_IDS = new Set(['rainbowwhale', 'auroraray', 'rainbowflyer', 'prismjelly', 'rainbowseahorse', 'chaeunryong', 'chilbokoi', 'rainbowtrout', 'rainbowveil', 'rainbowsturgeon']);
const MAX_MSG = 8192;    // 메시지 최대 크기(바이트) — 큰 수조(최대 200마리) 구경 정보까지 들어가게
const MAX_RATE = 20;     // 접속자 1명당 초당 최대 메시지 수
const CHAT_KEEP = 100;   // 섬마다 보관하는 최근 채팅 수 (넘으면 오래된 것부터 삭제)
const CHAT_LEN = 60;     // 채팅 한 줄 최대 글자 수
const CHAT_GAP = 1500;   // 같은 사람이 채팅을 보낼 수 있는 최소 간격(ms)

const EMOJI = new Set(["👋", "🙇", "🙏", "🤝", "✌️", "🫡", "🙌", "👀", "😊", "😆", "🥹", "😌", "😴", "🤔", "😮", "😭", "😤", "🥶", "🫠", "😎", "🤣", "😇", "🥳", "😑", "👍", "👏", "🔥", "💪", "🎉", "✨", "❤️", "💯", "🎣", "🐟", "🐠", "🐡", "🦑", "🦀", "🐙", "🦈", "🐳", "🌊", "⚓", "🪝", "☕", "🍜", "🍙", "🍎", "🍊", "🍑", "🌸", "🌳", "🏕️", "🔥", "🌙", "⭐", "🌧️", "🍀", "🦋", "🐚", "😋", "🤗", "🥺", "😅", "🐬"]); // 뒤 4개: 오래된 PC에서 네모로 보이던 🫡🥹🫠🪝 대신 쓰는 이모지 (예전 것도 계속 받아요)
const SPECIES_LIST = ["goby", "halfbeak", "jack", "mackerel", "rockfish", "greenling", "schlegeli", "porgy", "bass", "flounder", "starfish", "chub", "crucian", "loach", "carp", "catfish", "mandarin", "goldfish", "filefish", "puffer", "redbream", "oplegnathus", "hairtail", "mullet", "dodari", "stingray", "moray", "tuna", "sunfish", "octopus", "squid", "webfoot", "seahorse", "bluecrab", "snowcrab", "prawn", "spinylobster", "jellyfish", "urchin", "catshark", "blueshark", "hammerhead", "whaleshark", "clownfish", "bluetang", "emperorangel", "butterfly", "mandarinfish", "lionfish", "parrotfish", "boxfish", "medaka", "minnow", "kkeokji", "sweetfish", "masu", "snakehead", "eel", "crayfish", "freshshrimp", "turtle", "koi", "guppy", "betta", "arowana", "seal", "dolphin", "orca", "seaotter", "otter", "anchovy", "bekasquid", "hermitcrab", "seacucumber", "sandlance", "shorecrab", "bitterling", "topmouth", "gizzardshad", "yellowcroaker", "saury", "herring", "flatfish", "wrasse", "sillago", "damsel", "darkchub", "sandgudgeon", "monkfish", "scorpionfish", "spanishmack", "croaker", "cuttlefish", "conger", "gurnard", "yellowtang", "bagrid", "skygager", "amberjack", "yellowtail", "kobudai", "bigfinsquid", "hairycrab", "sevenband", "lobster", "moorishidol", "triggerfish", "leopardshark", "lenok", "stickleback", "giantgrouper", "marlin", "swordfish", "sailfish", "kingcrab", "giantoctopus", "dumbo", "vampiresquid", "opah", "tigershark", "greatwhite", "thresher", "footballfish", "napoleon", "chimaera", "giantmoray", "sturgeon", "giantcatfish", "mutae", "goldkoi", "humpback", "bluewhale", "spermwhale", "beluga", "narwhal", "sealion", "walrus", "dugong", "manatee", "leatherback", "greenturtle", "giantsquid", "oarfish", "coelacanth", "mantaray", "leafyseadragon", "goldmandarin", "eoreumchi", "arapaima", "mihojonggae", "rainbowwhale", "auroraray", "rainbowflyer", "prismjelly", "rainbowseahorse", "chaeunryong", "chilbokoi", "rainbowtrout", "rainbowveil", "rainbowsturgeon", "seal_r", "dolphin_r", "orca_r", "seaotter_r", "otter_r", "marlin_r", "humpback_r", "bluewhale_r", "spermwhale_r", "beluga_r", "narwhal_r", "sealion_r", "walrus_r", "dugong_r", "manatee_r", "leatherback_r", "greenturtle_r", "giantsquid_r", "oarfish_r", "coelacanth_r", "mantaray_r", "leafyseadragon_r", "goldmandarin_r", "eoreumchi_r", "arapaima_r", "mihojonggae_r"];
// 생물별 최대 크기(cm): 명예의 전당 기록 검증용
const SPECIES_MAX = {"goby": 24.0, "halfbeak": 35.0, "jack": 30.0, "mackerel": 38.0, "rockfish": 28.0, "greenling": 35.0, "schlegeli": 45.0, "porgy": 55.0, "bass": 80.0, "flounder": 80.0, "starfish": 20.0, "chub": 16.0, "crucian": 32.0, "loach": 18.0, "carp": 80.0, "catfish": 70.0, "mandarin": 45.0, "goldfish": 16.0, "filefish": 30.0, "puffer": 40.0, "redbream": 80.0, "oplegnathus": 60.0, "hairtail": 150.0, "mullet": 60.0, "dodari": 35.0, "stingray": 120.0, "moray": 120.0, "tuna": 250.0, "sunfish": 300.0, "octopus": 90.0, "squid": 45.0, "webfoot": 20.0, "seahorse": 18.0, "bluecrab": 25.0, "snowcrab": 40.0, "prawn": 25.0, "spinylobster": 40.0, "jellyfish": 35.0, "urchin": 12.0, "catshark": 60.0, "blueshark": 300.0, "hammerhead": 400.0, "whaleshark": 900.0, "clownfish": 11.0, "bluetang": 30.0, "emperorangel": 40.0, "butterfly": 20.0, "mandarinfish": 8.0, "lionfish": 35.0, "parrotfish": 60.0, "boxfish": 20.0, "medaka": 4.0, "minnow": 15.0, "kkeokji": 20.0, "sweetfish": 28.0, "masu": 40.0, "snakehead": 90.0, "eel": 90.0, "crayfish": 12.0, "freshshrimp": 4.0, "turtle": 30.0, "koi": 80.0, "guppy": 6.0, "betta": 7.0, "arowana": 100.0, "seal": 200.0, "dolphin": 260.0, "orca": 300.0, "seaotter": 145.0, "otter": 120.0, "anchovy": 14.0, "bekasquid": 15.0, "hermitcrab": 8.0, "seacucumber": 30.0, "sandlance": 18.0, "shorecrab": 6.0, "bitterling": 9.0, "topmouth": 12.0, "gizzardshad": 30.0, "yellowcroaker": 30.0, "saury": 35.0, "herring": 35.0, "flatfish": 35.0, "wrasse": 25.0, "sillago": 30.0, "damsel": 12.0, "darkchub": 20.0, "sandgudgeon": 25.0, "monkfish": 100.0, "scorpionfish": 30.0, "spanishmack": 100.0, "croaker": 90.0, "cuttlefish": 35.0, "conger": 100.0, "gurnard": 40.0, "yellowtang": 20.0, "bagrid": 30.0, "skygager": 80.0, "amberjack": 130.0, "yellowtail": 100.0, "kobudai": 90.0, "bigfinsquid": 50.0, "hairycrab": 15.0, "sevenband": 80.0, "lobster": 50.0, "moorishidol": 25.0, "triggerfish": 30.0, "leopardshark": 180.0, "lenok": 70.0, "stickleback": 8.0, "giantgrouper": 250.0, "marlin": 400.0, "swordfish": 350.0, "sailfish": 300.0, "kingcrab": 80.0, "giantoctopus": 300.0, "dumbo": 30.0, "vampiresquid": 30.0, "opah": 180.0, "tigershark": 450.0, "greatwhite": 550.0, "thresher": 450.0, "footballfish": 60.0, "napoleon": 200.0, "chimaera": 120.0, "giantmoray": 300.0, "sturgeon": 250.0, "giantcatfish": 250.0, "mutae": 200.0, "goldkoi": 90.0, "humpback": 700.0, "bluewhale": 950.0, "spermwhale": 600.0, "beluga": 450.0, "narwhal": 500.0, "sealion": 250.0, "walrus": 350.0, "dugong": 320.0, "manatee": 380.0, "leatherback": 200.0, "greenturtle": 130.0, "giantsquid": 950.0, "oarfish": 800.0, "coelacanth": 200.0, "mantaray": 600.0, "leafyseadragon": 35.0, "goldmandarin": 50.0, "eoreumchi": 45.0, "arapaima": 300.0, "mihojonggae": 10.0, "rainbowwhale": 950.0, "auroraray": 450.0, "rainbowflyer": 60.0, "prismjelly": 90.0, "rainbowseahorse": 35.0, "chaeunryong": 900.0, "chilbokoi": 120.0, "rainbowtrout": 110.0, "rainbowveil": 50.0, "rainbowsturgeon": 280.0, "seal_r": 200.0, "dolphin_r": 260.0, "orca_r": 300.0, "seaotter_r": 145.0, "otter_r": 120.0, "marlin_r": 400.0, "humpback_r": 700.0, "bluewhale_r": 950.0, "spermwhale_r": 600.0, "beluga_r": 450.0, "narwhal_r": 500.0, "sealion_r": 250.0, "walrus_r": 350.0, "dugong_r": 320.0, "manatee_r": 380.0, "leatherback_r": 200.0, "greenturtle_r": 130.0, "giantsquid_r": 950.0, "oarfish_r": 800.0, "coelacanth_r": 200.0, "mantaray_r": 600.0, "leafyseadragon_r": 35.0, "goldmandarin_r": 50.0, "eoreumchi_r": 45.0, "arapaima_r": 300.0, "mihojonggae_r": 10.0};
const SPECIES = new Set(SPECIES_LIST);
// 희귀종(★6 색깔 다른 친구들): 잡으면 모든 섬에 알림만 (무지개 이벤트 없음)
const RARE_IDS = new Set(SPECIES_LIST.filter(x => x.endsWith('_r')));
const N_ADJ = 40, N_NOUN = 40;
// 화면과 같은 랜덤 이름 낱말 (예전 이름을 찾을 때 써요)
const NAME_ADJ = ['졸린','느긋한','수줍은','배고픈','행복한','조용한','용감한','꼼꼼한','엉뚱한','다정한','새벽의','반짝이는','동글동글한','씩씩한','몽글몽글한','하품하는','기다리는','낭만적인','차분한','깜찍한','부지런한','느릿느릿한','콧노래하는','멍때리는','설레는','포근한','잔잔한','노을빛','별빛','따끈한','말랑한','성실한','수상한','신난','꿈꾸는','해맑은','소심한','당당한','폭신한','산책하는'];
const NAME_NOUN = ['망둥어','갈매기','고등어','볼락','우럭','광어','문어','해파리','소라','조개','꽃게','전갱이','붕어','잉어','메기','낚시꾼','선장','등대지기','파도','물결','돌고래','해달','펭귄','수달','불가사리','오징어','새우','미역','거북이','물개','복어','고래','해마','다람쥐','너구리','토끼','고양이','강아지','부엉이','반딧불이'];
function nameStr(nm) {
  if (!nm || typeof nm !== 'object') return '';
  if (typeof nm.nk === 'string' && nm.nk.trim()) return cleanNick(nm.nk) || '';
  if (!Number.isInteger(nm.a) || !Number.isInteger(nm.b)) return '';
  return cleanNick(NAME_ADJ[Math.abs(nm.a) % NAME_ADJ.length] + ' ' + NAME_NOUN[Math.abs(nm.b) % NAME_NOUN.length]) || '';
}
// 🐚 용궁 소라 룰렛: 30초마다 (20초 베팅 · 7초 회전 · 3초 결과). 결과는 베팅 마감 뒤에 섬 서버가 정해요
const RW_ROUND = 30000, RW_BET = 20000, RW_GRACE = 1500;
const RW_N = 26;                 // 🐟12 · 🦀6 · 🐙4 · 🐬2 · 🐋1 · 🦑1 (칸 배치는 화면과 같아요)
const RW_CAP = [5000, 5000, 5000, 5000, 5000], RW_MAX = 5000;  // 한 판 합계 5,000 · 한 칸에 전부 걸어도 돼요
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
    lk: [idx(lk[0], 8), idx(lk[1], 12), idx(lk[2], 5), idx(lk[3], 12)],
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
    pk: idx(d.pk, 4),
    pt: d.pt === 1 ? 1 : 0,
    fl: idx(d.fl, 4),
    rl: idx(d.rl, 3),
    bt: d.bt === 1 ? 1 : 0,
    sd: typeof d.sd === 'string' && /^[a-z0-9]{6,16}$/.test(d.sd) ? d.sd : '',
    ck: ck ? [idx(ck[0], 3), idx(ck[1], 40), r2(num(ck[2], -120, 120, 0)), r2(num(ck[3], -120, 120, 0)), r2(num(ck[4], -50, 50, 0))] : [0, 0, 0, 0, 0],
  };
}
// 수조 자랑용 프로필
function sanitizeProfile(d) {
  if (!d || typeof d !== 'object') return null;
  const k = Array.isArray(d.k) ? d.k.slice(0, 200) : [];
  return {
    r: num(d.r | 0, 1, 7, 1),
    l: idx(d.l, 3),
    k: k.filter(x => Array.isArray(x) && x.length === 2).map(x => [idx(x[0], SPECIES_LIST.length), r2(num(x[1], 0.5, 1000, 10))]),
    m: num(d.m | 0, 0, 1e9, 0),
    b: num(d.b | 0, 0, 200, 0),
    c: num(d.c | 0, 50, 200, 50),
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
    // 채팅 줄 주인 지문(oh): 이름을 바꾸면 지난 채팅 기록 이름도 함께 바꿔요 (밖으로는 보내지 않아요)
    if (!new Set(this.sql.exec('PRAGMA table_info(chat2)').toArray().map(r => r.name)).has('oh')) this.sql.exec('ALTER TABLE chat2 ADD COLUMN oh TEXT');
    this.sql.exec('CREATE TABLE IF NOT EXISTS rw(r INTEGER PRIMARY KEY, s INTEGER, ts INTEGER)');
  }

  // 룰렛 결과: 있으면 그대로, 없으면(마감 뒤에만) 새로 뽑아 저장 · 최근 600판(약 5시간)만 보관
  rwRes(r, make) {
    const row = this.sql.exec('SELECT s FROM rw WHERE r = ?', r).toArray()[0];
    if (row) return row.s;
    if (!make) return null;
    const u = new Uint32Array(1); let s;
    do { crypto.getRandomValues(u); } while (u[0] >= Math.floor(0x100000000 / RW_N) * RW_N);
    s = u[0] % RW_N;
    this.sql.exec('INSERT OR IGNORE INTO rw(r, s, ts) VALUES (?, ?, ?)', r, s, Date.now());
    this.sql.exec('DELETE FROM rw WHERE r < ?', r - 600);
    return this.sql.exec('SELECT s FROM rw WHERE r = ?', r).toArray()[0].s;
  }
  rwState(live) {
    const now = Date.now(), r = Math.floor(now / RW_ROUND), bets = [];
    for (const w of live) { const a = w.deserializeAttachment(); if (a && a.rb && a.rb.r === r && a.p) bets.push({ id: a.id, n: a.p.n, nk: a.p.nk || '', b: a.rb.b }); }
    const last = this.sql.exec('SELECT r, s FROM rw ORDER BY r DESC LIMIT 12').toArray().map(x => [x.r, x.s]);
    return { now, r, bets, last };
  }

  recentChat() {
    return this.sql.exec('SELECT ts, a, b, nk, m FROM chat2 ORDER BY id DESC LIMIT ?', CHAT_KEEP).toArray().reverse()
      .map(r => ({ ts: r.ts, n: [r.a, r.b], nk: r.nk || '', m: r.m }));
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      // 계정 저장소(Worker)에서만 보내는 내부 알림: ★7 축하
      if (request.method === 'POST' && new URL(request.url).pathname === '/legend') {
        let lg = null; try { lg = await request.json(); } catch {}
        if (lg && LEGEND_IDS.has(lg.id) && lg.until > Date.now()) {
          await this.ctx.storage.put('legend', lg);
          this.broadcast({ t: 'lg', n: lg.n, id: lg.id, s: lg.s, left: lg.until - Date.now() }, null);
        }
        return new Response('ok');
      }
      if (request.method === 'POST' && new URL(request.url).pathname === '/rare') {
        let o = null; try { o = await request.json(); } catch {}
        if (o && RARE_IDS.has(o.id)) this.broadcast({ t: 'rr', n: String(o.n || '').slice(0, 20), id: o.id, s: o.s, ts: o.ts }, null);
        return new Response('ok');
      }
      return new Response('Expected WebSocket', { status: 426 });
    }
    const lgNow = await this.ctx.storage.get('legend');
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
    const lgLeft = lgNow && lgNow.until > Date.now() ? lgNow.until - Date.now() : 0;
    server.send(JSON.stringify({ t: 'welcome', id, peers, cap: CAP, chat: this.recentChat(), lg: lgLeft ? { n: lgNow.n, id: lgNow.id, s: lgNow.s, left: lgLeft } : null, rw: this.rwState(live) }));
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
        const op = a.p;
        a.p = p; a.la = Date.now(); ws.serializeAttachment(a); this.broadcast({ t: 'p', id: a.id, p }, ws);
        // 이름이 바뀌면 이 사람의 지난 채팅 기록 이름도 새 이름으로
        if (op && a.oh && (op.n[0] !== p.n[0] || op.n[1] !== p.n[1] || (op.nk || '') !== (p.nk || ''))) {
          const ts = this.sql.exec('SELECT ts FROM chat2 WHERE oh = ?', a.oh).toArray().map(r => r.ts);
          if (ts.length) { this.sql.exec('UPDATE chat2 SET a = ?, b = ?, nk = ? WHERE oh = ?', p.n[0], p.n[1], p.nk || '', a.oh); this.broadcast({ t: 'rn', ts, n: p.n, nk: p.nk || '' }, null); }
        }
        this.prune(); return;
      }
    } else if (m.t === 'c') {
      const now = Date.now();
      const text = cleanChat(m.m);
      if (text && a.p && now - (a.lc || 0) >= CHAT_GAP) {
        a.lc = now; ws.serializeAttachment(a);
        const n = a.p.n, nk = a.p.nk || '';
        this.sql.exec('INSERT INTO chat2(ts, a, b, nk, m, oh) VALUES (?, ?, ?, ?, ?, ?)', now, n[0], n[1], nk, text, a.oh || null);
        this.sql.exec('DELETE FROM chat2 WHERE id NOT IN (SELECT id FROM chat2 ORDER BY id DESC LIMIT ?)', CHAT_KEEP);
        this.broadcast({ t: 'c', id: a.id, n, nk, m: text, ts: now }, null);
        return;
      }
    } else if (m.t === 'oh') {
      if (typeof m.h === 'string' && /^[0-9a-f]{16}$/.test(m.h)) { a.oh = m.h; ws.serializeAttachment(a); }
      return;
    } else if (m.t === 'rb') {
      // 룰렛 베팅: 이번 판·베팅 시간·한도를 확인하고 모두에게 알려요
      const now = Date.now(), cur = Math.floor(now / RW_ROUND), r = Math.floor(+m.r);
      const b = Array.isArray(m.b) && m.b.length === 5 ? m.b.map(x => Math.floor(+x || 0)) : null;
      const ok = b && r === cur && now - cur * RW_ROUND < RW_BET + RW_GRACE && b.every((x, k) => x >= 0 && x <= RW_CAP[k] && x % 100 === 0) && b.reduce((p, q) => p + q, 0) <= RW_MAX;
      if (ok) {
        a.rb = { r, b }; ws.serializeAttachment(a);
        this.broadcast({ t: 'rbs', r, id: a.id, n: a.p ? a.p.n : [0, 0], nk: a.p ? a.p.nk || '' : '', b }, null);
        return;
      }
    } else if (m.t === 'rq') {
      // 룰렛 결과 요청: 베팅 마감 전에는 절대 알려 주지 않아요
      const now = Date.now(), cur = Math.floor(now / RW_ROUND), r = Math.floor(+m.r);
      if (Number.isFinite(r) && r <= cur && r > cur - 2000 && !(r === cur && now - cur * RW_ROUND < RW_BET)) {
        const had = this.rwRes(r, false);
        const s = had != null ? had : this.rwRes(r, true);
        const out = { t: 'rwr', r, s, now };
        if (had == null && r === cur) this.broadcast(out, null); else { try { ws.send(JSON.stringify(out)); } catch {} }
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
const SAVE_MAX = 300000;           // 저장 데이터 최대 크기(바이트) — 넉넉하게 (실제 저장은 보통 수십 KB 이하)
const BAK_KEEP = 40;               // 계정마다 보관하는 예전 저장본 수 (복구용)
const BAK_GAP = 20 * 60e3;         // 예전 저장본을 남기는 최소 간격 (물고기가 크게 줄면 1분 간격으로도 남김)
const SID_KEEP = 64;               // 서버에 반영된 최근 저장 번호(중복 저장 판별용)
const DSID_KEEP = 80;              // 화면(창)마다 '마지막으로 반영된 저장 번호' — 다른 기기가 아무리 많이 저장해도 밀려나지 않게
const LEGACY_NEW_MS = 5 * 60e3;
// 이 빌드보다 오래된 화면은 저장을 받지 않아요(새로고침 안내). 저장 항목이 바뀌는 업데이트를 할 때마다 올려요.
// 막힌 화면의 기록은 그 기기에 보관됐다가, 새로고침해서 다시 로그인하면 합쳐져요.
const MIN_CV = '2026-11-13x';
const OWNED_LISTS = ['rods', 'packs', 'floats', 'reels', 'hats', 'pets'];  // hats·pets: 출석 보상(꽃게 모자·아기 해달)    // 예전 버전 화면에서 온 저장은 최근 5분 안에 새로 잡은 물고기만 더해요

// ---------- 저장 데이터 안전 합치기 (서버) ----------
// 도감(book)은 늘어나기만 하는 기록이라 서버가 항상 '합집합 + 최댓값'으로 지켜요.
const pj = t => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
function bookUnion(a, b) {
  const o = {}; a = a && typeof a === 'object' ? a : {}; b = b && typeof b === 'object' ? b : {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k];
    const n = Math.max(x ? +x.n || 0 : 0, y ? +y.n || 0 : 0), best = Math.max(x ? +x.best || 0 : 0, y ? +y.best || 0 : 0);
    if (n > 0 || best > 0) o[k] = { n: Math.max(1, n | 0), best };
  }
  return o;
}
const normItems = a => (Array.isArray(a) ? a : []).filter(o => o && typeof o.id === 'string').map((o, i) => (+o.t ? o : Object.assign({}, o, { t: 1000 + i })));
const ikey = o => o.id + '|' + (+o.t) + '|' + (+o.s);
function itemsUnion(a, b) { const out = [], seen = new Set(); for (const o of [...normItems(a), ...normItems(b)]) { const k = ikey(o); if (!seen.has(k)) { seen.add(k); out.push(o); } } return out; }
// 예전 버전 화면(합치기 기능이 없는 화면)이 보낸 저장:
// 그 화면이 들고 있던 '예전 가방'을 통째로 합치면 이미 판 물고기가 되살아나요(물고기 복제 버그의 원인).
// 그래서 서버 기록은 그대로 두고, 최근 5분 안에 새로 잡은 물고기와 도감만 더해요.
function legacyAddNew(S, D, now) {
  const M = Object.assign({}, S); M.book = bookUnion(S.book, D.book); M.at = now;
  const cut = now - LEGACY_NEW_MS;
  const add = (sa, da) => { const out = normItems(sa), ks = new Set(out.map(ikey)); for (const o of normItems(da)) { const t = +o.t; if (t > cut && t <= now + 60e3 && !ks.has(ikey(o))) { ks.add(ikey(o)); out.push(o); } } return out; };
  M.tank = add(S.tank, D.tank);
  M.gs = Object.assign({}, S.gs || {}); M.gs.bag = add((S.gs || {}).bag, (D.gs || {}).bag);
  return M;
}
// 관리자 '합쳐 넣기'용: 두 기록의 물고기·도감·장비를 모두 합쳐요
function legacyMerge(S, D) {
  const M = Object.assign({}, S, D);
  M.book = bookUnion(S.book, D.book);
  M.tank = itemsUnion(S.tank, D.tank);
  M.mail = mergeMail(S.mail, D.mail);
  const sg = S.gs || {}, dg = D.gs || {};
  M.gs = Object.assign({}, sg, dg, {
    money: Math.max(+sg.money || 0, +dg.money || 0),
    rods: [...new Set([...(sg.rods || []), ...(dg.rods || [])])],
    packs: [...new Set([...(sg.packs || []), ...(dg.packs || [])])],
    floats: [...new Set([...(sg.floats || []), ...(dg.floats || [])])],
    tankUp: Math.max(sg.tankUp | 0, dg.tankUp | 0),
    freeLot: Math.max(sg.freeLot | 0, dg.freeLot | 0),
    reels: [...new Set([...(sg.reels || []), ...(dg.reels || [])])],
    hats: [...new Set([...(sg.hats || []), ...(dg.hats || [])])],
    pets: [...new Set([...(sg.pets || []), ...(dg.pets || [])])],
    bag: itemsUnion(sg.bag, dg.bag),
  });
  return M;
}
function saveSum(d) {
  if (!d) return null; const g = d.gs || {};
  const L = k => (Array.isArray(g[k]) ? g[k] : []).map(x => x | 0).filter(x => x > 0).sort((x, y) => x - y);
  return { book: d.book ? Object.keys(d.book).length : 0, tank: Array.isArray(d.tank) ? d.tank.length : 0, bag: Array.isArray(g.bag) ? g.bag.length : 0, food: Array.isArray(g.food) ? g.food.length : 0, money: +g.money || 0, at: +d.at || 0,
    gear: { rods: L('rods'), rod: g.rod | 0, packs: L('packs'), pack: g.pack | 0, floats: L('floats'), float: g.float | 0, reels: L('reels'), reel: g.reel | 0, tankUp: g.tankUp | 0, freeLot: g.freeLot | 0, lotPend: !!g.lotPend } };
}
const dsidOut = t => { const o = pj(t) || {}, r = {}; for (const k in o) r[k] = o[k].s; return r; };
// 산 물건(낚싯대·가방·찌·릴·수조 크기)은 어떤 저장으로도 줄어들지 않게 지켜요.
// 예전 화면은 새로 생긴 항목(찌·릴 등)을 몰라서 그 항목 없이 저장해요 → 서버에 있던 값을 그대로 이어 붙여요.
function keepOwned(old, d) {
  if (!old || typeof old !== 'object') return d;
  for (const k of Object.keys(old)) if (!(k in d)) d[k] = old[k];
  const og = old.gs && typeof old.gs === 'object' ? old.gs : null; if (!og) return d;
  const g = d.gs = Object.assign({}, d.gs || {});
  for (const k of Object.keys(og)) if (!(k in g)) g[k] = og[k];
  for (const k of OWNED_LISTS) { const u = [...new Set([...(Array.isArray(og[k]) ? og[k] : []), ...(Array.isArray(g[k]) ? g[k] : [])].map(x => x | 0))].filter(x => x > 0).sort((a, b) => a - b); if (u.length) g[k] = u; }
  g.tankUp = Math.max(og.tankUp | 0, g.tankUp | 0);
  if (old.mail || d.mail) d.mail = mergeMail(old.mail, d.mail);
  return d;
}
// 선물 우편함: 같은 선물(id)은 하나로, '읽음'은 한 번 읽으면 계속 읽음 — 어느 화면이 저장해도 선물 목록이 줄지 않게
function mergeMail(a, b) {
  const m = new Map();
  for (const x of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!x || typeof x.id !== 'string') continue;
    const o = m.get(x.id); if (o) { o.seen = (o.seen | 0) || (x.seen | 0) ? 1 : 0; } else m.set(x.id, Object.assign({}, x));
  }
  return [...m.values()].sort((p, q) => (p.ts || 0) - (q.ts || 0)).slice(-40);
}
const GIFT_LIM = { money: 1000000, lot: 100, tank: 15 };
function cleanGift(b) {
  const ints = (a, lo, hi) => [...new Set((Array.isArray(a) ? a : []).map(x => x | 0).filter(x => x >= lo && x <= hi))].sort((x, y) => x - y);
  const it = {
    money: Math.max(0, Math.min(GIFT_LIM.money, Math.floor(Number(b.money) || 0))),
    lot: Math.max(0, Math.min(GIFT_LIM.lot, Math.floor(Number(b.lot) || 0))),
    tank: Math.max(0, Math.min(GIFT_LIM.tank, Math.floor(Number(b.tank) || 0))),
    floats: ints(b.floats, 1, 3), reels: ints(b.reels, 1, 2), rods: ints(b.rods, 1, 7),
    // 잃어버린 물고기 되찾아 주기: [{id, s(cm), to:'bag'|'tank'}] 최대 30마리
    fish: (Array.isArray(b.fish) ? b.fish : []).slice(0, 30).map(f => ({ id: String((f && f.id) || ''), s: Math.round((Number(f && f.s) || 0) * 10) / 10, to: f && f.to === 'tank' ? 'tank' : 'bag' }))
      .filter(f => /^[a-z0-9_]{1,32}$/.test(f.id) && f.s >= 1 && f.s <= 2000),
  };
  const msg = String(b.msg || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
  const any = it.money || it.lot || it.tank || it.floats.length || it.reels.length || it.rods.length || it.fish.length;
  return any || msg ? { it, msg } : null;
}
function applyGift(d, gift, now, gid) {
  const g = d.gs = Object.assign({}, d.gs || {}), it = gift.it;
  g.money = Math.max(0, (+g.money || 0) + it.money);
  g.freeLot = Math.max(0, (g.freeLot | 0) + it.lot);
  g.tankUp = Math.min(GIFT_LIM.tank, (g.tankUp | 0) + it.tank);
  for (const [k, add] of [['floats', it.floats], ['reels', it.reels], ['rods', it.rods]]) if (add.length) g[k] = [...new Set([...(Array.isArray(g[k]) ? g[k] : []), ...add])].sort((a, b) => a - b);
  if (it.fish && it.fish.length) {
    // 새 물고기는 시각(t)을 겹치지 않게 붙여서, 게임 화면의 3-way 합치기에서 '새로 생긴 물고기'로 그대로 들어가요
    const bag = g.bag = Array.isArray(g.bag) ? g.bag.slice() : [], tank = d.tank = Array.isArray(d.tank) ? d.tank.slice() : [];
    const used = new Set([...bag, ...tank].map(o => o && o.id + '|' + o.t + '|' + o.s));
    let tt = now;
    for (const f of it.fish) { let o; do { o = { id: f.id, s: f.s, t: tt++ }; } while (used.has(o.id + '|' + o.t + '|' + o.s)); used.add(o.id + '|' + o.t + '|' + o.s); (f.to === 'tank' ? tank : bag).push(o); }
  }
  d.mail = mergeMail(d.mail, [{ id: gid, ts: now, msg: gift.msg, it, seen: 0 }]);
  d.at = now;
  return d;
}
function ownedSum(d) { const g = (d && d.gs) || {}; return { rods: g.rods || [], packs: g.packs || [], floats: g.floats || [], reels: g.reels || [], tankUp: g.tankUp | 0, float: g.float | 0, reel: g.reel | 0 }; }
const fishCount = d => { const x = saveSum(d); return x ? x.tank + x.bag : 0; };
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
    // 저장 번호(rev)·최근 저장 기록(sids): 여러 기기/창이 서로의 기록을 덮어쓰지 않게 해요
    const cols = new Set(this.sql.exec('PRAGMA table_info(users)').toArray().map(r => r.name));
    if (!cols.has('rev')) this.sql.exec('ALTER TABLE users ADD COLUMN rev INTEGER DEFAULT 0');
    if (!cols.has('sids')) this.sql.exec('ALTER TABLE users ADD COLUMN sids TEXT');
    if (!cols.has('dsid')) this.sql.exec('ALTER TABLE users ADD COLUMN dsid TEXT');
    this.sql.exec('CREATE TABLE IF NOT EXISTS baks(id TEXT, ts INTEGER, why TEXT, data TEXT, PRIMARY KEY(id, ts))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS gifts(gid TEXT PRIMARY KEY, ts INTEGER, target TEXT, n INTEGER, items TEXT, msg TEXT)');
    this.adminFail = new Map();
    this.regByIp = new Map();
    this.sql.exec('CREATE TABLE IF NOT EXISTS hof(id TEXT PRIMARY KEY, s REAL, n TEXT, ts INTEGER, ip TEXT)');
    // 기록 주인(k: a_계정 또는 g_기기): 이름을 바꾸면 그 사람 기록의 이름도 함께 바꿔요
    if (!new Set(this.sql.exec('PRAGMA table_info(hof)').toArray().map(r => r.name)).has('k')) this.sql.exec('ALTER TABLE hof ADD COLUMN k TEXT');
    this.hofByIp = new Map();
    this.lgByIp = new Map();
    this._lg = null;
    ctx.blockConcurrencyWhile(async () => { try { this._lg = (await ctx.storage.get('legend')) || null; } catch {} });
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
  // 덮어쓰기 전에 예전 저장본을 남겨요 (계정마다 최근 BAK_KEEP개)
  bak(id, oldText, now, why, force) {
    if (!oldText) return;
    const last = this.sql.exec('SELECT MAX(ts) AS t FROM baks WHERE id = ?', id).toArray()[0];
    const gap = last && last.t ? now - last.t : Infinity;
    if (why !== 'before-restore' && gap < (force ? 60e3 : BAK_GAP)) return;
    this.sql.exec('INSERT OR REPLACE INTO baks(id, ts, why, data) VALUES (?, ?, ?, ?)', id, now, why, oldText);
    this.sql.exec('DELETE FROM baks WHERE id = ? AND ts NOT IN (SELECT ts FROM baks WHERE id = ? ORDER BY ts DESC LIMIT ?)', id, id, BAK_KEEP);
  }
  // 계정의 지금 기록 + 예전 저장본(최대 BAK_KEEP개)에서: 썼던 이름들 · 도감 최고 크기 · 내가 올린 명예의 전당 크기
  userHist(uid) {
    const names = new Set(), mine = new Map(), best = new Map();
    const add = (m, id, v) => { const x = Math.round(Number(v) * 10) / 10; if (!(x > 0)) return; let st = m.get(id); if (!st) m.set(id, st = new Set()); st.add(x); };
    const rows = this.sql.exec('SELECT data FROM users WHERE id = ?', uid).toArray().concat(this.sql.exec('SELECT data FROM baks WHERE id = ?', uid).toArray());
    let cur = '';
    rows.forEach((r, i) => {
      const d = pj(r.data); if (!d || typeof d !== 'object') return;
      const nm = nameStr(d.name); if (nm) { names.add(nm); if (i === 0) cur = nm; }
      if (d.book && typeof d.book === 'object') for (const [id, v] of Object.entries(d.book)) if (v && SPECIES_MAX[id]) add(best, id, v.best);
      if (d.hm && typeof d.hm === 'object') for (const [id, v] of Object.entries(d.hm)) if (SPECIES_MAX[id]) add(mine, id, v);
    });
    return { names, mine, best, cur };
  }
  // 주인 표시가 없는 예전 기록 중 '이 사람 것'이 확실한 기록을 찾아요
  //  · '내가 명예의 전당에 올린 크기'(hm)와 똑같으면 내 기록 (같은 크기로는 기록을 갈아치울 수 없어요)
  //  · 도감 최고 크기만 같을 때는(최대 크기는 여러 명이 같을 수 있어요) 그때 쓰던 이름(계정의 예전 저장본에서 확인)까지 같아야 해요
  //    (IP는 여러 사람이 함께 쓰는 경우가 있어 증거로 쓰지 않아요)
  legacyRows(h, ip, cMine, cBest) {
    const out = [];
    const near = (st, x) => !!st && [...st].some(y => Math.abs(y - x) < 0.05);
    for (const r of this.sql.exec("SELECT id, s, n, ip FROM hof WHERE k IS NULL OR k = ''").toArray()) {
      if (near(h && h.mine.get(r.id), r.s) || near(cMine && cMine.get(r.id), r.s)) { out.push(r.id); continue; }
      if (!(near(h && h.best.get(r.id), r.s) || near(cBest && cBest.get(r.id), r.s))) continue;
      if (!!h && h.names.has(r.n) && r.n !== '익명의 낚시꾼') out.push(r.id);
    }
    return out;
  }
  // 명예의 전당 주인 열쇠 확인: 계정(a_)은 로그인 토큰이 맞아야 해요
  ownKey(k, token) {
    k = String(k || '');
    if (!/^(a_[a-z0-9가-힣_]{3,12}|g_[a-z0-9]{12,20})$/.test(k)) return null;
    if (k.startsWith('a_') && this.who(token) !== k.slice(2)) return null;
    return k;
  }
  legendNow(now) { const lg = this._lg; return lg && lg.until > now ? { n: lg.n, id: lg.id, s: lg.s, left: lg.until - now } : null; }
  colTop() { return this.sql.exec('SELECT n, MAX(c) AS c, MIN(ts) AS ts FROM collectors GROUP BY n ORDER BY c DESC, ts ASC LIMIT 5').toArray(); }
  // 명예의 전당·도감왕 결과를 15초 동안 기억해서 DB를 덜 읽어요 (기록이 바뀌면 바로 새로 계산)
  topCached(now) { if (!this._topC || now - this._topC.at > HOF_CACHE_MS) this._topC = { at: now, v: this.colTop() }; return this._topC.v; }
  hofCached(now) { if (!this._hofC || now - this._hofC.at > HOF_CACHE_MS) this._hofC = { at: now, v: this.sql.exec('SELECT id, s, n, ts FROM hof').toArray() }; return this._hofC.v; }
  async fetch(request) {
    const url = new URL(request.url);
    const op = url.pathname.split('/').pop();
    let body = {};
    try { const text = await request.text(); if (text.length > SAVE_MAX + 2000) return J({ error: '데이터가 너무 커요' }, 413); body = text ? JSON.parse(text) : {}; } catch { return J({ error: '잘못된 요청' }, 400); }
    const now = Date.now();
    const ip = request.headers.get('x-ip') || '';

    if (op === 'hof-list') {
      return J({ ok: true, list: this.hofCached(now), top: this.topCached(now), lg: this.legendNow(now) });
    }
    if (op === 'hof-legend') {
      const id = String(body.id || '');
      if (!LEGEND_IDS.has(id)) return J({ error: '★7 생물이 아니에요' }, 400);
      const sz = Math.round(Number(body.s) * 10) / 10;
      if (!Number.isFinite(sz) || sz <= 0 || sz > SPECIES_MAX[id] + 0.05) return J({ error: '크기가 이상해요' }, 400);
      const ipKey = ip.slice(0, 64);
      // 같은 곳(IP)에서 5분 안에 다시 보고하면 무시 (서버가 잠들었다 깨어나도 기억하도록 저장소에 기록)
      const ipK = 'lgip:' + ipKey;
      const last = this.lgByIp.get(ipKey) || (await this.ctx.storage.get(ipK)) || 0;
      if (now - last < 5 * 60 * 1000) return J({ ok: true, lg: this.legendNow(now), skipped: true });
      this.lgByIp.set(ipKey, now); await this.ctx.storage.put(ipK, now);
      const lg = { n: cleanNick(body.name) || '익명의 낚시꾼', id, s: sz, ts: now, until: now + LEGEND_MS };
      this._lg = lg; await this.ctx.storage.put('legend', lg);
      return J({ ok: true, lg: this.legendNow(now), fan: lg });
    }
    if (op === 'hof-rare') {
      const id = String(body.id || '');
      if (!RARE_IDS.has(id)) return J({ error: '희귀종이 아니에요' }, 400);
      const sz = Math.round(Number(body.s) * 10) / 10;
      if (!Number.isFinite(sz) || sz <= 0 || sz > SPECIES_MAX[id] + 0.05) return J({ error: '크기가 이상해요' }, 400);
      const ipKey = ip.slice(0, 64), k = 'rrip:' + ipKey;
      const last = this.lgByIp.get(k) || 0;
      if (now - last < 20 * 1000) return J({ ok: true, skipped: true });
      this.lgByIp.set(k, now);
      const fan = { n: cleanNick(body.name) || '익명의 낚시꾼', id, s: sz, ts: now };
      return J({ ok: true, fan });
    }
    if (op === 'hof-submit') {
      const id = String(body.id || '');
      const mx = SPECIES_MAX[id];
      if (!mx) return J({ error: '알 수 없는 생물이에요' }, 400);
      const sz = Math.round(Number(body.s) * 10) / 10;
      if (!Number.isFinite(sz) || sz <= 0 || sz > mx + 0.05) return J({ error: '크기가 이상해요' }, 400);
      const ipKey = ip.slice(0, 64);
      const list = (this.hofByIp.get(ipKey) || []).filter(x => now - x < 60e3);
      if (list.length >= 120) return J({ error: '잠시 후 다시 시도해 주세요' }, 429);
      list.push(now); this.hofByIp.set(ipKey, list);
      const name = cleanNick(body.name) || '익명의 낚시꾼';
      const row = this.sql.exec('SELECT s, n, ts FROM hof WHERE id = ?', id).toArray()[0];
      if (row && row.s >= sz) return J({ ok: true, top: false, rec: { s: row.s, n: row.n, ts: row.ts } });
      this.sql.exec('INSERT OR REPLACE INTO hof(id, s, n, ts, ip, k) VALUES (?, ?, ?, ?, ?, ?)', id, sz, name, now, ipKey, this.ownKey(body.key, body.token));
      this._hofC = null;
      return J({ ok: true, top: true, name, prev: row ? { s: row.s, n: row.n } : null });
    }
    if (op === 'hof-sync') {
      // 도감의 '내 최고 기록'이 명예의 전당보다 크면 다시 올려요 (전송 실패로 빠진 기록 자동 복구)
      const items = Array.isArray(body.list) ? body.list.slice(0, SPECIES_LIST.length) : [];
      const ipKey = ip.slice(0, 64);
      const lst = (this.hofByIp.get(ipKey) || []).filter(x => now - x < 60e3);
      if (lst.length >= 120) return J({ error: '잠시 후 다시 시도해 주세요' }, 429);
      lst.push(now); this.hofByIp.set(ipKey, lst);
      const name = cleanNick(body.name) || '익명의 낚시꾼';
      const ok = this.ownKey(body.key, body.token);
      const won = [], recs = [];
      for (const it of items) {
        const id = String(it && it.id || ''); const mx = SPECIES_MAX[id]; if (!mx) continue;
        const sz = Math.round(Number(it.s) * 10) / 10; if (!Number.isFinite(sz) || sz <= 0 || sz > mx + 0.05) continue;
        const row = this.sql.exec('SELECT s, n, ts FROM hof WHERE id = ?', id).toArray()[0];
        if (row && row.s >= sz) { recs.push({ id, s: row.s, n: row.n, ts: row.ts }); continue; }
        this.sql.exec('INSERT OR REPLACE INTO hof(id, s, n, ts, ip, k) VALUES (?, ?, ?, ?, ?, ?)', id, sz, name, now, ipKey, ok);
        won.push({ id, s: sz, prev: row ? { s: row.s, n: row.n } : null });
      }
      if (won.length) this._hofC = null;
      return J({ ok: true, name, won, recs });
    }
    if (op === 'hof-rename') {
      // 이름을 바꾸면: 내 명예의 전당 기록 · 도감왕 · 게시판의 내 글 이름을 새 이름으로
      const k = this.ownKey(body.key, body.token);
      if (!k) return J({ error: '다시 로그인해 주세요' }, 401);
      const ipKey = ip.slice(0, 64);
      const lst = (this.hofByIp.get(ipKey) || []).filter(x => now - x < 60e3);
      if (lst.length >= 120) return J({ error: '잠시 후 다시 시도해 주세요' }, 429);
      lst.push(now); this.hofByIp.set(ipKey, lst);
      const name = cleanNick(body.name) || '익명의 낚시꾼';
      let hof = 0, board = 0;
      // 예전 기록(주인 표시 없음): 크기가 맞고, 예전에 쓰던 이름(계정 저장본에서 확인)이나 올린 곳(IP)이 같으면 내 기록이에요
      const toMap = a => { const m = new Map(); for (const c of (Array.isArray(a) ? a : []).slice(0, SPECIES_LIST.length)) { const id = String(c && c.id || ''); if (!SPECIES_MAX[id]) continue; const sz = Math.round(Number(c.s) * 10) / 10; if (!Number.isFinite(sz) || sz <= 0) continue; let st = m.get(id); if (!st) m.set(id, st = new Set()); st.add(sz); } return m; };
      const h = k.startsWith('a_') ? this.userHist(k.slice(2)) : null;
      for (const id of this.legacyRows(h, ipKey, toMap(body.claims), toMap(body.bests))) { this.sql.exec('UPDATE hof SET n = ?, k = ? WHERE id = ?', name, k, id); hof++; }
      hof += this.sql.exec('SELECT COUNT(*) AS c FROM hof WHERE k = ? AND n != ?', k, name).toArray()[0].c;
      this.sql.exec('UPDATE hof SET n = ? WHERE k = ?', name, k);
      this.sql.exec('UPDATE collectors SET n = ? WHERE k = ?', name, k);
      const dks = Array.isArray(body.dks) ? body.dks.filter(x => typeof x === 'string' && /^[0-9a-f]{24}$/.test(x)).slice(0, 200) : [];
      for (const dk of dks) { const r = this.sql.exec('SELECT id FROM board WHERE dk = ? AND name != ?', dk, name).toArray()[0]; if (r) { this.sql.exec('UPDATE board SET name = ? WHERE dk = ?', name, dk); board++; } }
      this._hofC = null; this._topC = null;
      return J({ ok: true, name, hof, board });
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
      if (lst.length >= 120) return J({ error: '잠시 후 다시 시도해 주세요' }, 429);
      lst.push(now); this.hofByIp.set(ipKey, lst);
      const name = cleanNick(body.name) || '익명의 낚시꾼';
      const row = this.sql.exec('SELECT c FROM collectors WHERE k = ?', k).toArray()[0];
      if (!row) this.sql.exec('INSERT INTO collectors(k, n, c, ts, ip) VALUES (?, ?, ?, ?, ?)', k, name, c, now, ipKey);
      else if (c > row.c) this.sql.exec('UPDATE collectors SET n = ?, c = ?, ts = ?, ip = ? WHERE k = ?', name, c, now, ipKey, k);
      else this.sql.exec('UPDATE collectors SET n = ? WHERE k = ?', name, k);
      this._topC = null;
      return J({ ok: true, top: this.topCached(now) });
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
      return J({ ok: true, id, token: this.newSession(id), data, rev: row.rev | 0, sids: (pj(row.sids) || []).map(x => x.s), dsid: dsidOut(row.dsid) });
    }
    if (op === 'admin-gift' || op === 'admin-gifts') {
      const ipKey = ip.slice(0, 64);
      const fails = (this.adminFail.get(ipKey) || []).filter(x => now - x < 3600e3);
      if (fails.length >= 10) return J({ error: '관리자 키를 너무 많이 틀렸어요. 1시간 뒤에 다시 해 주세요' }, 429);
      const okKey = this.env.ADMIN_KEY && typeof body.admin === 'string' && sameStr(body.admin, String(this.env.ADMIN_KEY));
      if (!okKey) { fails.push(now); this.adminFail.set(ipKey, fails); return J({ error: this.env.ADMIN_KEY ? '관리자 키가 맞지 않아요' : '서버에 ADMIN_KEY가 설정되어 있지 않아요' }, 403); }
      if (op === 'admin-gifts') {
        const list = this.sql.exec('SELECT gid, ts, target, n, items, msg FROM gifts ORDER BY ts DESC LIMIT 100').toArray().map(r => ({ gid: r.gid, ts: r.ts, target: r.target, n: r.n, it: pj(r.items), msg: r.msg }));
        return J({ ok: true, list });
      }
      const gift = cleanGift(body); if (!gift) return J({ error: '보낼 보상이나 메시지를 넣어 주세요' }, 400);
      const gid = 'g' + now.toString(36) + Math.random().toString(36).slice(2, 7);
      const all = body.all === true;
      const uid = String(body.id ?? '').trim().toLowerCase();
      const rows = all ? this.sql.exec('SELECT id, data, rev FROM users WHERE data IS NOT NULL').toArray()
                       : this.sql.exec('SELECT id, data, rev FROM users WHERE id = ?', uid).toArray();
      if (!all && !rows.length) return J({ error: '없는 아이디예요' }, 404);
      let n = 0, skip = 0;
      for (const row of rows) {
        const d = pj(row.data); if (!d || d.v !== 2) { skip++; continue; }
        applyGift(d, gift, now, gid);
        if (!all) this.bak(row.id, row.data, now, 'before-restore', true);
        // 저장 번호를 올려서, 게임을 켜 둔 화면도 다음 저장 때 서버 기록(선물 포함)과 합쳐요
        this.sql.exec('UPDATE users SET data = ?, updated = ?, rev = ? WHERE id = ?', JSON.stringify(d), now, (row.rev | 0) + 1, row.id);
        n++;
      }
      if (!all && !n) return J({ error: '아직 게임 기록이 없는 아이디예요 (한 번 접속해서 저장된 뒤에 보낼 수 있어요)' }, 400);
      this.sql.exec('INSERT INTO gifts(gid, ts, target, n, items, msg) VALUES (?, ?, ?, ?, ?, ?)', gid, now, all ? '*' : uid, n, JSON.stringify(gift.it), gift.msg);
      return J({ ok: true, gid, n, skip, it: gift.it });
    }
    if (op.startsWith('admin-')) {
      const ipKey = ip.slice(0, 64);
      const fails = (this.adminFail.get(ipKey) || []).filter(x => now - x < 3600e3);
      if (fails.length >= 10) return J({ error: '관리자 키를 너무 많이 틀렸어요. 1시간 뒤에 다시 해 주세요' }, 429);
      const okKey = this.env.ADMIN_KEY && typeof body.admin === 'string' && sameStr(body.admin, String(this.env.ADMIN_KEY));
      if (!okKey) { fails.push(now); this.adminFail.set(ipKey, fails); return J({ error: this.env.ADMIN_KEY ? '관리자 키가 맞지 않아요' : '서버에 ADMIN_KEY가 설정되어 있지 않아요' }, 403); }
      if (op === 'admin-hofls') {
        const list = this.sql.exec('SELECT id, s, n, ts, k FROM hof').toArray().map(r => ({ id: r.id, s: r.s, n: r.n, ts: r.ts, own: r.k ? (r.k.startsWith('a_') ? r.k.slice(2) : '기기(손님)') : '' }));
        return J({ ok: true, list });
      }
      if (op === 'admin-hofset') {
        const sid = String(body.sid || ''); if (!SPECIES_MAX[sid]) return J({ error: '알 수 없는 생물이에요' }, 400);
        const nm = cleanNick(String(body.name || '')); if (!nm) return J({ error: '이름은 한글·영문·숫자 2~10자예요' }, 400);
        const r = this.sql.exec('SELECT id FROM hof WHERE id = ?', sid).toArray()[0]; if (!r) return J({ error: '그 생물은 아직 기록이 없어요' }, 404);
        const own = String(body.own || '').trim().toLowerCase();
        if (own && !this.sql.exec('SELECT id FROM users WHERE id = ?', own).toArray()[0]) return J({ error: '없는 아이디예요 (주인 아이디)' }, 404);
        if (own) this.sql.exec('UPDATE hof SET n = ?, k = ? WHERE id = ?', nm, 'a_' + own, sid); else this.sql.exec('UPDATE hof SET n = ? WHERE id = ?', nm, sid);
        this._hofC = null;
        return J({ ok: true });
      }
      if (op === 'admin-hoffix') {
        // 모든 계정을 차례로 살펴, 주인 표시가 없는 예전 기록 중 확실한 것만 지금 이름으로 바꿔요 (한 번에 25개 계정씩)
        const after = String(body.after || '');
        const users = this.sql.exec('SELECT id FROM users WHERE id > ? ORDER BY id LIMIT 25', after).toArray().map(r => r.id);
        let fixed = 0, named = 0; const done = [];
        for (const uid2 of users) {
          const h = this.userHist(uid2); if (!h.cur) continue;
          const k2 = 'a_' + uid2;
          for (const id of this.legacyRows(h, '', null, null)) { this.sql.exec('UPDATE hof SET n = ?, k = ? WHERE id = ?', h.cur, k2, id); fixed++; done.push({ id, n: h.cur }); }
          // 이미 주인 표시가 있는 기록·도감왕은 지금 이름으로
          named += this.sql.exec('SELECT COUNT(*) AS c FROM hof WHERE k = ? AND n != ?', k2, h.cur).toArray()[0].c;
          this.sql.exec('UPDATE hof SET n = ? WHERE k = ?', h.cur, k2);
          this.sql.exec('UPDATE collectors SET n = ? WHERE k = ?', h.cur, k2);
        }
        if (fixed || named) { this._hofC = null; this._topC = null; }
        const total = this.sql.exec('SELECT COUNT(*) AS c FROM users').toArray()[0].c;
        const left = this.sql.exec("SELECT COUNT(*) AS c FROM hof WHERE k IS NULL OR k = ''").toArray()[0].c;
        return J({ ok: true, next: users.length === 25 ? users[users.length - 1] : '', seen: users.length, total, fixed: fixed + named, done, left });
      }
      const uid = String(body.id ?? '').trim().toLowerCase();
      const row = this.sql.exec('SELECT id, data, rev, created, updated FROM users WHERE id = ?', uid).toArray()[0];
      if (!row) return J({ error: '없는 아이디예요' }, 404);
      if (op === 'admin-user') {
        const baks = this.sql.exec('SELECT ts, why, data FROM baks WHERE id = ? ORDER BY ts DESC', uid).toArray().map(b => ({ ts: b.ts, why: b.why, sum: saveSum(pj(b.data)) }));
        return J({ ok: true, id: uid, rev: row.rev | 0, created: row.created, updated: row.updated, sum: saveSum(pj(row.data)), baks });
      }
      if (op === 'admin-bak') {
        const ts = Number(body.ts);
        if (ts === 0) return J({ ok: true, data: pj(row.data) });
        const b = this.sql.exec('SELECT data FROM baks WHERE id = ? AND ts = ?', uid, ts).toArray()[0];
        return b ? J({ ok: true, data: pj(b.data) }) : J({ error: '그 저장본이 없어요' }, 404);
      }
      if (op === 'admin-restore') {
        const ts = Number(body.ts);
        const b = this.sql.exec('SELECT data FROM baks WHERE id = ? AND ts = ?', uid, ts).toArray()[0];
        if (!b) return J({ error: '그 저장본이 없어요' }, 404);
        const old = pj(b.data); if (!old) return J({ error: '저장본이 깨져 있어요' }, 500);
        const cur = pj(row.data) || {};
        // merge: 저장본의 물고기·도감·장비를 지금 기록에 더해요 / replace: 그 저장본 상태로 정확히 되돌려요(도감만 지금 것과 합침)
        let d;
        if (body.mode === 'replace') { d = old; d.book = bookUnion(cur.book, old.book); keepOwned(cur, d); }
        else d = legacyMerge(old, cur);
        d.at = now;
        this.bak(uid, row.data, now + 1, 'before-restore', true);
        const rev = (row.rev | 0) + 1;
        this.sql.exec('UPDATE users SET data = ?, updated = ?, rev = ?, sids = ? WHERE id = ?', JSON.stringify(d), now, rev, JSON.stringify([{ s: 'R' + now, r: rev }]), uid);
        return J({ ok: true, rev, sum: saveSum(d) });
      }
      if (op === 'admin-gear') {
        const d = pj(row.data); if (!d) return J({ error: '기록이 없어요' }, 404);
        const before = ownedSum(d);
        const baks = this.sql.exec('SELECT ts, data FROM baks WHERE id = ? ORDER BY ts DESC', uid).toArray();
        let lastFloat = 0, lastReel = 0;
        for (const b of baks) { const o = pj(b.data); if (!o) continue; keepOwned(o, d); const og = o.gs || {}; if (!lastFloat && (og.float | 0)) lastFloat = og.float | 0; if (!lastReel && (og.reel | 0)) lastReel = og.reel | 0; }
        const g = d.gs = d.gs || {};
        if (!(g.float | 0) && lastFloat && (g.floats || []).includes(lastFloat)) g.float = lastFloat;
        if (!(g.reel | 0) && lastReel && (g.reels || []).includes(lastReel)) g.reel = lastReel;
        d.at = now;
        this.bak(uid, row.data, now, 'before-restore', true);
        const rev = (row.rev | 0) + 1;
        this.sql.exec('UPDATE users SET data = ?, updated = ?, rev = ?, sids = ? WHERE id = ?', JSON.stringify(d), now, rev, JSON.stringify([{ s: 'G' + now, r: rev }]), uid);
        return J({ ok: true, rev, before, after: ownedSum(d), baks: baks.length });
      }
      if (op === 'admin-edit') {
        // 가방·수조에서 고른 물고기를 지워요 (잘못 들어온 물고기 정리용). 지우기 직전 상태는 저장본으로 남아요
        const d = pj(row.data); if (!d) return J({ error: '기록이 없어요' }, 404);
        const rm = body.remove || {};
        const rt = new Set(Array.isArray(rm.tank) ? rm.tank.map(String) : []), rb = new Set(Array.isArray(rm.bag) ? rm.bag.map(String) : []);
        if (!rt.size && !rb.size) return J({ error: '지울 물고기를 골라 주세요' }, 400);
        const bt = normItems(d.tank).length, bb = normItems((d.gs || {}).bag).length;
        d.tank = normItems(d.tank).filter(o => !rt.has(ikey(o)));
        d.gs = Object.assign({}, d.gs || {}); d.gs.bag = normItems(d.gs.bag).filter(o => !rb.has(ikey(o)));
        d.at = now;
        this.bak(uid, row.data, now, 'before-restore', true);
        const rev = (row.rev | 0) + 1;
        this.sql.exec('UPDATE users SET data = ?, updated = ?, rev = ?, sids = ? WHERE id = ?', JSON.stringify(d), now, rev, JSON.stringify([{ s: 'E' + now, r: rev }]), uid);
        return J({ ok: true, rev, removed: { tank: bt - d.tank.length, bag: bb - d.gs.bag.length }, sum: saveSum(d) });
      }
      return J({ error: 'not found' }, 404);
    }
    const id = this.who(body.token);
    if (!id) return J({ error: '다시 로그인해 주세요' }, 401);
    if (op === 'load') {
      const row = this.sql.exec('SELECT data, rev, sids, dsid FROM users WHERE id = ?', id).toArray()[0];
      const rev = row ? row.rev | 0 : 0;
      if (Number.isInteger(body.have) && body.have === rev) return J({ ok: true, id, same: true, rev });
      return J({ ok: true, id, data: row ? pj(row.data) : null, rev, sids: (pj(row && row.sids) || []).map(x => x.s), dsid: dsidOut(row && row.dsid) });
    }
    if (op === 'save') {
      let d = body.data;
      if (!d || typeof d !== 'object' || Array.isArray(d)) return J({ error: '잘못된 데이터' }, 400);
      const row = this.sql.exec('SELECT data, rev, sids, dsid FROM users WHERE id = ?', id).toArray()[0];
      if (!row) return J({ error: '다시 로그인해 주세요' }, 401);
      const rev = row.rev | 0, sids = pj(row.sids) || [], old = pj(row.data);
      const conflict = () => J({ conflict: true, rev, data: old, sids: sids.map(x => x.s), dsid: dsidOut(row.dsid) }, 409);
      const tab = typeof body.tab === 'string' && /^[a-z0-9]{6,16}$/.test(body.tab) ? body.tab : '';
      const sid = typeof body.sid === 'string' && /^[a-z0-9]{8,32}$/.test(body.sid) ? body.sid : '';
      if (sid) { const hit = sids.find(x => x.s === sid); if (hit) return hit.r === rev ? J({ ok: true, at: now, rev, dup: true }) : conflict(); }
      if (typeof body.cv === 'string' && body.cv < MIN_CV) return J({ error: '새 버전이 나왔어요. 새로고침하면 저장돼요 (기록은 이 기기에 보관 중)', reload: true }, 426);
      let why = 'save';
      if (Number.isInteger(body.base)) {
        // 내가 마지막으로 받은 기록(base) 뒤에 다른 기기·창이 저장했다면 덮어쓰지 않고 돌려보내요 → 화면에서 합친 뒤 다시 저장
        if (body.base !== rev) return conflict();
      } else if (old) { d = legacyAddNew(old, d, now); why = 'legacy'; }
      if (old) { d.book = bookUnion(old.book, d.book); keepOwned(old, d); } // 도감·산 물건은 절대 줄어들지 않게
      const s = JSON.stringify(d);
      if (s.length > SAVE_MAX) return J({ error: '데이터가 너무 커요' }, 413);
      const drop = fishCount(old) - fishCount(d);
      this.bak(id, row.data, now, drop >= 3 ? 'drop' : why, drop >= 3 || why === 'legacy');
      const nrev = rev + 1;
      sids.push({ s: sid || 'L' + now, r: nrev }); while (sids.length > SID_KEEP) sids.shift();
      let ds = pj(row.dsid) || {};
      if (tab && sid) { ds[tab] = { s: sid, ts: now }; const ks = Object.keys(ds); if (ks.length > DSID_KEEP) { ks.sort((a, b) => ds[a].ts - ds[b].ts); for (const k of ks.slice(0, ks.length - DSID_KEEP)) delete ds[k]; } }
      this.sql.exec('UPDATE users SET data = ?, updated = ?, rev = ?, sids = ?, dsid = ? WHERE id = ?', s, now, nrev, JSON.stringify(sids), JSON.stringify(ds), id);
      return J({ ok: true, at: now, rev: nrev, merged: why === 'legacy' || undefined });
    }
    if (op === 'logout') { this.sql.exec('DELETE FROM sessions WHERE token = ?', body.token); return J({ ok: true }); }
    return J({ error: 'not found' }, 404);
  }
}

let VER_C = null;
export default {
  async fetch(request, env, cctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/hello') {
      return Response.json({ monggeul: true, cap: CAP, accounts: true, board: true, hof: true }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname.startsWith('/api/acct/') || url.pathname.startsWith('/api/board/') || url.pathname.startsWith('/api/hof/')) {
      const isBoard = url.pathname.startsWith('/api/board/'), isHof = url.pathname.startsWith('/api/hof/');
      const op = isBoard ? 'board-' + url.pathname.slice('/api/board/'.length) : isHof ? 'hof-' + url.pathname.slice('/api/hof/'.length) : url.pathname.slice('/api/acct/'.length);
      if (![ 'register', 'login', 'load', 'save', 'logout', 'board-list', 'board-post', 'board-del', 'hof-list', 'hof-submit', 'hof-collect', 'hof-rename', 'hof-legend', 'hof-rare', 'hof-sync', 'admin-user', 'admin-bak', 'admin-restore', 'admin-edit', 'admin-gear', 'admin-gift', 'admin-gifts', 'admin-hofls', 'admin-hofset', 'admin-hoffix'].includes(op)) return J({ error: 'not found' }, 404);
      if (op !== 'board-list' && op !== 'hof-list' && request.method !== 'POST') return J({ error: 'POST only' }, 405);
      if (!env.VAULT) return J({ error: '서버 설정 파일(wrangler.jsonc)에 계정 저장소(VAULT)가 없어요. 새 wrangler.jsonc를 올려 주세요' }, 500);
      try {
        const stub = env.VAULT.get(env.VAULT.idFromName('vault'));
        const headers = new Headers({ 'content-type': 'application/json', 'x-ip': request.headers.get('cf-connecting-ip') || '' });
        const res = await stub.fetch(new Request('https://vault/' + op, { method: 'POST', headers, body: request.method === 'POST' ? await request.text() : '{}' }));
        if (op !== 'hof-legend' && op !== 'hof-rare') return res;
        // ★7 축하: 모든 섬에 바로 알려요 (응답은 기다리지 않아요)
        const j = await res.json().catch(() => ({}));
        if (j && j.fan) {
          const body = JSON.stringify(j.fan);
          const all = [];
          for (let n = 1; n <= MAX_ISLANDS; n++) all.push(env.ISLAND.get(env.ISLAND.idFromName('island-' + n)).fetch('https://island/' + (op === 'hof-rare' ? 'rare' : 'legend'), { method: 'POST', body }).catch(() => {}));
          if (cctx && cctx.waitUntil) cctx.waitUntil(Promise.all(all)); else await Promise.all(all);
        }
        return J({ ok: !!(j && j.ok), lg: j && j.lg || null, fan: op === 'hof-rare' ? (j && j.fan || null) : undefined, error: j && j.error }, res.status);
      } catch (e) {
        return J({ error: '계정 서버 오류: ' + String(e && e.message || e).slice(0, 120) }, 500);
      }
    }
    if (url.pathname === '/api/ver') {
      // 지금 배포된 화면(index.html)의 빌드 번호 — 오래 열어 둔 창에 '새로고침' 안내를 띄우는 데 써요
      const now = Date.now();
      if (!VER_C || now - VER_C.at > 60e3) {
        let b = '';
        try { const r = await env.ASSETS.fetch(new Request(url.origin + '/')); const t = await r.text(); const m = t.match(/name="amollang-build" content="([^"]+)"/); b = m ? m[1] : ''; } catch {}
        VER_C = { at: now, b };
      }
      return Response.json({ b: VER_C.b }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/ws') {
      let n = parseInt(url.searchParams.get('island') || '1', 10);
      if (!Number.isInteger(n) || n < 1 || n > MAX_ISLANDS) n = 1;
      const stub = env.ISLAND.get(env.ISLAND.idFromName('island-' + n));
      return stub.fetch(request);
    }
    // 검색 노출(SEO): 주소가 바뀌어도 자동으로 맞는 robots.txt · sitemap.xml · 대표 주소
    if (url.pathname === '/robots.txt') {
      return new Response(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /ws\n\nUser-agent: Yeti\nAllow: /\nDisallow: /api/\nDisallow: /ws\n\nSitemap: ${url.origin}/sitemap.xml\n`, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
    }
    if (url.pathname === '/sitemap.xml') {
      const day = new Date().toISOString().slice(0, 10);
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${url.origin}/</loc><lastmod>${day}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>\n`, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
    }
    const res = await env.ASSETS.fetch(request);
    if (url.pathname === '/' && res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
      const html = (await res.text()).replaceAll('__ORIGIN__', url.origin);
      const h = new Headers(res.headers); h.delete('content-length'); h.delete('etag');
      return new Response(html, { status: res.status, headers: h });
    }
    return res;
  },
};
