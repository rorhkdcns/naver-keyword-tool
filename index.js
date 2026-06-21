require('dotenv').config();  // 로컬 .env 파일 사용 (CI에서는 무시됨)
const axios   = require('axios');
const crypto  = require('crypto');
const cheerio = require('cheerio');
const { google } = require('googleapis');
const fs = require('fs');

// ════════════════════════════════════════════════════════════
//  환경변수 검증
// ════════════════════════════════════════════════════════════
const REQUIRED = ['NAVER_API_KEY','NAVER_SECRET_KEY','NAVER_CUSTOMER_ID','GOOGLE_SHEETS_ID','GOOGLE_SERVICE_ACCOUNT_FILE'];
for (const key of REQUIRED) {
  if (!process.env[key]?.trim()) {
    console.error(`\n❌ 환경변수 누락: ${key}\n`); process.exit(1);
  }
}

// Google Sheets ID — 전체 URL 입력 시 ID만 추출
const _rawSid = process.env.GOOGLE_SHEETS_ID;
const _sidMatch = _rawSid.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
const GOOGLE_SHEETS_ID = _sidMatch ? _sidMatch[1] : _rawSid;

const { NAVER_API_KEY, NAVER_SECRET_KEY, NAVER_CUSTOMER_ID, GOOGLE_SERVICE_ACCOUNT_FILE } = process.env;
const NAVER_BASE = 'https://api.naver.com';
const RUN_DT    = new Date().toLocaleString('ko-KR');
const RUN_ISO   = new Date().toISOString().replace('T',' ').slice(0,16);

// ════════════════════════════════════════════════════════════
//  유틸리티
// ════════════════════════════════════════════════════════════
const log   = msg => console.log(`[${new Date().toISOString()}] ${msg}`);
const delay = ms  => new Promise(r => setTimeout(r, ms));
const fmt   = d   => d.toISOString().slice(0,10).replace(/-/g,'');
const mask  = (v='') => v.length <= 8 ? '****' : v.slice(0,4)+'****'+v.slice(-4);

function last30Days() {
  const until = new Date(), since = new Date();
  since.setDate(since.getDate() - 30);
  return { since: fmt(since), until: fmt(until) };
}

function extractDomain(url = '') {
  if (!url) return '-';
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./,'');
  } catch {
    return url.split('/')[0].replace(/^www\./,'') || '-';
  }
}

// ════════════════════════════════════════════════════════════
//  경쟁도 점수 / 입찰가 추천
// ════════════════════════════════════════════════════════════
function compScore(compIdx) {
  const s = String(compIdx ?? '').trim().toLowerCase();
  if (s === '높음' || s === 'high')   return 9;
  if (s === '보통' || s === 'medium' || s === '중간') return 6;
  if (s === '낮음' || s === 'low')    return 3;
  const n = parseFloat(s);
  return isNaN(n) ? 5 : Math.min(10, Math.max(0, Math.round(n * 10)));
}

// 경쟁정도에 따라 평균 입찰가에 가중치 적용, 최소 1,000원
function recommendBid(compIdx, avgBid) {
  const s = compScore(compIdx);
  const mult = s >= 8 ? 1.3 : s >= 5 ? 1.0 : 0.7;
  return Math.max(1000, Math.round((avgBid * mult) / 10) * 10);
}

function calcPriority(pcSearch, mobileSearch, compIdx) {
  return (Number(pcSearch) + Number(mobileSearch)) * compScore(compIdx);
}

// ════════════════════════════════════════════════════════════
//  내 계정 입찰가 통계 (평균·중간값)
// ════════════════════════════════════════════════════════════
function calcBidStats(keywords) {
  const bids = keywords.map(k => Number(k.bidAmt ?? 0)).filter(b => b > 0).sort((a,b) => a-b);
  if (!bids.length) return { avgBid: 1000, medianBid: 1000 };
  const avg    = Math.round(bids.reduce((s,b) => s+b, 0) / bids.length);
  const trimmed = bids.length > 2 ? bids.slice(1,-1) : bids;
  const median = Math.round(trimmed[Math.floor(trimmed.length / 2)]);
  return { avgBid: avg, medianBid: median };
}

// ════════════════════════════════════════════════════════════
//  네이버 광고 API 공통
// ════════════════════════════════════════════════════════════
function naverHeaders(method, path) {
  const ts  = Date.now().toString();
  const sig = crypto.createHmac('sha256', NAVER_SECRET_KEY)
    .update(`${ts}.${method.toUpperCase()}.${path}`).digest('base64');
  return {
    'X-API-KEY'  : NAVER_API_KEY,
    'X-Customer' : NAVER_CUSTOMER_ID,
    'X-Timestamp': ts,
    'X-Signature': sig,
    'Content-Type': 'application/json; charset=UTF-8',
  };
}

async function naverGet(path, qs = '') {
  const url = `${NAVER_BASE}${path}${qs ? '?'+qs : ''}`;
  try {
    return (await axios.get(url, { headers: naverHeaders('GET', path) })).data;
  } catch (e) {
    const info = e.response ? `HTTP ${e.response.status} — ${JSON.stringify(e.response.data)}` : e.message;
    throw new Error(`Naver GET ${path}: ${info}`);
  }
}

async function naverPost(path, body) {
  try {
    return (await axios.post(`${NAVER_BASE}${path}`, body, { headers: naverHeaders('POST', path) })).data;
  } catch (e) {
    const info = e.response ? `HTTP ${e.response.status} — ${JSON.stringify(e.response.data)}` : e.message;
    throw new Error(`Naver POST ${path}: ${info}`);
  }
}

// ════════════════════════════════════════════════════════════
//  1. 내 계정 전체 키워드 수집
// ════════════════════════════════════════════════════════════
async function fetchAllKeywords() {
  log('📋 캠페인 목록 조회...');
  const campData  = await naverGet('/ncc/campaigns');
  const campaigns = Array.isArray(campData) ? campData : (campData.campaigns ?? []);
  log(`   캠페인 ${campaigns.length}개`);

  const all = [];
  for (const camp of campaigns) {
    const grpData = await naverGet('/ncc/adgroups', `campaignId=${camp.nccCampaignId}`);
    const groups  = Array.isArray(grpData) ? grpData : (grpData.adGroups ?? []);
    for (const grp of groups) {
      await delay(100);
      const kwData = await naverGet('/ncc/keywords', `nccAdgroupId=${grp.nccAdgroupId}`);
      all.push(...(Array.isArray(kwData) ? kwData : (kwData.keywords ?? [])));
    }
    await delay(150);
  }
  log(`🔑 키워드 총 ${all.length}개`);
  return all;
}

// ════════════════════════════════════════════════════════════
//  2. 최근 30일 성과 통계 (배치 100)
// ════════════════════════════════════════════════════════════
async function fetchStats(kwIds) {
  log('📊 성과 통계 조회 (최근 30일)...');
  const { since, until } = last30Days();
  const fields    = 'impCnt,clkCnt,convCnt,avgRnk,salesAmt';
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  const map = {};

  for (let i = 0; i < kwIds.length; i += 100) {
    const batch = kwIds.slice(i, i+100);
    log(`   통계 ${i+1}–${i+batch.length} / ${kwIds.length}`);
    try {
      const qs  = `ids=${encodeURIComponent(batch.join(','))}&fields=${fields}&timeRange=${timeRange}`;
      const res = await axios.get(`${NAVER_BASE}/stats?${qs}`, { headers: naverHeaders('GET','/stats') });
      for (const row of (res.data?.data ?? [])) map[row.id] = row.stat ?? row;
    } catch (e) {
      const info = e.response ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}` : e.message;
      log(`   ⚠️ 통계 배치 실패: ${info}`);
    }
    await delay(300);
  }
  return map;
}

// ════════════════════════════════════════════════════════════
//  3. 키워드도구 API — 검색량·경쟁도 (배치 100)
// ════════════════════════════════════════════════════════════
async function fetchKeywordTool(keywords) {
  const uniq = [...new Set(keywords.filter(Boolean))];
  if (!uniq.length) return {};
  log(`🔍 키워드도구 조회 (${uniq.length}개)...`);
  const map = {};

  for (let i = 0; i < uniq.length; i += 100) {
    const batch = uniq.slice(i, i+100);
    try {
      const res = await naverPost('/keywordstool', { showDetail:1, keywords: batch });
      for (const item of (res.keywordList ?? [])) {
        const kw = item.relKeyword ?? item.keyword;
        if (kw) map[kw] = item;
      }
    } catch (e) {
      log(`   ⚠️ 키워드도구 배치 ${i+1}–${i+batch.length} 실패: ${e.message}`);
    }
    await delay(300);
  }
  return map;
}

// ════════════════════════════════════════════════════════════
//  4. 진단 로직
// ════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════
//  5. 연관 키워드 수집 (갭 분석 + 신규 후보용)
//     top15 키워드로 키워드도구 개별 호출 → 연관어 수집
// ════════════════════════════════════════════════════════════
async function collectRelatedKeywords(top15, myKeywordSet) {
  log('🔗 연관 키워드 수집 (갭·신규후보 분석용)...');
  const relatedMap = {}; // keyword → { pcSearch, mobileSearch, compIdx }

  for (const kw of top15) {
    try {
      const res = await naverPost('/keywordstool', { showDetail:1, keywords:[kw.keyword] });
      for (const item of (res.keywordList ?? [])) {
        const k = item.relKeyword ?? item.keyword;
        if (k && !myKeywordSet.has(k) && !relatedMap[k]) {
          relatedMap[k] = {
            pcSearch    : Number(item.monthlyPcQcCnt     ?? 0),
            mobileSearch: Number(item.monthlyMobileQcCnt ?? 0),
            compIdx     : item.compIdx ?? '-',
          };
        }
      }
    } catch (e) {
      log(`   ⚠️ "${kw.keyword}" 연관 조회 실패: ${e.message}`);
    }
    await delay(200);
  }
  log(`   연관 키워드 ${Object.keys(relatedMap).length}개 수집`);
  return relatedMap;
}

// ════════════════════════════════════════════════════════════
//  6. 경쟁사 광고 크롤링
// ════════════════════════════════════════════════════════════
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function scrapeNaverAds(keyword) {
  const url = `https://search.naver.com/search.naver?where=nexearch&query=${encodeURIComponent(keyword)}&ie=utf8`;
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent'     : BROWSER_UA,
        'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer'        : 'https://www.naver.com/',
      },
      timeout: 12000,
    });

    const $ = cheerio.load(res.data);
    const ads = [];

    // 네이버 파워링크 광고 영역 — 여러 셀렉터 순서대로 시도
    for (const sel of ['ul.lst_ad > li','#sp_npad ul > li','div[data-nclick-area="pad"] li','.ad_area li']) {
      const items = $(sel);
      if (!items.length) continue;
      items.each((_, el) => {
        const $e = $(el);
        const title = ($e.find('strong.tit, a.lnk_tit strong, .tit_area strong, h3.tit').first().text()
          || $e.find('a[class*="tit"]').first().text()).trim();
        const desc  = $e.find('p.desc, .dsc_area .dsc, .desc_area p').first().text().trim();
        const disp  = $e.find('span.url, .url_area span, cite').first().text().trim();
        if (title || disp) ads.push({ title: title||'(제목없음)', desc, displayUrl: disp, domain: extractDomain(disp) });
      });
      if (ads.length) break;
    }
    if (!ads.length) log(`   ℹ️  "${keyword}" — 광고 없음 (성인인증 차단 가능)`);
    return ads;
  } catch (e) {
    log(`   ⚠️  "${keyword}" 크롤링 실패: ${e.message}`);
    return [];
  }
}

// 상위 15개 키워드 검색 → 경쟁사 도메인 식별 + 광고 수집
async function trackCompetitorAds(top15) {
  log('🕵️  경쟁사 광고 추적 (상위 15개 키워드)...');
  const adRows = [];
  const domainSet = new Set();

  for (const kw of top15) {
    log(`   검색: "${kw.keyword}"`);
    const ads = await scrapeNaverAds(kw.keyword);
    for (const ad of ads) {
      if (ad.domain && ad.domain !== '-') domainSet.add(ad.domain);
      adRows.push({ keyword: kw.keyword, domain: ad.domain, title: ad.title, desc: ad.desc });
    }
    await delay(1500);
  }

  const domains = [...domainSet];
  log(`   식별 경쟁사: ${domains.length > 0 ? domains.join(', ') : '없음'}`);
  return { adRows, competitorDomains: domainSet };
}

// ════════════════════════════════════════════════════════════
//  7. 갭 분석: 경쟁사는 광고, 자신은 없는 키워드
//     연관 키워드 후보 → 네이버 검색 → 경쟁사 등장 여부 확인
// ════════════════════════════════════════════════════════════
async function findGapKeywords(relatedMap, competitorDomains, avgBid) {
  if (!competitorDomains.size) {
    log('⚠️  경쟁사 도메인 미식별 → 갭 분석 건너뜀');
    return [];
  }

  // 검색량 순으로 상위 40개만 검색
  const candidates = Object.entries(relatedMap)
    .map(([kw, d]) => ({ keyword: kw, ...d }))
    .sort((a, b) => (b.pcSearch + b.mobileSearch) - (a.pcSearch + a.mobileSearch))
    .slice(0, 40);

  log(`💡 갭 키워드 탐색 (후보 ${candidates.length}개 검색)...`);
  const gaps = [];

  for (const cand of candidates) {
    const ads = await scrapeNaverAds(cand.keyword);
    const matchedDomains = [...new Set(
      ads.filter(a => competitorDomains.has(a.domain)).map(a => a.domain)
    )];
    if (matchedDomains.length) {
      gaps.push({
        keyword          : cand.keyword,
        pcSearch         : cand.pcSearch,
        mobileSearch     : cand.mobileSearch,
        compIdx          : cand.compIdx,
        priorityScore    : calcPriority(cand.pcSearch, cand.mobileSearch, cand.compIdx),
        recommendedBid   : recommendBid(cand.compIdx, avgBid),
        competitorDomains: matchedDomains.join(', '),
      });
      log(`   ✓ 갭 발견: "${cand.keyword}" ← ${matchedDomains.join(', ')}`);
    }
    await delay(1500);
  }

  return gaps.sort((a, b) => b.priorityScore - a.priorityScore);
}

// ════════════════════════════════════════════════════════════
//  Google Sheets 헬퍼
// ════════════════════════════════════════════════════════════
async function getSheets() {
  let credentials;
  if (fs.existsSync(GOOGLE_SERVICE_ACCOUNT_FILE)) {
    // 로컬: 파일 경로로 사용
    credentials = JSON.parse(fs.readFileSync(GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
  } else {
    // CI(GitHub Actions): base64 디코딩
    try {
      credentials = JSON.parse(Buffer.from(GOOGLE_SERVICE_ACCOUNT_FILE, 'base64').toString('utf8'));
    } catch {
      throw new Error('서비스 계정 정보를 파일 또는 base64로 읽을 수 없습니다.');
    }
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function ensureTab(sheets, sid, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sid });
  if (!meta.data.sheets.some(s => s.properties.title === title)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sid,
      resource: { requests: [{ addSheet: { properties: { title } } }] },
    });
    log(`   탭 생성: "${title}"`);
  }
}

// 데이터 누적: 헤더가 없으면 헤더 먼저 쓰고, 새 데이터 행만 추가
async function appendTab(sheets, sid, title, headerRow, dataRows) {
  let hasHeader = false;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sid,
      range: `${title}!A1:A1`,
    });
    hasHeader = !!(res.data.values ?? []).length;
  } catch {}

  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId   : sid,
      range           : `${title}!A1`,
      valueInputOption: 'RAW',
      resource        : { values: [headerRow] },
    });
  }

  if (dataRows.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId   : sid,
      range           : `${title}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource        : { values: dataRows },
    });
  }
  log(`✅ "${title}" — ${dataRows.length}행 추가 (누적)`);
}

// ════════════════════════════════════════════════════════════
//  Main
// ════════════════════════════════════════════════════════════
async function main() {
  console.log('\n' + '═'.repeat(52));
  console.log('  네이버 키워드광고 진단 + 경쟁사 갭 분석');
  console.log(`  실행: ${RUN_DT}`);
  console.log('═'.repeat(52));
  console.log('\n📁 환경변수 확인:');
  for (const k of ['NAVER_API_KEY','NAVER_SECRET_KEY','NAVER_CUSTOMER_ID'])
    console.log(`   ${k.padEnd(20)}: ${mask(process.env[k])}`);
  console.log(`   ${'GOOGLE_SHEETS_ID'.padEnd(20)}: ${GOOGLE_SHEETS_ID}`);
  const saDisplay = GOOGLE_SERVICE_ACCOUNT_FILE.length > 60 ? '(base64 JSON)' : GOOGLE_SERVICE_ACCOUNT_FILE;
  console.log(`   ${'SERVICE_ACCOUNT'.padEnd(20)}: ${saDisplay}\n`);

  // ── 1. 전체 키워드 수집
  const keywords = await fetchAllKeywords();
  if (!keywords.length) { log('⚠️ 키워드 없음'); return; }

  // ── 2. 성과 통계
  const kwIds    = keywords.map(k => k.nccKeywordId).filter(Boolean);
  const statsMap = await fetchStats(kwIds);

  // ── 3. 내 키워드 검색량·경쟁도
  const myTexts  = [...new Set(keywords.map(k => k.keyword).filter(Boolean))];
  const myToolMap = await fetchKeywordTool(myTexts);

  // ── 4. 내 계정 입찰가 통계
  const { avgBid, medianBid } = calcBidStats(keywords);
  log(`💰 평균 입찰가: ${avgBid.toLocaleString()}원 | 중간값: ${medianBid.toLocaleString()}원`);

  // ── 5. 진단
  log('🏥 키워드 진단...');
  const myKeywordSet = new Set(myTexts);
  const diagnosed    = keywords.map((kw, i) => {
    const stats = statsMap[kw.nccKeywordId] ?? {};
    const tool  = myToolMap[kw.keyword] ?? {};
    return {
      idx: i+1, keyword: kw.keyword ?? '',
      impCnt  : Number(stats.impCnt  ?? 0), clkCnt : Number(stats.clkCnt  ?? 0),
      convCnt : Number(stats.convCnt ?? 0), avgRnk : Number(stats.avgRnk  ?? 0),
      bidAmt  : Number(kw.bidAmt ?? 0),
      pcSearch: Number(tool.monthlyPcQcCnt     ?? 0),
      mobileSearch: Number(tool.monthlyMobileQcCnt ?? 0),
      compIdx : tool.compIdx ?? '-',
      action  : diagnose(stats, tool),
    };
  });

  // 성과 상위 정렬 (클릭수 + 전환수 가중)
  const sorted = [...diagnosed].sort((a,b) => (b.clkCnt + b.convCnt*10) - (a.clkCnt + a.convCnt*10));
  const top15  = sorted.slice(0,15);

  // ── 6. 경쟁사 광고 추적
  const { adRows: competitorAdRows, competitorDomains } = await trackCompetitorAds(top15);

  // ── 5(연관). 연관 키워드 수집 (갭 + 신규 후보 공용)
  const relatedMap = await collectRelatedKeywords(top15, myKeywordSet);

  // ── 7. 갭 분석: 경쟁사는 하는데 나는 없는 키워드
  const gapKeywords  = await findGapKeywords(relatedMap, competitorDomains, avgBid);
  const gapKeywordSet = new Set(gapKeywords.map(g => g.keyword));

  // ── 8. 신규 키워드 후보 (갭 제외, 검색량 순)
  log('🌱 신규 키워드 후보 정리...');
  const newCandidates = Object.entries(relatedMap)
    .filter(([kw]) => !gapKeywordSet.has(kw))
    .map(([kw, d]) => ({
      keyword      : kw,
      pcSearch     : d.pcSearch,
      mobileSearch : d.mobileSearch,
      compIdx      : d.compIdx,
      recommendedBid: recommendBid(d.compIdx, avgBid),
    }))
    .sort((a,b) => (b.pcSearch + b.mobileSearch) - (a.pcSearch + a.mobileSearch));

  // ── 9. Google Sheets 기록 (누적 모드: 기존 데이터 유지, 새 행 추가)
  log('📝 Google Sheets 업데이트 (데이터 누적)...');
  const sheets = await getSheets();
  const TABS   = ['기존키워드_진단','⭐경쟁사는하는데미승인_키워드','신규키워드_후보','경쟁사_광고추적'];
  for (const t of TABS) await ensureTab(sheets, GOOGLE_SHEETS_ID, t);

  // ① 기존키워드_진단
  await appendTab(sheets, GOOGLE_SHEETS_ID, '기존키워드_진단',
    ['수집날짜','순번','키워드','노출수','클릭수','전환수','평균노출순위','현재입찰가','월간검색량_PC','월간검색량_모바일','경쟁정도','추천액션'],
    diagnosed.map(d => [
      RUN_ISO, d.idx, d.keyword, d.impCnt, d.clkCnt, d.convCnt,
      d.avgRnk ? d.avgRnk.toFixed(2) : '0.00',
      d.bidAmt, d.pcSearch, d.mobileSearch, d.compIdx, d.action,
    ])
  );

  // ② ⭐경쟁사는하는데미승인_키워드 (우선순위 높은 순)
  await appendTab(sheets, GOOGLE_SHEETS_ID, '⭐경쟁사는하는데미승인_키워드',
    ['수집날짜','순번','키워드','월간검색량_PC','월간검색량_모바일','경쟁정도','우선순위점수','추천입찰가(원)','광고중인경쟁사도메인들'],
    gapKeywords.map((g, i) => [
      RUN_ISO, i+1, g.keyword, g.pcSearch, g.mobileSearch, g.compIdx,
      g.priorityScore, g.recommendedBid, g.competitorDomains,
    ])
  );

  // ③ 신규키워드_후보
  await appendTab(sheets, GOOGLE_SHEETS_ID, '신규키워드_후보',
    ['수집날짜','순번','신규키워드','월간검색량_PC','월간검색량_모바일','경쟁정도','추천입찰가(원)'],
    newCandidates.map((c, i) => [
      RUN_ISO, i+1, c.keyword, c.pcSearch, c.mobileSearch, c.compIdx, c.recommendedBid,
    ])
  );

  // ④ 경쟁사_광고추적
  await appendTab(sheets, GOOGLE_SHEETS_ID, '경쟁사_광고추적',
    ['수집날짜','순번','검색키워드','경쟁사도메인','광고제목','광고설명'],
    competitorAdRows.map((ad, i) => [
      RUN_ISO, i+1, ad.keyword, ad.domain, ad.title, ad.desc,
    ])
  );

  // ── 완료 요약
  const counts = {};
  for (const d of diagnosed) counts[d.action] = (counts[d.action]||0) + 1;

  console.log('\n' + '═'.repeat(52));
  console.log('  완료 요약');
  console.log('═'.repeat(52));
  console.log(`  총 키워드         : ${diagnosed.length}개`);
  for (const [a,c] of Object.entries(counts))
    console.log(`  ${a.padEnd(14)}: ${c}개`);
  console.log(`  경쟁사 갭 키워드   : ${gapKeywords.length}개`);
  console.log(`  신규 키워드 후보   : ${newCandidates.length}개`);
  console.log(`  경쟁사 광고 수집   : ${competitorAdRows.length}건`);
  console.log('\n✅ Google Sheets 업데이트 완료!');
  console.log(`   https://docs.google.com/spreadsheets/d/${GOOGLE_SHEETS_ID}\n`);
}

main().catch(err => {
  console.error('\n❌ 오류:', err.message);
  if (err.response?.data) console.error('   상세:', JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
