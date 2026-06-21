require('dotenv').config();
const axios  = require('axios');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ════════════════════════════════════════════════════════════
//  환경변수 검증
// ════════════════════════════════════════════════════════════
const REQUIRED = ['NAVER_API_KEY','NAVER_SECRET_KEY','NAVER_CUSTOMER_ID'];
for (const key of REQUIRED) {
  if (!process.env[key]?.trim()) {
    console.error(`\n❌ 환경변수 누락: ${key}\n`); process.exit(1);
  }
}

const { NAVER_API_KEY, NAVER_SECRET_KEY, NAVER_CUSTOMER_ID } = process.env;
const NAVER_BASE = 'https://api.naver.com';

// ════════════════════════════════════════════════════════════
//  유틸리티
// ════════════════════════════════════════════════════════════
const log   = msg => console.log(`[${new Date().toISOString()}] ${msg}`);
const delay = ms  => new Promise(r => setTimeout(r, ms));
const mask  = (v='') => v.length <= 8 ? '****' : v.slice(0,4)+'****'+v.slice(-4);

function dateStamp() {
  return new Date().toISOString().slice(0,10).replace(/-/g,'');
}

function last30Days() {
  const fmt   = d => d.toISOString().slice(0,10).replace(/-/g,'');
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - 30);
  return { since: fmt(since), until: fmt(until) };
}

// CSV 셀 이스케이프: 쉼표·큰따옴표·줄바꿈이 있으면 큰따옴표로 감쌈
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows) {
  return rows.map(row => row.map(csvCell).join(',')).join('\n');
}

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
//  1. 캠페인 → 광고그룹 → 키워드 수집
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
          keyword     : kw.keyword      ?? '',
          campaignName: campName,
          adGroupName : grpName,
          keywordId   : kw.nccKeywordId ?? '',
          bidAmt      : Number(kw.bidAmt ?? 0),
          status      : kw.userLock ? '중지' : '운영중',
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
//  2. 성과 통계 수집 — /stats (최근 30일, 100개 배치)
// ════════════════════════════════════════════════════════════
async function fetchStats(kwIds) {
  if (!kwIds.length) return {};
  log(`📊 성과 통계 조회 (최근 30일, ${kwIds.length}개)...`);

  const { since, until } = last30Days();
  const timeRange = JSON.stringify({ since, until });
  const statMap   = {};

  for (let i = 0; i < kwIds.length; i += 100) {
    const batch = kwIds.slice(i, i + 100);
    log(`   통계 ${i + 1}–${i + batch.length} / ${kwIds.length}`);
    try {
      const params = new URLSearchParams({
        ids      : batch.join(','),
        timeRange: timeRange,
      });
      const res = await axios.get(`${NAVER_BASE}/stats?${params}`, {
        headers: naverHeaders('GET', '/stats'),
      });
      for (const row of (res.data?.data ?? [])) {
        statMap[row.id] = row.stat ?? row;
      }
    } catch (e) {
      const detail = e.response
        ? `HTTP ${e.response.status} — ${JSON.stringify(e.response.data)}`
        : e.message;
      log(`   ⚠️  통계 배치 ${i + 1}–${i + batch.length} 실패: ${detail}`);
    }
    await delay(300);
  }

  const hitCount = Object.keys(statMap).length;
  log(`   통계 수집 완료: ${hitCount}/${kwIds.length}개`);
  return statMap;
}

// ════════════════════════════════════════════════════════════
//  3. 진단 태그 로직
//     impCnt  : 노출수
//     clkCnt  : 클릭수
//     convCnt : 전환수
//     avgRnk  : 평균 노출순위 (낮을수록 상위)
// ════════════════════════════════════════════════════════════
function diagnose(stat, kwStatus) {
  if (kwStatus === '중지') return '중지';

  const imp  = Number(stat?.impCnt  ?? 0);
  const clk  = Number(stat?.clkCnt  ?? 0);
  const conv = Number(stat?.convCnt ?? 0);
  const rnk  = Number(stat?.avgRnk  ?? 0);

  if (imp === 0)                           return '삭제후보';       // 30일간 노출 없음
  if (conv >= 1 || clk >= 5)              return '유지';            // 실적 있음
  if (imp >= 50 && clk === 0)             return '입찰가인상후보';  // 노출되지만 클릭 없음
  if (rnk > 0 && rnk >= 8 && clk === 0)  return '입찰가인상후보';  // 순위 낮아 클릭 없음
  return '검토필요';
}

// ════════════════════════════════════════════════════════════
//  4. CSV 저장
// ════════════════════════════════════════════════════════════
function saveCSV(keywords) {
  const dir      = path.join(__dirname, 'data');
  const filename = `keyword-audit-${dateStamp()}.csv`;
  const filepath = path.join(dir, filename);

  fs.mkdirSync(dir, { recursive: true });

  const header = [
    '키워드','캠페인명','광고그룹명','키워드ID',
    '입찰가','상태',
    '노출수','클릭수','전환수','평균순위',
    '진단태그',
  ];
  const rows = keywords.map(k => [
    k.keyword, k.campaignName, k.adGroupName, k.keywordId,
    k.bidAmt,  k.status,
    k.impCnt,  k.clkCnt, k.convCnt,
    k.avgRnk ? Number(k.avgRnk).toFixed(2) : '0.00',
    k.diagnoseTag,
  ]);

  // UTF-8 BOM (Excel 한글 깨짐 방지)
  const bom     = '﻿';
  const content = bom + toCSV([header, ...rows]);
  fs.writeFileSync(filepath, content, 'utf8');

  return { filepath, filename };
}

// ════════════════════════════════════════════════════════════
//  Main
// ════════════════════════════════════════════════════════════
async function main() {
  console.log('\n' + '═'.repeat(52));
  console.log('  네이버 키워드광고 진단 → CSV (Phase 1+2)');
  console.log(`  실행: ${new Date().toLocaleString('ko-KR')}`);
  console.log('═'.repeat(52));

  console.log('\n📁 환경변수 확인:');
  for (const k of ['NAVER_API_KEY','NAVER_SECRET_KEY','NAVER_CUSTOMER_ID'])
    console.log(`   ${k.padEnd(20)}: ${mask(process.env[k])}`);
  console.log('');

  // Step 1. 키워드 기본 정보 수집
  const keywords = await fetchAllKeywords();
  if (!keywords.length) {
    log('⚠️  수집된 키워드가 없습니다.');
    return;
  }

  // Step 2. 성과 통계 수집
  const kwIds   = keywords.map(k => k.keywordId).filter(Boolean);
  const statMap = await fetchStats(kwIds);

  // Step 3. 통계 병합 + 진단 태그
  log('🏥 진단 태그 계산...');
  for (const kw of keywords) {
    const stat = statMap[kw.keywordId] ?? {};
    kw.impCnt      = Number(stat.impCnt  ?? 0);
    kw.clkCnt      = Number(stat.clkCnt  ?? 0);
    kw.convCnt     = Number(stat.convCnt ?? 0);
    kw.avgRnk      = Number(stat.avgRnk  ?? 0);
    kw.diagnoseTag = diagnose(stat, kw.status);
  }

  // 진단 요약 카운트
  const tagCount = {};
  for (const kw of keywords) tagCount[kw.diagnoseTag] = (tagCount[kw.diagnoseTag] ?? 0) + 1;

  // Step 4. CSV 저장
  const { filename } = saveCSV(keywords);

  console.log('\n' + '═'.repeat(52));
  console.log(`  총 키워드       : ${keywords.length}개`);
  for (const [tag, cnt] of Object.entries(tagCount))
    console.log(`  ${tag.padEnd(12)}: ${cnt}개`);
  console.log(`\n  CSV 저장 완료: data/${filename}`);
  console.log('  GitHub 커밋   : git add data/*.csv');
  console.log('✅ 완료!');
  console.log('═'.repeat(52) + '\n');
}

main().catch(err => {
  console.error('\n❌ 오류:', err.message);
  process.exit(1);
});
