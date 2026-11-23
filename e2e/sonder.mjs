/**
 * 기획 루프 E2E — 채널 정체성 · 트렌드 보관함 · 합체 기획안 · 성과 로그가
 * 정적 페이지(로컬 모드)에서 끝까지 도는지 확인한다.
 *
 * 실행: node e2e/sonder.mjs
 * 전제: `npm run build:web` 후 docs/가 최신일 것.
 * 스크린샷: docs/preview/web-sonder-*.png
 *
 * Playwright는 이 저장소의 의존성이 아니다(브라우저 바이너리까지 100MB대).
 * 로컬에 설치돼 있으면 `npm i -D playwright` 후 그대로, 아니면 PLAYWRIGHT_PATH로
 * 지정한다.
 */
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright');
import { createServer } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const DOCS = join(ROOT, 'docs');
const PREVIEW = join(DOCS, 'preview');
const PORT = Number(process.env.E2E_PORT ?? 4174);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const TRANSCRIPT = `3평 주방에서 매번 냄비를 꺼내다 부딪혔습니다.
수납장 문 안쪽 10cm를 그냥 버리고 있었거든요.
문 안쪽에 얇은 선반을 달고, 냄비 뚜껑은 같은 크기끼리 묶었습니다.
그다음 용기 높이를 맞춰서 세로로 세웠어요.
한 달 써보니 꺼내는 시간이 3초에서 1초로 줄었습니다.
오늘은 한 칸만 비워보세요. 저장해두고 천천히 해보세요.`;

async function main() {
  await mkdir(PREVIEW, { recursive: true });

  const server = createServer(async (request, response) => {
    try {
      let path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = join(DOCS, normalize(path));
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      response.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(await readFile(file));
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
    }
  });
  await new Promise((resolveListen) => server.listen(PORT, '127.0.0.1', resolveListen));

  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (message) => {
      // 정적 호스트에서 /api/health·favicon은 404가 정상(로컬 모드 판별 경로).
      const isProbe = message.text().includes('Failed to load resource');
      if (message.type() === 'error' && !isProbe) consoleErrors.push(message.text());
    });

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await page.getByText('로컬 모드').first().waitFor();
    check('서버 없이 열리면 로컬 모드 배지', true);

    // ── 채널 정체성 ──────────────────────────────────────────────────────────
    await page.getByRole('tab', { name: '채널 정체성' }).click();
    await page.waitForTimeout(300);
    check('프리셋 3개 채널이 보임', (await page.locator('.preset').count()) === 3);
    check('voice.md 문서가 프리셋으로 채워짐', (await page.getByTestId('voice-doc').innerText()).includes('@shye__s'));

    await page.getByPlaceholder('일상·리빙').fill('일상·리빙 새벽기록');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.waitForTimeout(300);
    check('정체성 저장이 목록·문서에 반영됨', (await page.getByTestId('voice-doc').innerText()).includes('일상·리빙 새벽기록'));
    await page.screenshot({ path: join(PREVIEW, 'web-sonder-identity.png'), fullPage: true });

    // ── 트렌드 보관함 ────────────────────────────────────────────────────────
    await page.getByRole('tab', { name: '트렌드 보관함' }).click();
    await page.getByPlaceholder('https://www.youtube.com/shorts/…').fill('https://www.youtube.com/shorts/abc123XYZ');
    await page.getByPlaceholder('3평 주방 수납, 문 안쪽 10cm').fill('3평 주방 수납, 문 안쪽 10cm');
    await page.locator('textarea').first().fill(TRANSCRIPT);
    await page.getByPlaceholder('82000').fill('82000');
    await page.getByPlaceholder('19000').fill('19000');
    await page.getByPlaceholder('32').fill('32');
    await page.waitForTimeout(200);
    check('배수가 실시간 계산됨', (await page.getByTestId('multiplier').innerText()).includes('4.32배'));

    await page.getByRole('button', { name: '구조만 읽어보기' }).click();
    await page.waitForTimeout(300);
    const structureText = await page.locator('.stack').first().innerText();
    check('빌린 구조에 전환 시점이 나옴', structureText.includes('전환 시점'));
    check('구조 근거가 함께 표시됨', structureText.includes('음절') || structureText.includes('기본 배분'));

    await page.getByRole('button', { name: '보관함에 저장' }).click();
    await page.waitForTimeout(400);
    check('보관함에 저장됨', (await page.locator('.data tbody tr').count()) === 1);
    check('보관함 요약에 바이럴 1건', (await page.locator('.kpi-card').first().innerText()).includes('1건'));
    await page.screenshot({ path: join(PREVIEW, 'web-sonder-trends.png'), fullPage: true });

    // ── 합체 기획안 ──────────────────────────────────────────────────────────
    await page.getByRole('button', { name: '기획안으로' }).click();
    await page.waitForTimeout(400);
    check('보관함에서 기획안으로 넘어옴', (await page.locator('select').nth(1).inputValue()) !== '');

    await page.getByRole('button', { name: '기획안 만들기' }).click();
    await page.waitForTimeout(600);
    const hookCount = await page.locator('.hook-option').count();
    check('후킹 3안이 만들어짐', hookCount === 3, `${hookCount}안 · ${(await page.locator('.hook-options').innerText()).slice(0, 120)}`);
    check('컷별 자막표가 나옴', (await page.locator('.data tbody tr').count()) >= 4);
    const caption = await page.getByTestId('plan-caption').innerText();
    check('캡션에 채널 시그니처가 붙음', caption.includes('오늘도 하나만 남기고 갑니다'));
    check('박자표가 빌린 구조와 비교로 나옴', (await page.locator('.bar-row').count()) >= 4);

    const hookB = page.locator('.hook-option').nth(1);
    const firstTextBefore = await page.locator('[data-testid="plan-caption"]').innerText();
    await hookB.click();
    await page.waitForTimeout(500);
    const firstTextAfter = await page.locator('[data-testid="plan-caption"]').innerText();
    check('훅을 바꾸면 대본·캡션이 다시 계산됨', firstTextBefore !== firstTextAfter);
    await page.screenshot({ path: join(PREVIEW, 'web-sonder-plan.png'), fullPage: true });

    // ── 실사용 스튜디오 연동 ─────────────────────────────────────────────────
    await page.getByRole('button', { name: '실사용 스튜디오에서 열기' }).click();
    await page.waitForTimeout(600);
    check('기획안 컷이 스튜디오로 넘어감', await page.getByTestId('creator-seed').isVisible());
    check('스튜디오가 씨드로 열림', (await page.locator('[data-testid^="creator-cut-"]').count()) >= 4);
    await page.screenshot({ path: join(PREVIEW, 'web-sonder-studio.png') });

    // ── 성과 로그 ────────────────────────────────────────────────────────────
    await page.getByRole('tab', { name: '성과 로그' }).click();
    await page.waitForTimeout(300);
    await page.getByPlaceholder('3평 주방 수납 정리법').fill('주방 수납 정리법');
    await page.getByPlaceholder('82000').fill('46000');
    await page.getByPlaceholder('2100').fill('1200');
    await page.getByPlaceholder('320').fill('90');
    await page.getByPlaceholder('19000').fill('11500');
    await page.getByRole('button', { name: '기록하기' }).click();
    await page.waitForTimeout(400);
    check('성과 기록이 저장됨', (await page.locator('.data tbody tr').count()) === 1);
    check('배수·저장률이 계산됨', (await page.locator('.kpi-card').nth(1).innerText()).includes('4.00배'));
    await page.screenshot({ path: join(PREVIEW, 'web-sonder-performance.png'), fullPage: true });

    // 새로고침해도 남아 있어야 한다(로컬 저장).
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('로컬 모드').first().waitFor();
    await page.getByRole('tab', { name: '성과 로그' }).click();
    await page.waitForTimeout(400);
    check('새로고침 후에도 기록이 남음', (await page.locator('.data tbody tr').count()) === 1);

    check('콘솔 오류 없음', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
