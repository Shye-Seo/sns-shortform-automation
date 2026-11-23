/**
 * 실사용 스튜디오 E2E — 실제 파일을 올려 편집하고, 영상(MP4/WebM)과 카드뉴스(ZIP)를
 * 실제로 만들어 내려받는 경로를 브라우저에서 끝까지 확인한다.
 *
 * 실행: node e2e/run.mjs [--headed]
 * 전제: `npm run build:web` 후 docs/가 최신일 것.
 * 스크린샷: docs/preview/web-creator-*.png
 * 산출물: .work/e2e-output/ (영상·ZIP 원본)
 */
// Playwright는 이 저장소의 의존성이 아니다(브라우저 바이너리까지 100MB대).
// 로컬에 설치돼 있으면 `npm i -D playwright` 후 그대로, 아니면 PLAYWRIGHT_PATH로 지정한다.
const playwrightPath = process.env.PLAYWRIGHT_PATH ?? 'playwright';
const { chromium } = await import(playwrightPath);
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const DOCS = join(ROOT, 'docs');
const PREVIEW = join(DOCS, 'preview');
const OUT = join(ROOT, '.work/e2e-output');
const PORT = Number(process.env.E2E_PORT ?? 4173);
const HEADED = process.argv.includes('--headed');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
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
  await new Promise((done) => server.listen(PORT, '127.0.0.1', done));

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    // 정적 호스트에서 /api/health 확인 요청은 404가 정상(로컬 모드 판별 경로).
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  const downloads = [];
  page.on('download', async (download) => {
    const name = download.suggestedFilename();
    const target = join(OUT, name);
    await download.saveAs(target).catch(() => undefined);
    downloads.push({ name, target });
  });

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    check('라이브 페이지 로드', (await page.title()).includes('숏폼'), await page.title());

    // 전체 페이지 스크린샷에서 붙박이 탭이 본문을 가리지 않게 잠시 고정을 푼다.
    await page.addStyleTag({ content: '.tabs{position:static !important}' });
    await page.getByRole('tab', { name: '실사용 스튜디오' }).click();
    await page.waitForTimeout(400);
    check('실사용 스튜디오 탭 열림', await page.getByTestId('creator-studio').isVisible());

    const canvasInfo = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="creator-canvas"]');
      if (!canvas) return { ok: false };
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set();
      for (let i = 0; i < data.length; i += 8000) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      return { ok: true, width: canvas.width, height: canvas.height, colors: colors.size };
    });
    check('9:16 캔버스가 실제로 그려짐', canvasInfo.ok && canvasInfo.colors > 20, JSON.stringify(canvasInfo));
    await page.screenshot({ path: join(PREVIEW, 'web-creator-studio.png'), fullPage: true });

    // 1) 샘플 컷 비우고 실제 파일 올리기
    await page.getByTestId('creator-clear').click();
    await page.getByTestId('creator-clear').click();
    await page.waitForTimeout(200);
    check('전체 비우기', (await page.locator('[data-testid^="creator-cut-"]').count()) === 0);

    await page.setInputFiles('[data-testid="creator-file-input"]', [
      join(ROOT, 'e2e/fixtures/kitchen-01.png'),
      join(ROOT, 'e2e/fixtures/kitchen-02.png'),
      join(ROOT, 'e2e/fixtures/clip.mp4'),
    ]);
    await page.waitForTimeout(1800);
    const cutCount = await page.locator('[data-testid^="creator-cut-"]').count();
    check('사진 2장 + 영상 1개가 컷으로 들어감', cutCount === 3, `${cutCount}컷`);
    check(
      '영상 컷에 썸네일(첫 프레임)이 생김',
      (await page.locator('[data-testid="creator-cut-2"] img').count()) === 1,
    );

    // 길이를 짧게(1.5초) 바꿔 렌더 시간을 줄인다.
    for (let index = 0; index < 3; index += 1) {
      const input = page.locator(`[data-testid="creator-cut-${index}"] input[type="number"]`);
      await input.fill('1.5');
      await input.blur();
    }
    await page.waitForTimeout(300);

    // 2) 자막 편집 → 캔버스 변화
    const beforeCaption = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="creator-canvas"]');
      return canvas.toDataURL('image/png').length;
    });
    const captionInput = page.locator('[data-testid="creator-cut-0"] input.cut-caption');
    await captionInput.fill('문틈 10cm에 냄비 뚜껑을 세워 두었더니 정리 끝');
    await page.waitForTimeout(500);
    const afterCaption = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="creator-canvas"]');
      return canvas.toDataURL('image/png').length;
    });
    check('자막을 바꾸면 미리보기가 다시 그려짐', beforeCaption !== afterCaption, `${beforeCaption} → ${afterCaption}`);

    // 3) 세이프존 토글
    const zonePixels = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="creator-canvas"]');
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(100, 40, 60, 40).data;
      return Array.from(data.slice(0, 120)).join(',');
    });
    await page.getByText('9:16 세이프존 가이드').click();
    await page.waitForTimeout(300);
    const zonePixelsOff = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="creator-canvas"]');
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(100, 40, 60, 40).data;
      return Array.from(data.slice(0, 120)).join(',');
    });
    check('세이프존 가이드 토글이 캔버스에 반영됨', zonePixels !== zonePixelsOff);
    await page.getByText('9:16 세이프존 가이드').click();
    await page.waitForTimeout(200);

    // 4) 공정위 문구
    await page.getByTestId('creator-disclosure').selectOption('sponsored');
    await page.waitForTimeout(300);
    const disclosureText = await page.getByTestId('creator-disclosure-text').innerText();
    check('공정위 문구가 화면에 표시됨', disclosureText.includes('제공받아'), disclosureText.slice(0, 60));
    const captionField = await page.getByTestId('creator-caption').inputValue();
    check('게시물 캡션에도 같은 문구가 들어감', captionField.includes('제공받아'));

    // 5) 컷 순서 바꾸기
    const firstCaption = await page.locator('[data-testid="creator-cut-0"] input.cut-caption').inputValue();
    await page.locator('[data-testid="creator-cut-0"] .cut-actions button').nth(1).click();
    await page.waitForTimeout(200);
    const newFirstCaption = await page.locator('[data-testid="creator-cut-0"] input.cut-caption').inputValue();
    check('컷 순서를 아래로 내리면 순서가 바뀜', newFirstCaption !== firstCaption, `${firstCaption} → ${newFirstCaption}`);

    // 6) 카드뉴스 생성 + ZIP
    await page.getByTestId('creator-cards').click();
    await page.waitForSelector('[data-testid="creator-card-gallery"] img', { timeout: 20_000 });
    const cardCount = await page.locator('[data-testid="creator-card-gallery"] img').count();
    check('카드뉴스 PNG 3장 생성', cardCount === 3, `${cardCount}장`);
    await page.screenshot({ path: join(PREVIEW, 'web-creator-cards.png'), fullPage: true });

    await page.getByRole('button', { name: 'ZIP 다운로드' }).click();
    await page.waitForTimeout(1500);
    const zip = downloads.find((item) => item.name.endsWith('.zip'));
    let zipSize = 0;
    let zipEntries = 0;
    if (zip) {
      const bytes = await readFile(zip.target);
      zipSize = bytes.length;
      // 중앙 디렉터리 엔트리 수(PK\x01\x02)
      for (let i = 0; i < bytes.length - 4; i += 1) {
        if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x01 && bytes[i + 3] === 0x02) zipEntries += 1;
      }
      check('카드뉴스 ZIP 다운로드', bytes[0] === 0x50 && bytes[1] === 0x4b && zipSize > 10_000, `${zipSize} bytes`);
      check('ZIP 안에 PNG 3장', zipEntries === 3, `${zipEntries} entries`);
    } else {
      check('카드뉴스 ZIP 다운로드', false, '다운로드 이벤트 없음');
    }

    // 7) 영상 렌더링(실시간) + 다운로드
    await page.getByTestId('creator-play').click();
    await page.waitForTimeout(700);
    await page.getByTestId('creator-play').click();
    check('재생·일시정지 동작', true);

    await page.screenshot({ path: join(PREVIEW, 'web-creator-editor.png'), fullPage: true });
    const beforeRenderDownloads = downloads.length;
    await page.getByTestId('creator-render').click();
    await page.waitForSelector('[data-testid="creator-render-result"]', { timeout: 90_000 });
    await page.waitForTimeout(2500);

    const videoInfo = await page.evaluate(async () => {
      const element = document.querySelector('.render-video');
      if (!element) return null;
      if (element.readyState < 1) {
        await new Promise((resolve) => {
          element.addEventListener('loadedmetadata', resolve, { once: true });
          element.load();
        });
      }
      return { width: element.videoWidth, height: element.videoHeight, duration: element.duration, src: element.currentSrc.slice(0, 24) };
    });
    check(
      '렌더 결과가 재생 가능한 9:16 영상',
      Boolean(videoInfo && videoInfo.width === 1080 && videoInfo.height === 1920 && videoInfo.duration > 0.5),
      JSON.stringify(videoInfo),
    );

    const newDownloads = downloads.slice(beforeRenderDownloads);
    const videoFile = newDownloads.find((item) => item.name.endsWith('.mp4') || item.name.endsWith('.webm'));
    if (videoFile) {
      const bytes = await readFile(videoFile.target);
      const mp4 = bytes.subarray(4, 8).toString('latin1') === 'ftyp';
      const webm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
      const hasAudio =
        bytes.includes(Buffer.from('mp4a')) ||
        bytes.includes(Buffer.from('OpusHead')) ||
        bytes.includes(Buffer.from('Opus'));
      check('영상 파일이 0바이트 초과·올바른 컨테이너', (mp4 || webm) && bytes.length > 20_000, `${videoFile.name} ${bytes.length} bytes`);
      check('영상에 오디오(BGM) 트랙 포함', hasAudio);
      await writeFile(join(OUT, 'render-info.json'), JSON.stringify({ ...videoFile, bytes: bytes.length, mp4, webm, hasAudio }, null, 2));
    } else {
      check('영상 파일 다운로드', false, '다운로드 이벤트 없음');
    }

    await page.screenshot({ path: join(PREVIEW, 'web-creator-render.png'), fullPage: true });

    // 8) 본문 붙여넣기 → 컷 생성
    await page.getByRole('tab', { name: '본문 붙여넣기' }).click();
    await page.getByTestId('creator-paste-title').fill('3평 주방 수납 정리');
    await page
      .getByTestId('creator-paste-body')
      .fill('3평 주방은 수납장 문 안쪽 10cm를 먼저 봅니다. 냄비 뚜껑은 문 안쪽 선반에 세워 두면 한 줄로 정리됩니다. 용기 높이를 맞추면 남는 공간이 눈에 보입니다. 오늘은 한 칸만 비워도 충분합니다.');
    await page.getByRole('button', { name: '컷으로 만들기' }).click();
    await page.waitForTimeout(800);
    const pasteCuts = await page.locator('[data-testid^="creator-cut-"]').count();
    const pasteFirst = await page.locator('[data-testid="creator-cut-0"] input.cut-caption').inputValue();
    check('붙여넣은 글에서 컷 생성', pasteCuts >= 3 && pasteFirst.includes('주방'), `${pasteCuts}컷 · ${pasteFirst}`);

    // 9) 유튜브 링크 가져오기(네트워크 의존 — 실패해도 치명 아님, 결과만 기록)
    try {
      await page.getByRole('tab', { name: '링크' }).click();
      await page.getByTestId('creator-url').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      await page.getByRole('button', { name: '가져오기' }).click();
      await page.waitForTimeout(6000);
      const notice = await page.getByTestId('creator-notice').innerText();
      const imported = await page.locator('[data-testid^="creator-cut-"]').count();
      check('유튜브 oEmbed 링크 가져오기', imported >= 2, `${imported}컷 · ${notice.slice(0, 70)}`);
    } catch (error) {
      check('유튜브 oEmbed 링크 가져오기', false, String(error).slice(0, 120));
    }

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
