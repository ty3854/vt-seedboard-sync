// 시딩 현황판(vt-seeding-board) 시트 연동 — GitHub Actions 예약 실행(본체 PC 동기화 프로그램 대체)
// 1) 국내·일본·글로벌 백업 시트에서 캠페인별(시트 대괄호) 리스트업·섭외 완료·업로드 완료 → Firestore campaigns/{id}.f.L·C·U (바뀐 것만)
//    L = 크리에이터 탭 중 진행 ≠ '발송 완료' · C = 발송 탭 행 수 · U = 발송 탭 진행 '포스팅완료' (기존 동기화 값과 대조해 맞춘 기준)
// 2) 권역별 전체 수량 → campaigns/_sync.tot
// 3) 7일차 조회 평균·효율·대괄호 목록 → 호스팅 stats.json (화면 '시트 연동 N분 전' 기준)
const env = (k) => { const v = process.env[k]; if (!v) throw new Error('missing ' + k); return v; };
const SHEETS = { kr: env('SHEET_KR'), kf: env('SHEET_KF'), jp: env('SHEET_JP'), global: env('SHEET_GL') };
const FREE = env('SHEET_FREE'); // 국내_자유시트 (문안&가이드 탭 = 국내 캠페인 목록)
const SRC = { kr: ['kr', 'kf'] }; // 국내 캠페인 수량 = 국내 시트 + 재한외국인 시트
const FB_ID = env('FB_CLIENT_ID'), FB_SECRET = env('FB_CLIENT_SECRET');
const FS = 'https://firestore.googleapis.com/v1/projects/vt-guides-fa7e7/databases/seedboard/documents';
const HOST = 'https://firebasehosting.googleapis.com/v1beta1', SITE = 'sites/vt-seeding-board';
const zlib = require('zlib'), crypto = require('crypto');
async function token(id, secret, refresh) {
  const r = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }) })).json();
  if (!r.access_token) throw new Error('token fail ' + (r.error || '')); return r.access_token;
}
const key = (t) => { const m = String(t || '').trim().match(/^(\s*\[[^\]]*\])+/); return m ? m[0].replace(/\s+/g, '') : ''; };
const clean = (s) => String(s || '').replace(/\s/g, '');
const val = (v) => v == null ? null : v.stringValue ?? (v.integerValue != null ? +v.integerValue : null) ?? v.booleanValue ?? v.timestampValue ?? (v.mapValue ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, val(x)])) : null) ?? (v.arrayValue ? (v.arrayValue.values || []).map(val) : null);

// 국내_자유시트 '문안&가이드' → 국내 캠페인 목록 (상태 A·담당자 C·구성 D·가이드 링크 H)
//  · 처음 본 캠페인은 기준값(shv)만 저장 → 이후 시트 값이 바뀐 칸만 사이트에 반영(사이트에서 고친 값은 시트가 바뀌기 전까지 유지)
//  · 상태 '종료' = 완료(맨 아래로) · 메인/스팟성 행 중 사이트에 없는 구성은 새 캠페인으로 추가
const nk = (x) => String(x || '').replace(/\s+/g, ' ').trim();
const nu = (u) => u.replace(/[#?].*$/, '').replace(/\/$/, '');
const urlsOf = (x) => [...new Set(String(x || '').match(/https?:\/\/[^\s,]+/g) || [])];
const enc = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : v instanceof Date ? { timestampValue: v.toISOString() } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([a, b]) => [a, enc(b)])) } };
async function syncFree(gt, H, now) {
  const j = await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${FREE}/values/${encodeURIComponent("'문안&가이드'!A1:I")}`, { headers: { Authorization: 'Bearer ' + gt } })).json();
  const rows = j.values; if (!rows) throw new Error('free sheet fail ' + ((j.error && j.error.status) || ''));
  const h = rows[0]; if (h[0] !== '상태' || h[2] !== '담당자' || h[3] !== '구성' || h[7] !== '가이드 링크') throw new Error('자유시트 머리글 위치가 바뀜 ' + h.join('/'));
  const SR = rows.slice(1).map((r) => ({ st: nk(r[0]), own: nk(r[2]), comp: nk(r[3]), urls: urlsOf(r[7]), concept: nk(r[8]) })).filter((x) => ['메인', '스팟성', '종료'].includes(x.st) && (x.comp || x.urls.length));
  const cj = await (await fetch(`${FS}/campaigns?pageSize=300`, { headers: H })).json();
  const kr = (cj.documents || []).map((d) => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([a, b]) => [a, val(b)])) })).filter((c) => c.id !== '_sync' && (c.region || 'kr') === 'kr');
  const link = (c, g) => (c.links || []).filter((l) => l && l.g === g).map((l) => String(l.url || ''));
  const used = new Set(); let created = 0, updated = 0, base = 0;
  const shvOf = (x) => JSON.stringify({ st: x.st, own: x.own, comp: x.comp, urls: x.urls });
  for (const x of SR) {
    let c = x.comp && kr.find((c) => !used.has(c.id) && link(c, 's').some((s) => nk(s) === x.comp));
    if (!c && x.urls.length) c = kr.find((c) => !used.has(c.id) && link(c, 'g').some((u) => x.urls.some((v) => nu(v) === nu(u))));
    if (!c && x.comp) { const k = key(x.comp); const m = k ? kr.filter((c) => !used.has(c.id) && link(c, 'b').some((b) => b.replace(/\s+/g, '') === k)) : []; if (m.length === 1 && SR.filter((y) => key(y.comp) === k).length === 1) c = m[0]; }
    if (c) {
      used.add(c.id); const sv = shvOf(x); if (c.shv === sv) continue;
      const upd = { shv: sv }; let prev = null; try { prev = c.shv ? JSON.parse(c.shv) : null; } catch (e) {}
      if (!prev) { if (x.st === '종료' && c.stat !== 'done') upd.stat = 'done'; base++; }
      else {
        if (prev.st !== x.st) { if (x.st === '종료') upd.stat = 'done'; else { upd.team = x.st === '메인' ? 'main' : 'spot'; if (c.stat === 'done') upd.stat = 'prog'; } }
        if (prev.own !== x.own) upd.owner = x.own;
        if (prev.comp !== x.comp && x.comp) { upd.prod = x.comp.replace(/^(\s*\[[^\]]*\])+\s*/, '') || c.prod || ''; upd.links = (c.links || []).filter((l) => l.g !== 's').concat([{ g: 's', url: x.comp }]); }
        if (prev.urls.join() !== x.urls.join()) upd.links = (upd.links || c.links || []).filter((l) => l.g !== 'g').concat(x.urls.map((u) => ({ g: 'g', url: u })));
        upd.updatedAt = new Date(now); upd.updatedBy = 'sync:kr-자유시트'; updated++;
      }
      const qs = Object.keys(upd).map((k) => 'updateMask.fieldPaths=' + k).join('&');
      const res = await fetch(`${FS}/campaigns/${c.id}?${qs}&currentDocument.exists=true`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(upd).map(([a, b]) => [a, enc(b)])) }) });
      if (!res.ok) throw new Error('free update fail ' + c.id + ' ' + res.status);
      continue;
    }
    if (x.st === '종료' || !key(x.comp)) continue; // 끝난 행·대괄호 없는 행은 새로 만들지 않음
    const id = 'krf' + crypto.createHash('sha1').update(x.comp).digest('hex').slice(0, 10);
    const name = (x.comp.match(/^(\s*\[[^\]]*\])+/)[0].match(/\[([^\]]*)\]/g) || []).map((t) => t.slice(1, -1).trim()).filter((t) => t && t !== '스팟').join(' · ');
    const doc = { name: name || key(x.comp), prod: x.comp.replace(/^(\s*\[[^\]]*\])+\s*/, ''), region: 'kr', team: x.st === '메인' ? 'main' : 'spot', owner: x.own, stat: 'prog', sch: '미정', ch: '', apply: '', concept: /https?:/.test(x.concept) ? '' : x.concept.slice(0, 120), reqBy: '', sample: false, codes: [],
      links: [{ g: 'b', url: key(x.comp) }, { g: 's', url: x.comp }].concat(x.urls.map((u) => ({ g: 'g', url: u }))), f: { G: 0, L: 0, O: 0, R: 0, C: 0, S: 0, U: 0 }, order: Date.parse(now) + created, createdAt: new Date(now), updatedAt: new Date(now), createdBy: 'sync:kr-자유시트', updatedBy: 'sync:kr-자유시트', shv: shvOf(x) };
    const res = await fetch(`${FS}/campaigns?documentId=${id}`, { method: 'POST', headers: H, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(doc).map(([a, b]) => [a, enc(b)])) }) });
    if (res.status === 409) continue; if (!res.ok) throw new Error('free create fail ' + res.status + ' ' + (await res.text()).slice(0, 200));
    created++;
  }
  return { rows: SR.length, created, updated, base };
}
(async () => {
  const t0 = Date.now(), now = new Date().toISOString();
  const gt = await token(env('G_CLIENT_ID'), env('G_CLIENT_SECRET'), env('G_REFRESH'));
  const ft = await token(FB_ID, FB_SECRET, env('FB_REFRESH'));
  const H = { Authorization: 'Bearer ' + ft, 'Content-Type': 'application/json' };
  const freeRes = await syncFree(gt, H, now);
  // 시트 읽기 (필요한 열만)
  const D = {};
  for (const [r, id] of Object.entries(SHEETS)) {
    const rg = ['크리에이터!D1:D', '크리에이터!P1:P', '발송!G1:G', '발송!S1:S', '발송!AC1:AC', '크리에이터!A1:A'];
    const j = await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${rg.map((x) => 'ranges=' + encodeURIComponent(x)).join('&')}`, { headers: { Authorization: 'Bearer ' + gt } })).json();
    if (!j.valueRanges) throw new Error(r + ' sheet fail ' + ((j.error && j.error.status) || 'unknown'));
    const [cp, cq, sg, ss, sac, ca] = j.valueRanges.map((x) => (x.values || []).map((v) => (v && v[0]) || ''));
    if (cp[0] !== '진행' || cq[0] !== '섭외 제품' || sg[0] !== '섭외 제품' || ss[0] !== '진행' || sac[0] !== '7일차 조회수') throw new Error(r + ' 머리글 위치가 바뀜: ' + [cp[0], cq[0], sg[0], ss[0], sac[0]].join('/'));
    const nC = Math.max(cp.length, cq.length) - 1, nS = Math.max(sg.length, ss.length, sac.length) - 1;
    const cre = Array.from({ length: nC }, (_, i) => ({ st: clean(cp[i + 1]), k: key(cq[i + 1]), id: String(ca[i + 1] || '').trim() }));
    const shp = Array.from({ length: nS }, (_, i) => ({ k: key(sg[i + 1]), st: clean(ss[i + 1]), v7: parseInt(String(sac[i + 1] || '').replace(/[^\d]/g, ''), 10) }));
    let del = [];
    if (r === 'kr' || r === 'kf') {
      const rg2 = ['리스트업 백업!I1:I', '리스트업 백업!M1:M', '리스트업 백업!S1:S'];
      const j2 = await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${rg2.map((x) => 'ranges=' + encodeURIComponent(x)).join('&')}`, { headers: { Authorization: 'Bearer ' + gt } })).json();
      if (!j2.valueRanges && r === 'kr') throw new Error(r + ' listup-backup fail');
      if (j2.valueRanges) {
      const [bi, bm, bs] = j2.valueRanges.map((x) => (x.values || []).map((v) => (v && v[0]) || ''));
      if ((bi[0] || bm[0] || bs[0]) && (bi[0] !== '진행' || bm[0] !== '섭외 제품' || bs[0] !== '키')) throw new Error(r + ' 리스트업 백업 머리글 위치가 바뀜');
      const n = Math.max(bi.length, bm.length, bs.length) - 1;
      del = Array.from({ length: n }, (_, i) => ({ st: clean(bi[i + 1]), k: key(bm[i + 1]), id: String(bs[i + 1] || '').trim() })).filter((x) => x.id);
      }
    }
    // 크리에이터 탭 A열(키)도 같이 읽어 중복 제거용으로 씀
    D[r] = { cre: cre.filter((x) => x.k || x.st), shp, del };
  }
  // 캠페인 읽기
  let docs = [], pt = '';
  do { const r = await (await fetch(`${FS}/campaigns?pageSize=300${pt ? '&pageToken=' + pt : ''}`, { headers: H })).json(); docs.push(...(r.documents || [])); pt = r.nextPageToken; } while (pt);
  const camps = docs.map((d) => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, val(v)])) })).filter((c) => c.id !== '_sync');
  // 권역별 전체·평균
  const regions = {}, tot = { at: now };
  for (const r of Object.keys(SHEETS)) {
    const v = D[r].shp.map((x) => x.v7).filter((x) => Number.isFinite(x));
    const cnt = {}; [...D[r].shp, ...D[r].cre].forEach((x) => { if (x.k) cnt[x.k] = (cnt[x.k] || 0) + 1; });
    regions[r] = { all: { n: v.length, avg: v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0 }, br: Object.entries(cnt).sort((a, b) => b[1] - a[1]).map((x) => x[0]) };
    const liveIds = new Set(D[r].cre.map((x) => x.id).filter(Boolean)); const delIds = new Set(D[r].del.filter((x) => !liveIds.has(x.id)).map((x) => x.id));
    tot[r] = { L: D[r].cre.filter((x) => x.st || x.k).length + delIds.size, C: D[r].shp.filter((x) => x.k || x.st).length, U: D[r].shp.filter((x) => x.st === '포스팅완료').length };
  }
  // 캠페인별 계산·쓰기(바뀐 것만)
  const statsC = {}; let changed = 0;
  for (const c of camps) {
    const b = (c.links || []).find((l) => l && l.g === 'b'); if (!b || !b.url) continue;
    const k = String(b.url).replace(/\s+/g, ''), r = ['kr', 'jp', 'global'].includes(c.region) ? c.region : 'kr', ds = (SRC[r] || [r]).map((x) => D[x]);
    const lset = new Set(); let lnoid = 0, sh = [];
    for (const d of ds) {
      d.cre.forEach((x) => { if (x.k === k && x.st !== '발송완료') { if (x.id) lset.add(x.id); else lnoid++; } });
      d.del.forEach((x) => { if (x.k === k && x.st !== '발송완료') lset.add(x.id); });
      sh = sh.concat(d.shp.filter((x) => x.k === k));
    }
    const L = lset.size + lnoid;
    const C = sh.length, U = sh.filter((x) => x.st === '포스팅완료').length;
    const v = sh.map((x) => x.v7).filter((x) => Number.isFinite(x));
    if (v.length) { const avg = Math.round(v.reduce((a, x) => a + x, 0) / v.length); statsC[c.id] = { key: k, n: v.length, avg, eff: regions[r].all.avg ? Math.round(avg / regions[r].all.avg * 100) : null }; }
    const f = c.f || {};
    if (+f.L === L && +f.C === C && +f.U === U) continue;
    const num = (x) => ({ integerValue: String(x) });
    const res = await fetch(`${FS}/campaigns/${c.id}?updateMask.fieldPaths=f.L&updateMask.fieldPaths=f.C&updateMask.fieldPaths=f.U&currentDocument.exists=true`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { f: { mapValue: { fields: { L: num(L), C: num(C), U: num(U) } } } } }) });
    if (!res.ok) throw new Error('campaign write fail ' + c.id + ' ' + res.status); changed++;
  }
  // _sync.tot
  const n2 = (x) => ({ integerValue: String(x) }); const tf = { at: { timestampValue: now } };
  for (const r of Object.keys(SHEETS)) tf[r] = { mapValue: { fields: { L: n2(tot[r].L), C: n2(tot[r].C), U: n2(tot[r].U) } } };
  const r2 = await fetch(`${FS}/campaigns/_sync?updateMask.fieldPaths=tot&currentDocument.exists=true`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { tot: { mapValue: { fields: tf } } } }) });
  if (!r2.ok) throw new Error('_sync write fail ' + r2.status);
  // stats.json → 호스팅(최신 버전 복제 후 stats.json 만 교체)
  const syncAt = new Date().toISOString();
  const stats = { updatedAt: syncAt, source: '시딩 시트(국내·일본·글로벌) 2. 발송 탭 7일차 조회수, 공란 제외', regions, c: statsC, sync: { at: syncAt, ok: true, error: '', login: false, added: 0, done: 0, by: 'github-actions' } };
  const api = async (m, p, j) => { const r = await fetch(p.startsWith('http') ? p : `${HOST}/${p}`, { method: m, headers: H, body: j === undefined ? undefined : JSON.stringify(j) }); const tx = await r.text(); if (!r.ok) throw new Error(m + ' ' + p + ' ' + r.status + ' ' + tx.slice(0, 200)); return tx ? JSON.parse(tx) : {}; };
  const rel = (await api('GET', `${SITE}/channels/live/releases?pageSize=1`)).releases[0];
  let op = await api('POST', `${SITE}/versions:clone`, { sourceVersion: rel.version.name, finalize: false });
  for (let i = 0; !op.done && i < 60; i++) { await new Promise((s) => setTimeout(s, 1500)); op = await api('GET', op.name); }
  if (!op.done || op.error) throw new Error('clone fail');
  const ver = op.response.name;
  let files = [], fp = ''; do { const j = await api('GET', `${rel.version.name}/files?pageSize=1000${fp ? '&pageToken=' + fp : ''}`); files.push(...(j.files || [])); fp = j.nextPageToken; } while (fp);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(stats)), { level: 9 }), h = crypto.createHash('sha256').update(gz).digest('hex');
  const keep = Object.fromEntries(files.filter((f) => !f.path.startsWith('/__/')).map((f) => [f.path, f.hash])); keep['/stats.json'] = h;
  const pop = await api('POST', `${ver}:populateFiles`, { files: keep });
  if ((pop.uploadRequiredHashes || []).includes(h)) { const u = await fetch(`${pop.uploadUrl}/${h}`, { method: 'POST', headers: { Authorization: 'Bearer ' + ft, 'Content-Type': 'application/octet-stream' }, body: gz }); if (!u.ok) throw new Error('upload fail ' + u.status); }
  await api('PATCH', `${ver}?update_mask=status`, { status: 'FINALIZED' });
  await api('POST', `${SITE}/releases?versionName=${encodeURIComponent(ver)}`, { message: 'auto sheet sync' });
  console.log(JSON.stringify({ free: freeRes, campaigns: camps.length, changed, statsC: Object.keys(statsC).length, tot, sec: Math.round((Date.now() - t0) / 1000) }));
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });