import {
  buildEditPackage,
  editPackageFileName,
  sheetTime,
  type EditPackage,
} from '../../src/services/editPackage';
import type { StudioModel } from './studio';

/**
 * 스튜디오 모델 → 편집 패키지 → 브라우저 다운로드.
 *
 * 파일 내용은 `src/services/editPackage.ts`가 만들고, 이 파일은 브라우저에서만
 * 할 수 있는 일(Blob·ObjectURL·a 클릭)만 한다. 그래서 계산은 Node 테스트로,
 * 클릭 경로는 jsdom 테스트로 나눠 확인할 수 있다.
 */

export interface EditPackageSummary {
  fileName: string;
  totalBytes: number;
  files: Array<{ name: string; bytes: number; lines: number }>;
  /** 패키지에 들어간 자막·컷 수. 콘솔에서 "무엇이 들어갔는지" 보여준다. */
  cueCount: number;
  sceneCount: number;
  durationLabel: string;
}

export function editPackageFor(model: StudioModel, now: Date = new Date()): { pkg: EditPackage; summary: EditPackageSummary } {
  const pkg = buildEditPackage({
    title: model.request.topic,
    scenes: model.scenes,
    cues: model.cues,
    now,
  });
  const summary: EditPackageSummary = {
    fileName: editPackageFileName(pkg.baseName, now),
    totalBytes: pkg.zip.length,
    files: pkg.files.map((file) => ({
      name: file.name,
      bytes: new TextEncoder().encode(file.content).length,
      lines: file.content.split('\n').length - 1,
    })),
    cueCount: model.cues.length,
    sceneCount: model.scenes.length,
    durationLabel: sheetTime(model.totalDurationSec),
  };
  return { pkg, summary };
}

/**
 * 실제 다운로드. 브라우저가 없으면(테스트·SSR) false.
 * 다운로드는 사용자가 누른 버튼에서만 일어난다 — 화면을 열었다는 이유로 파일을
 * 저장하지 않는다.
 */
export function downloadEditPackage(model: StudioModel, now: Date = new Date()): boolean {
  const { pkg, summary } = editPackageFor(model, now);
  const doc = (globalThis as { document?: Document }).document;
  const urlApi = (globalThis as { URL?: typeof URL }).URL;
  if (!doc || !urlApi?.createObjectURL) return false;

  const bytes = new Uint8Array(pkg.zip.length);
  bytes.set(pkg.zip);
  const blob = new Blob([bytes], { type: 'application/zip' });
  const url = urlApi.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = summary.fileName;
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Blob URL은 다운로드가 시작된 뒤 해제한다.
  globalThis.setTimeout(() => urlApi.revokeObjectURL(url), 1000);
  return true;
}
