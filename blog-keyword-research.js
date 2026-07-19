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

const log   = msg => console.log(`[${new Date().toISOString()}] ${msg}`);
const delay = ms  => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════
//  고정 시드 키워드 — 벨루나몰 카테고리별 우회 표현
//  (직접적 성인용품 키워드는 네이버 API 검색량 데이터가 안 나오거나
//   블로그 저품질 처리 위험이 있어 완곡 표현으로 구성)
//  ⚠️ 형이 채워야 할 부분: 실제 상품 라인업 보고 이 리스트에
//     맞춰서 추가/삭제 필요 — 아래는 초기 세팅용 기본값
// ════════════════════════════════════════════════════════════
const SEED_KEYWORDS = [
  // 여성 카테고리 우회
  '여성 셀프케어템', '여성 건강 관리용품', '혼자만의 시간 아이템', '여성 웰빙 아이템',
  // 남성 카테고리 우회
  '남성 컨디션 관리', '남자 자기관리템', '남성 웰빙용품', '남성 건강관리 아이템',
  // 커플/부부 카테고리 우회
  '커플템 추천', '신혼부부 필수템', '부부사이 좋아지는법', '연인 선물 아이디어',
  '커플 이벤트 아이템', '기념일 서프라이즈', '데이트 선물 추천', '결혼기념일 선물',
  // 바디케어/뷰티 우회
  '바디케어 아이템', '보습젤 추천', '스킨케어 셀프관리',
  // 라이프스타일 우회
  '자기관리 루틴', '웰니스템 추천', '힐링 아이템 추천', '스트레스 해소 아이템',
];

function dateStamp() {
  return new Date().toISOString().slice(0,10).replace(/-/g,'');
}

// ════════════════════════════════════════════════════════════
//  네이버 SA API 인증
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

async function fetchRelatedKeywords(seedBatch) {
  const uri    = '/keywordstool';
  const params = new URLSearchParams({
    hintKeywords: seedBatch.map(s => s.replace(/\s+/g, '')).join(','),
    showDetail  : '1',
  });
  try {
    const res = await axios.get(`${NAVER_BASE}${uri}?${params}`, {
      headers: naverHeaders('GET', uri),
    });
    return res.data?.keywordList ?? [];
  } catch (e) {
    const detail = e.response
      ? `HTTP ${e.response.status} — ${JSON.stringify(e.response.data)}`
      : e.message;
    log(`   ⚠️  키워드도구 조회 실패 (${seedBatch.join(',')}): ${detail}`);
    return [];
  }
}

// ════════════════════════════════════════════════════════════
//  점수 계산
// ════════════════════════════════════════════════════════════
const COMP_WEIGHT = { '낮음': 1, '중간': 2.5, '높음': 5, '': 3 };

function scoreKeyword(row) {
  const pc     = Number(String(row.monthlyPcQcCnt ?? 0).replace('< 10', '5'));
  const mobile = Number(String(row.monthlyMobileQcCnt ?? 0).replace('< 10', '5'));
  const total  = pc + mobile;
  const weight = COMP_WEIGHT[row.compIdx] ?? 3;
  return { pc, mobile, total, score: Math.round(total / weight) };
}

function tag(total, score) {
  if (total < 50)   return '검색량부족';
  if (score >= 300) return '포스팅추천';
  if (score >= 100) return '검토';
  return '보류';
}

// ════════════════════════════════════════════════════════════
//  JSON 저장 — 컨트롤타워가 fetch로 바로 읽을 고정 파일명
// ════════════════════════════════════════════════════════════
function saveJSON(rows) {
  const dir = path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });

  const payload = {
    updatedAt : new Date().toISOString(),
    dateStamp : dateStamp(),
    total     : rows.length,
    recommended: rows.filter(r => r.diagnoseTag === '포스팅추천').length,
    keywords  : rows,
  };

  // 컨트롤타워가 항상 같은 주소로 불러올 고정 파일
  fs.writeFileSync(path.join(dir, 'blog-keywords-latest.json'), JSON.stringify(payload, null, 2), 'utf8');
  // 히스토리 보관용 (선택사항, 용량 커지면 나중에 정리 가능)
  fs.writeFileSync(path.join(dir, `blog-keywords-${dateStamp()}.json`), JSON.stringify(payload, null, 2), 'utf8');

  return payload;
}

// ════════════════════════════════════════════════════════════
//  Main — 인자 없이 실행, 시드는 위 SEED_KEYWORDS 고정값 사용
// ════════════════════════════════════════════════════════════
async function main() {
  console.log('\n' + '═'.repeat(52));
  console.log('  벨루나몰 블로그 키워드 자동 발굴');
  console.log(`  실행: ${new Date().toLocaleString('ko-KR')}`);
  console.log(`  시드 키워드 ${SEED_KEYWORDS.length}개`);
  console.log('═'.repeat(52) + '\n');

  const collected = new Map();

  for (let i = 0; i < SEED_KEYWORDS.length; i += 5) {
    const batch = SEED_KEYWORDS.slice(i, i + 5);
    log(`🔍 조회 중: ${batch.join(', ')}`);
    const results = await fetchRelatedKeywords(batch);
    for (const row of results) {
      if (!collected.has(row.relKeyword)) collected.set(row.relKeyword, row);
    }
    await delay(300);
  }

  log(`📦 연관키워드 총 ${collected.size}개 수집`);

  const scored = [];
  for (const row of collected.values()) {
    const { pc, mobile, total, score } = scoreKeyword(row);
    scored.push({
      keyword: row.relKeyword,
      pc, mobile, total,
      compIdx: row.compIdx || '정보없음',
      score,
      diagnoseTag: tag(total, score),
    });
  }

  scored.sort((a, b) => b.score - a.score);

  const payload = saveJSON(scored);

  console.log(`\n  총 키워드: ${payload.total}개 / 포스팅추천: ${payload.recommended}개`);
  console.log('  저장 완료: data/blog-keywords-latest.json');
  console.log('\n  상위 10개:');
  for (const r of scored.slice(0, 10)) {
    console.log(`   ${r.keyword.padEnd(20)} 검색량:${String(r.total).padEnd(8)} 경쟁:${r.compIdx.padEnd(4)} 점수:${r.score} [${r.diagnoseTag}]`);
  }
  console.log('\n✅ 완료!');
  console.log('═'.repeat(52) + '\n');
}

main().catch(err => {
  console.error('\n❌ 오류:', err.message);
  process.exit(1);
});
