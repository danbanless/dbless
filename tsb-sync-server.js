// TSB 실제 동기화 서버 — 각 PC에서 이 서버를 실행하면, 위젯이 localStorage 대신
// 공유폴더의 JSON 파일을 직접 읽고 쓴다. 여러 PC가 동시에 접근해도 데이터가
// 유실되지 않도록 락 파일(mutex)로 읽기-수정-쓰기 구간을 보호한다.
//
// 실행: node tsb-sync-server.js
// 브라우저: http://localhost:4747/팀스케쥴보드.html

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 4747;
const NETWORK_DIR = '\\\\172.26.15.121\\03. Leadership\\TSB_프로토타입';
const LOCAL_FALLBACK_DIR = path.join(__dirname, 'tsb_local_data');
// 사내망(공유폴더)에 접근 가능하면 그걸 쓰고, 안되면(집 등 사외망) 로컬 폴더로 자동 폴백 —
// 재택에서도 UI 작업을 계속할 수 있도록. 사내망 복귀 시 자동으로 다시 공유폴더를 씀.
let SHARE_DIR;
try {
  fs.accessSync(NETWORK_DIR, fs.constants.R_OK | fs.constants.W_OK);
  SHARE_DIR = NETWORK_DIR;
} catch (e) {
  SHARE_DIR = LOCAL_FALLBACK_DIR;
  if (!fs.existsSync(LOCAL_FALLBACK_DIR)) fs.mkdirSync(LOCAL_FALLBACK_DIR, { recursive: true });
}
const EVENTS_FILE = path.join(SHARE_DIR, 'TSB_events.json');
const ROSTER_FILE = path.join(SHARE_DIR, 'TSB_roster.json');
const LOCK_FILE = path.join(SHARE_DIR, 'TSB_data.lock');

// ── 공휴일 (한국천문연구원 특일정보 API) ── 키는 git에 커밋되지 않는 로컬 설정 파일에만 둔다
const CONFIG_FILE = path.join(__dirname, 'tsb-config.local.json');
let CONFIG = {};
try { CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
catch (e) { console.warn(`(참고) ${CONFIG_FILE} 이 없어 공휴일 API는 비활성 상태입니다.`); }
const KASI_API_KEY = CONFIG.kasiApiKey || '';
const holidayCache = new Map(); // year(number) -> { 'YYYY-MM-DD': '명칭' }

const DEFAULT_ROSTER = {
  leader: '김팀장',
  members: [
    { name: '김팀장', email: '', isAdmin: false },
    { name: '홍길동', email: '', isAdmin: true },
    { name: '이순신', email: '', isAdmin: false },
    { name: '박서준', email: '', isAdmin: false },
    { name: '최유리', email: '', isAdmin: false },
  ]
};

function toStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function mondayOf(d) {
  const date = new Date(d); const day = date.getDay();
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
  return date;
}
function seedEvents() {
  const wk = [0,1,2,3].map(i => { const d = new Date(mondayOf(new Date())); d.setDate(d.getDate()+i); return toStr(d); });
  return [
    { id: 'seed1', type: 'meeting', title: '경영진 보고', date: wk[1], start: '14:00', end: '15:00',
      location: '3층 회의실 B', attendees: ['김팀장', '홍길동'], createdBy: '홍길동', updatedAt: new Date().toISOString() },
    { id: 'seed2', type: 'training', title: '수출통제 실무 교육 (1일차)', date: wk[2], start: '09:00', end: '12:00',
      location: '교육장 A', attendees: ['김팀장','홍길동','이순신','박서준','최유리'], createdBy: '이순신', updatedAt: new Date().toISOString() },
    { id: 'seed3', type: 'etc', title: '팀 회식 장소 예약 확인', date: wk[3], start: '11:00', end: '11:30',
      location: '', attendees: ['박서준'], createdBy: '박서준', updatedAt: new Date().toISOString() },
  ];
}

// ── 락 파일: 읽기+수정+쓰기 전체 구간을 원자적으로 보호 (실측 검증된 방식) ──
function acquireLock(maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.closeSync(fd);
      return true;
    } catch (e) {
      const s = Date.now();
      while (Date.now() - s < 50) {}
    }
  }
  return false;
}
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch (e) {} }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }

function withLock(fn) {
  if (!acquireLock()) throw new Error('락 획득 실패 (5초 타임아웃) — 다른 사용자가 저장 중일 수 있습니다. 잠시 후 다시 시도하세요.');
  try { return fn(); } finally { releaseLock(); }
}

async function fetchHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  if (!KASI_API_KEY) throw new Error('공휴일 API 키가 설정되지 않았습니다 (tsb-config.local.json 확인)');

  const url = `https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo`
    + `?serviceKey=${KASI_API_KEY}&solYear=${year}&numOfRows=100&_type=json`;
  const res = await fetch(url);
  const data = await res.json();
  const items = data?.response?.body?.items?.item;
  const list = Array.isArray(items) ? items : (items ? [items] : []);

  const map = {};
  list.forEach(it => {
    const s = String(it.locdate);
    const dateStr = `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
    map[dateStr] = it.dateName;
  });
  holidayCache.set(year, map);
  return map;
}

function getState() {
  const events = readJson(EVENTS_FILE, null);
  const roster = readJson(ROSTER_FILE, null);
  if (events === null) writeJson(EVENTS_FILE, seedEvents());
  if (roster === null) writeJson(ROSTER_FILE, DEFAULT_ROSTER);
  return {
    events: events === null ? seedEvents() : events,
    roster: roster === null ? DEFAULT_ROSTER : roster,
  };
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); } });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  try {
  const url = req.url.split('?')[0];

  // ── 정적 파일: 로컬 프로젝트 폴더(__dirname)의 위젯 HTML/CSS를 그대로 서빙 ──
  // (데이터 파일만 SHARE_DIR — 공유폴더 또는 로컬 폴백 — 을 쓴다. 수정 후 공유폴더에 복사할 필요 없이 바로 새로고침하면 반영됨)
  if (req.method === 'GET' && !url.startsWith('/api/')) {
    let rel;
    try { rel = decodeURIComponent(url === '/' ? '/팀스케쥴보드.html' : url); }
    catch (e) { res.writeHead(400); res.end('Bad request'); return; }
    const filePath = path.join(__dirname, rel);
    if (filePath.startsWith(__dirname) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404); res.end('Not found: ' + rel);
    }
    return;
  }

    if (url === '/api/state' && req.method === 'GET') {
      return send(res, 200, getState());
    }

    if (url === '/api/holidays' && req.method === 'GET') {
      const year = Number(new URL(req.url, 'http://x').searchParams.get('year')) || new Date().getFullYear();
      try {
        const holidays = await fetchHolidays(year);
        return send(res, 200, { ok: true, year, holidays });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, holidays: {} });
      }
    }

    if (url === '/api/event/upsert' && req.method === 'POST') {
      const { event } = await readBody(req);
      const result = withLock(() => {
        const events = readJson(EVENTS_FILE, []);
        const idx = events.findIndex(e => e.id === event.id);
        if (idx >= 0) events[idx] = event; else events.push(event);
        writeJson(EVENTS_FILE, events);
        return events;
      });
      return send(res, 200, { ok: true, events: result });
    }

    if (url === '/api/event/delete' && req.method === 'POST') {
      const { id } = await readBody(req);
      const result = withLock(() => {
        const events = readJson(EVENTS_FILE, []).filter(e => e.id !== id);
        writeJson(EVENTS_FILE, events);
        return events;
      });
      return send(res, 200, { ok: true, events: result });
    }

    if (url === '/api/roster/mutate' && req.method === 'POST') {
      // op: addMember | updateMember(oldName,name,email) | setLeader(name) | setAdmin(name) | removeMember(name)
      const { op, payload } = await readBody(req);
      const result = withLock(() => {
        const roster = readJson(ROSTER_FILE, DEFAULT_ROSTER);
        let events = readJson(EVENTS_FILE, []);
        if (op === 'addMember') {
          if (!roster.members.some(m => m.name === payload.name)) {
            roster.members.push({ name: payload.name, email: '', isAdmin: false });
          }
        } else if (op === 'updateMember') {
          const m = roster.members.find(m => m.name === payload.oldName);
          if (m) {
            const oldName = m.name;
            if (payload.name && payload.name !== oldName) {
              m.name = payload.name;
              if (roster.leader === oldName) roster.leader = payload.name;
              events = events.map(ev => ({
                ...ev,
                attendees: ev.attendees.map(a => a === oldName ? payload.name : a),
                createdBy: ev.createdBy === oldName ? payload.name : ev.createdBy,
              }));
            }
            if (payload.email !== undefined) m.email = payload.email;
          }
        } else if (op === 'setLeader') {
          roster.leader = payload.name;
        } else if (op === 'setAdmin') {
          roster.members.forEach(m => m.isAdmin = (m.name === payload.name));
        } else if (op === 'removeMember') {
          roster.members = roster.members.filter(m => m.name !== payload.name);
        }
        writeJson(ROSTER_FILE, roster);
        writeJson(EVENTS_FILE, events);
        return { roster, events };
      });
      return send(res, 200, { ok: true, ...result });
    }

    if (url === '/api/restore' && req.method === 'POST') {
      const { roster, events } = await readBody(req);
      const result = withLock(() => {
        writeJson(ROSTER_FILE, roster);
        writeJson(EVENTS_FILE, events);
        return { roster, events };
      });
      return send(res, 200, { ok: true, ...result });
    }

    send(res, 404, { ok: false, error: 'Unknown endpoint' });
  } catch (e) {
    send(res, 500, { ok: false, error: String(e.message || e) });
  }
});

// 예상 못한 요청/오류로 서버 프로세스 전체가 죽지 않도록 하는 최후 안전망
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

server.listen(PORT, () => {
  console.log(`TSB 동기화 서버 실행 중: http://localhost:${PORT}/팀스케쥴보드.html`);
  console.log(`공유 데이터 경로: ${SHARE_DIR}`);
});
