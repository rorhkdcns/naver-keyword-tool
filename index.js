require('dotenv').config();
const axios   = require('axios');
const crypto  = require('crypto');
const { google } = require('googleapis');

// ════════════════════════════════════════════════════════════
//  환경변수 검증
// ════════════════════════════════════════════════════════════
const REQUIRED = ['NAVER_API_KEY','NAVER_SECRET_KEY','NAVER_CUSTOMER_ID','GOOGLE_SHEETS_ID','GOOGLE_SERVICE_ACCOUNT_JSON'];
for (const key of REQUIRED) {
  if (!process.env[key]?.trim()) {
    console.error(`\n❌ 환경변수 누락: ${key}\n`); process.exit(1);
  }
}

const _rawSid   = process.env.GOOGLE_SHEETS_ID;
const _sidMatch = _rawSid.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
const GOOGLE_SHEETS_ID = _sidMatch ? _sidMatch[1] : _rawSid;

const { NAVER_API_KEY, NAVER_SECRET_KEY, NAVER_CUSTOMER_ID } = process.env;
const NAVER_BASE = 'https://api.naver.com';
const RUN_ISO   = new Date().toISOString().replace('T',' ').slice(0,16);

// ════════════════════════════════════════════════════════════
//  유틸리티
// ════════════════════════════════════════════════════════════
const log   = msg => console.log(`[${new Date().toISOString()}] ${msg}`);
const delay = ms  => new Promise(r => setTimeout(r, ms));
const mask  = (v='') => v.length <= 8 ? '****' : v.slice(0,4)+'****'+v.slice(-4);

// ════════════════════════════════════════════════════════════
//  네이버 SA API 인증 헤더 (공식 스펙)
//  Signature = HMAC-SHA256(SECRET_KEY, timestamp + "." + METHOD + "." + uri)
// ════════════════════════════════════════════════════════════
function naverHeaders(method, uri) {
  const timestamp = Date.now().toString();
  const signature = crypto
    .createHmac('sha256', NAVER_SECRET_KEY)
    .update(`${timestamp}.${method.toUpperCase()}.${uri}`)
    .digest('base64');
  return {
    'X-Timestamp' : timestamp,
    'X-API-KEY'   : NAVER_API_KEY,
    'X-Customer'  : NAVER_CUSTOMER_ID,
    'X-Signature' : signature,
    'Content-Type': 'application/json; charset=UTF-8',
  };
}

async function naverGet(uri, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const url = `${NAVER_BASE}${uri}${qs ? '?' + qs : ''}`;
  try {
    log(`   GET ${uri}${qs ? '?' + qs : ''}`);
    const res = await axios.get(url, { headers: naverHeaders('GET', uri) });
    return res.data;
  } catch (e) {
    const detail = e.response
      ? `HTTP ${e.response.status} — ${JSON.stringify(e.response.data)}`
      : e.message;
    throw new Error(`Naver GET ${uri}: ${detail}`);
  }
}

// ════════════════════════════════════════════════════════════
//  캠페인 → 광고그룹 → 키워드 수집 (기본 정보만)
// ════════════════════════════════════════════════════════════
async function fetchAllKeywords() {
  log('📋 캠페인 목록 조회...');
  const campRaw   = await naverGet('/ncc/campaigns');
  const campaigns = Array.isArray(campRaw) ? campRaw : (campRaw.campaigns ?? []);
  log(`   캠페인 ${campaigns.length}개`);

  const all = [];

  for (const camp of campaigns) {
    const campId   = camp.nccCampaignId;
    const campName = camp.campaignName ?? campId;

    const grpRaw = await naverGet('/ncc/adgroups', { campaignId: campId });
    const groups = Array.isArray(grpRaw) ? grpRaw : (grpRaw.adGroups ?? []);
    log(`   캠페인 "${campName}" — 광고그룹 ${groups.length}개`);

    for (const grp of groups) {
      const grpId   = grp.nccAdgroupId;
      const grpName = grp.adGroupName ?? grpId;

      await delay(150);
      const kwRaw = await naverGet('/ncc/keywords', { nccAdgroupId: grpId });
      const kws   = Array.isArray(kwRaw) ? kwRaw : (kwRaw.keywords ?? []);
      log(`     광고그룹 "${grpName}" — 키워드 ${kws.length}개`);

      for (const kw of kws) {
        all.push({
          campaignName : campName,
          adGroupName  : grpName,
          keyword      : kw.keyword ?? '',
          nccKeywordId : kw.nccKeywordId ?? '',
          bidAmt       : Number(kw.bidAmt ?? 0),
          useGroupBid  : kw.useGroupBidAmt ? 'Y' : 'N',
          status       : kw.userLock ? '중지' : '운영중',
          inspectStatus: kw.inspectStatus ?? '-',
        });
      }

      await delay(150);
    }

    await delay(200);
  }

  log(`🔑 키워드 총 ${all.length}개 수집 완료`);
  return all;
}

// ════════════════════════════════════════════════════════════
//  Google Sheets 헬퍼
// ════════════════════════════════════════════════════════════
async function getSheets() {
  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    log('   서비스 계정: JSON 파싱 성공');
  } catch (e) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON 파싱 실패: ${e.message}`);
  }

  if (credentials.private_key) {
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  }

  const auth = await google.auth.fromJSON(credentials);
  auth.scopes = ['https://www.googleapis.com/auth/spreadsheets'];
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

async function appendTab(sheets, sid, title, headerRow, dataRows) {
  let hasHeader = false;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sid,
      range        : `${title}!A1:A1`,
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
  log(`✅ "${title}" — ${dataRows.length}행 추가`);
}

// ════════════════════════════════════════════════════════════
//  Main
// ════════════════════════════════════════════════════════════
async function main() {
  console.log('\n' + '═'.repeat(52));
  console.log('  네이버 키워드광고 키워드 수집 → Google Sheets');
  console.log(`  실행: ${new Date().toLocaleString('ko-KR')}`);
  console.log('═'.repeat(52));

  console.log('\n📁 환경변수 확인:');
  for (const k of ['NAVER_API_KEY','NAVER_SECRET_KEY','NAVER_CUSTOMER_ID'])
    console.log(`   ${k.padEnd(20)}: ${mask(process.env[k])}`);
  console.log(`   ${'GOOGLE_SHEETS_ID'.padEnd(20)}: ${GOOGLE_SHEETS_ID}`);
  console.log(`   ${'SERVICE_ACCOUNT_JSON'.padEnd(20)}: (설정됨)\n`);

  // 1. 키워드 수집
  const keywords = await fetchAllKeywords();
  if (!keywords.length) {
    log('⚠️  수집된 키워드가 없습니다.');
    return;
  }

  // 2. Google Sheets 저장
  log('📝 Google Sheets 업데이트...');
  const sheets = await getSheets();
  const TAB    = '키워드_목록';

  await ensureTab(sheets, GOOGLE_SHEETS_ID, TAB);
  await appendTab(
    sheets, GOOGLE_SHEETS_ID, TAB,
    ['수집날짜','캠페인','광고그룹','키워드','키워드ID','입찰가','그룹입찰가사용','상태','심사상태'],
    keywords.map(k => [
      RUN_ISO,
      k.campaignName,
      k.adGroupName,
      k.keyword,
      k.nccKeywordId,
      k.bidAmt,
      k.useGroupBid,
      k.status,
      k.inspectStatus,
    ])
  );

  console.log('\n' + '═'.repeat(52));
  console.log(`  총 키워드: ${keywords.length}개`);
  console.log('✅ 완료!');
  console.log(`   https://docs.google.com/spreadsheets/d/${GOOGLE_SHEETS_ID}\n`);
}

main().catch(err => {
  console.error('\n❌ 오류:', err.message);
  process.exit(1);
});
