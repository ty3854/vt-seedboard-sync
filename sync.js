// 시딩 현황판(vt-seeding-board) 시트 연동 — GitHub Actions 예약 실행(본체 PC 동기화 프로그램 대체)
// 1) 국내·일본·글로벌 백업 시트에서 캠페인별(시트 대괄호) 리스트업·섭외 완료·업로드 완료 → Firestore campaigns/{id}.f.L·C·U (바뀐 것만)
//    L = 크리에이터 탭 중 진행 ≠ '발송 완료' · C = 발송 탭 행 수 · U = 발송 탭 진행 '포스팅완료' (기존 동기화 값과 대조해 맞춘 기준)
// 2) 권역별 전체 수량 → campaigns/_sync.tot
// 3) 7일차 조회 평균·효율·대괄호 목록 → 호스팅 stats.json (화면 '시트 연동 N분 전' 기준)
const env = (k) => { const v = process.env[k]; if (!v) throw new Error('missing ' + k); return v; };
const SHEETS = { kr: env('SHEET_KR'), jp: env('SHEET_JP'), global: env('SHEET_GL') };
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
(async () => {
  const t0 = Date.now(), now = new Date().toISOString();
  const gt = await token(env('G_CLIENT_ID'), env('G_CLIENT_SECRET'), env('G_REFRESH'));
  const ft = await token(FB_ID, FB_SECRET, env('FB_REFRESH'));
  const H = { Authorization: 'Bearer ' + ft, 'Content-Type': 'application/json' };
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
    if (r === 'kr') {
      const rg2 = ['리스트업 백업!I1:I', '리스트업 백업!M1:M', '리스트업 백업!S1:S'];
      const j2 = await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${rg2.map((x) => 'ranges=' + encodeURIComponent(x)).join('&')}`, { headers: { Authorization: 'Bearer ' + gt } })).json();
      if (!j2.valueRanges) throw new Error('kr listup-backup fail');
      const [bi, bm, bs] = j2.valueRanges.map((x) => (x.values || []).map((v) => (v && v[0]) || ''));
      if (bi[0] !== '진행' || bm[0] !== '섭외 제품' || bs[0] !== '키') throw new Error('리스트업 백업 머리글 위치가 바뀜');
      const n = Math.max(bi.length, bm.length, bs.length) - 1;
      del = Array.from({ length: n }, (_, i) => ({ st: clean(bi[i + 1]), k: key(bm[i + 1]), id: String(bs[i + 1] || '').trim() })).filter((x) => x.id);
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
    const k = String(b.url).replace(/\s+/g, ''), r = SHEETS[c.region] ? c.region : 'kr', d = D[r];
    const lset = new Set(); let lnoid = 0;
    d.cre.forEach((x) => { if (x.k === k && x.st !== '발송완료') { if (x.id) lset.add(x.id); else lnoid++; } });
    d.del.forEach((x) => { if (x.k === k && x.st !== '발송완료') lset.add(x.id); });
    const L = lset.size + lnoid;
    const sh = d.shp.filter((x) => x.k === k);
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
  console.log(JSON.stringify({ campaigns: camps.length, changed, statsC: Object.keys(statsC).length, tot, sec: Math.round((Date.now() - t0) / 1000) }));
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });