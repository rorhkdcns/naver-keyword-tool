require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const { google } = require('googleapis');
const fs = require('fs');

// ── 환경변수 검증 ──────────────────────────────────────────────
const REQUIRED = ['NAVER_API_KEY', 'NAVER_SECRET_KEY', 'NAVER_CUSTOMER_ID', 'GOOGLE_SHEETS_ID', 'GOOGLE_SERVICE_ACCOUNT_FILE'];
for (const key of REQUIRED) {
  if (!process.env[key] || process.env[key].startsWith('여기에')) {
    console.error(`\n❌ 환경변수 미설정: ${key}`);
    console.error('   .env 파일에 실제 값을 입력해주세요.\n');
    process.exit(1);
  }
}

const { NAVER_API_KEY, NAVER_SECRET_KEY, NAVER_CUSTOMER_ID, GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_FILE } = process.env;
const NAVER_BASE = 'https://api.naver.com';

// ── 유틸 ─────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function toDate(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }

function last30Days() {
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - 30);
  return { since: toDate(since), until: toDate(until) };
}

// ── 네이버 API 인증 ───────────────────────────────────────────
// 서명: HMAC-SHA256(secretKey, timestamp.METHOD.path)  — path는 쿼리 제외
function naverHeaders(method, path) {
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha256', NAVER_SECRET_KEY)
    .update(`${ts}.${method.toUpperCase()}.${path}`)
    .digest('base64');
  return {
    'X-API-KEY': NAVER_API_KEY,
    'X-Customer': NAVER_CUSTOMER_ID,
    'X-Timestamp': ts,
    'X-Signature': sig,
    'Content-Type': 'application/json; charset=UTF-8',
  };
}

async function naverGet(path, qs = '') {
  const url = `${NAVER_BASE}${path}${qs ? '?' + qs : ''}`;
  try {
    const res = await axios.get(url, { headers: naverHeaders('GET', path) });
    return res.data;
  } catch (e) {
    const info = e.response ? `HTTP ${e.response.status} — ${JSON.stringify(e.response.data)}` : e.message;
    throw new Error(`Naver GET ${path}: ${info}`);
  }
}

async function naverPost(path, body) {
  try {
    const res = await axios.post(`${NAVER_BASE}${path}`, body, { headers: naverHeaders('POST', path) });
    return res.data;
  } catch (e) {
    const info = e.response ? `HTTP ${e.response.status} — ${JSON.stringify(e.response.data)}` : e.message;
    throw new Error(`Naver POST ${path}: ${info}`);
  }
}

// ── 1. 전체 키워드 수집 ────────────────────────────────────────
async function fetchAllKeywords() {
  log('📋 캠페인 목록 조회 중...');
  const campData = await naverGet('/ncc/campaigns');
  const campaigns = Array.isArray(campData) ? campData : (campData.campaigns ?? []);
  log(`   캠페인 ${campaigns.length}개 발견`);

  const allKeywords = [];

  for (const camp of campaigns) {
    const campId = camp.nccCampaignId;
    log(`   광고그룹 조회: ${camp.name || campId}`);

    const grpData = await naverGet('/ncc/adgroups', `campaignId=${campId}`);
    const groups = Array.isArray(grpData) ? grpData : (grpData.adGroups ?? []);

    for (const grp of groups) {
      await delay(100);
      const kwData = await naverGet('/ncc/keywords', `adgroupId=${grp.nccAdgroupId}`);
      const kws = Array.isArray(kwData) ? kwData : (kwData.keywords ?? []);
      allKeywords.push(...kws);
    }
    await delay(200);
  }

  log(`🔑 키워드 총 ${allKeywords.length}개 수집 완료`);
  return allKeywords;
}

// ── 2. 통계 리포트 (최근 30일, 배치 100개) ──────────────────────
async function fetchStats(kwIds) {
  log('📊 성과 통계 조회 중 (최근 30일)...');
  const { since, until } = last30Days();
  const fields = 'impCnt,clkCnt,convCnt,avgRnk,salesAmt';
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  const statsMap = {};

  for (let i = 0; i < kwIds.length; i += 100) {
    const batch = kwIds.slice(i, i + 100);
    log(`   통계 배치 ${i + 1}–${i + batch.length} / ${kwIds.length}`);
    try {
      const qs = `ids=${encodeURIComponent(batch.join(','))}&fields=${fields}&timeRange=${timeRange}`;
      const res = await axios.get(`${NAVER_BASE}/stats?${qs}`, {
        headers: naverHeaders('GET', '/stats'),
      });
      const rows = res.data?.data ?? (Array.isArray(res.data) ? res.data : []);
      for (const row of rows) {
        statsMap[row.id] = row.stat ?? row;
      }
    } catch (e) {
      const info = e.response ? `HTTP ${e.response.status} — ${JSON.stringify(e.response.data)}` : e.message;
      log(`   ⚠️  통계 배치 실패 (${i + 1}–${i + batch.length}): ${info}`);
    }
    await delay(300);
  }
  return statsMap;
}

// ── 3. 키워드도구 API (검색량·경쟁정도, 배치 100개) ──────────────
async function fetchKeywordTool(keywords) {
  log('🔍 키워드 검색량 조회 중...');
  const toolMap = {};

  for (let i = 0; i < keywords.length; i += 100) {
    const batch = keywords.slice(i, i + 100);
    log(`   검색량 배치 ${i + 1}–${i + batch.length} / ${keywords.length}`);
    try {
      const res = await naverPost('/keywordstool', { showDetail: 1, keywords: batch });
      const list = res.keywordList ?? (Array.isArray(res) ? res : []);
      for (const item of list) {
        const kw = item.relKeyword ?? item.keyword;
        if (kw) toolMap[kw] = item;
      }
    } catch (e) {
      log(`   ⚠️  검색량 배치 실패 (${i + 1}–${i + batch.length}): ${e.message}`);
    }
    await delay(300);
  }
  return toolMap;
}

// ── 4. 진단 로직 ──────────────────────────────────────────────
function diagnose(stats, tool) {
  const total = Number(tool?.monthlyPcQcCnt ?? 0) + Number(tool?.monthlyMobileQcCnt ?? 0);
  const imp   = Number(stats?.impCnt  ?? 0);
  const clk   = Number(stats?.clkCnt  ?? 0);
  const conv  = Number(stats?.convCnt ?? 0);

  if (total <= 100)             return '삭제후보';
  if (total >= 500 && imp < 10) return '입찰가인상후보';
  if (clk >= 5 || conv >= 1)   return '유지';
  return '검토필요';
}

// ── 5. 신규 키워드 후보 발굴 (상위 10개 기준) ──────────────────
async function discoverNewKeywords(top10, existingSet) {
  log('💡 신규 키워드 후보 발굴 중 (상위 10개 기준)...');
  const candidateMap = {};

  for (const item of top10) {
    log(`   관련 키워드 조회: "${item.keyword}"`);
    try {
      const res = await naverPost('/keywordstool', { showDetail: 1, keywords: [item.keyword] });
      const list = res.keywordList ?? [];
      for (const r of list) {
        const kw = r.relKeyword ?? r.keyword;
        if (kw && !existingSet.has(kw) && !candidateMap[kw]) {
          candidateMap[kw] = r;
        }
      }
    } catch (e) {
      log(`   ⚠️  "${item.keyword}" 관련 키워드 실패: ${e.message}`);
    }
    await delay(200);
  }
  return Object.values(candidateMap);
}

// ── 6. Google Sheets 헬퍼 ─────────────────────────────────────
async function getSheets() {
  log('🔗 Google Sheets 연결 중...');
  if (!fs.existsSync(GOOGLE_SERVICE_ACCOUNT_FILE)) {
    throw new Error(`서비스 계정 파일을 찾을 수 없습니다: ${GOOGLE_SERVICE_ACCOUNT_FILE}`);
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function ensureTab(sheets, id, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
  const exists = meta.data.sheets.some(s => s.properties.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: id,
      resource: { requests: [{ addSheet: { properties: { title } } }] },
    });
    log(`   탭 생성: "${title}"`);
  }
}

// 7. 기존 데이터 삭제 후 최신 데이터로 덮어쓰기
async function writeTab(sheets, id, title, rows) {
  await sheets.spreadsheets.values.clear({ spreadsheetId: id, range: `${title}!A1:Z200000` });
  if (rows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: id,
      range: `${title}!A1`,
      valueInputOption: 'RAW',
      resource: { values: rows },
    });
  }
  log(`✅ "${title}" 탭 완료 — 데이터 ${rows.length - 1}행`);
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  console.log('\n========================================');
  console.log('  네이버 키워드광고 진단 도구');
  console.log(`  실행: ${new Date().toLocaleString('ko-KR')}`);
  console.log('========================================\n');

  // 1. 전체 키워드 수집
  const keywords = await fetchAllKeywords();
  if (keywords.length === 0) {
    log('⚠️  키워드가 없습니다. 계정 상태를 확인해주세요.');
    return;
  }

  // 2. 성과 통계
  const kwIds = keywords.map(k => k.nccKeywordId).filter(Boolean);
  const statsMap = await fetchStats(kwIds);

  // 3. 검색량·경쟁정도
  const kwTexts = [...new Set(keywords.map(k => k.keyword).filter(Boolean))];
  const toolMap = await fetchKeywordTool(kwTexts);

  // 4. 진단
  log('🏥 키워드 진단 적용 중...');
  const diagnosed = keywords.map((kw, i) => {
    const stats = statsMap[kw.nccKeywordId] ?? {};
    const tool  = toolMap[kw.keyword] ?? {};
    return {
      idx:          i + 1,
      keyword:      kw.keyword ?? '',
      impCnt:       Number(stats.impCnt  ?? 0),
      clkCnt:       Number(stats.clkCnt  ?? 0),
      convCnt:      Number(stats.convCnt ?? 0),
      avgRnk:       Number(stats.avgRnk  ?? 0),
      bidAmt:       Number(kw.bidAmt ?? 0),
      pcSearch:     Number(tool.monthlyPcQcCnt     ?? 0),
      mobileSearch: Number(tool.monthlyMobileQcCnt ?? 0),
      compIdx:      tool.compIdx ?? '-',
      action:       diagnose(stats, tool),
    };
  });

  // 5. 신규 키워드 후보 발굴
  const existingSet = new Set(kwTexts);
  const top10 = [...diagnosed]
    .sort((a, b) => (b.clkCnt + b.convCnt * 10) - (a.clkCnt + a.convCnt * 10))
    .slice(0, 10);
  const newCandidates = await discoverNewKeywords(top10, existingSet);

  // 6. Google Sheets 기록
  const sheets = await getSheets();
  await ensureTab(sheets, GOOGLE_SHEETS_ID, '기존키워드_진단');
  await ensureTab(sheets, GOOGLE_SHEETS_ID, '신규키워드_후보');

  // ① 기존키워드_진단 탭
  const diagHeaders = ['순번', '키워드', '노출수', '클릭수', '전환수', '평균노출순위', '현재입찰가', '월간검색량_PC', '월간검색량_모바일', '경쟁정도', '추천액션'];
  const diagRows = [
    diagHeaders,
    ...diagnosed.map(d => [
      d.idx, d.keyword,
      d.impCnt, d.clkCnt, d.convCnt,
      d.avgRnk ? d.avgRnk.toFixed(2) : '0.00',
      d.bidAmt, d.pcSearch, d.mobileSearch, d.compIdx, d.action,
    ]),
  ];
  await writeTab(sheets, GOOGLE_SHEETS_ID, '기존키워드_진단', diagRows);

  // ② 신규키워드_후보 탭
  const newHeaders = ['순번', '신규키워드', '월간검색량_PC', '월간검색량_모바일', '경쟁정도'];
  const newRows = [
    newHeaders,
    ...newCandidates.map((item, i) => [
      i + 1,
      item.relKeyword ?? item.keyword ?? '',
      Number(item.monthlyPcQcCnt     ?? 0),
      Number(item.monthlyMobileQcCnt ?? 0),
      item.compIdx ?? '-',
    ]),
  ];
  await writeTab(sheets, GOOGLE_SHEETS_ID, '신규키워드_후보', newRows);

  // 요약 출력
  const counts = {};
  for (const d of diagnosed) counts[d.action] = (counts[d.action] || 0) + 1;

  console.log('\n========================================');
  console.log('  진단 결과 요약');
  console.log('========================================');
  console.log(`  총 키워드       : ${diagnosed.length}개`);
  for (const [action, cnt] of Object.entries(counts)) {
    console.log(`  ${action.padEnd(12)}: ${cnt}개`);
  }
  console.log(`  신규 후보       : ${newCandidates.length}개`);
  console.log('\n✅ Google Sheets 업데이트 완료!');
  console.log(`   https://docs.google.com/spreadsheets/d/${GOOGLE_SHEETS_ID}\n`);
}

main().catch(err => {
  console.error('\n❌ 오류 발생:', err.message);
  if (err.response?.data) {
    console.error('   응답 상세:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
