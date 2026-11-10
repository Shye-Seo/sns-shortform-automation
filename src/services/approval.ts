import { ShortformError } from '../lib/errors';
import { sha256 } from '../lib/ids';
import type { Approval } from '../types/publish';
import type { ShortformScript } from '../types/script';

export interface ReviewSubject {
  scriptId: string;
  narrations: string[];
  caption: string;
  /** Serialised subtitle file — changing one word changes the hash. */
  subtitles: string;
}

export function subjectFromScript(script: ShortformScript, subtitles: string): ReviewSubject {
  return {
    scriptId: script.id,
    narrations: script.scenes.map((scene) => scene.narration),
    caption: script.caption,
    subtitles,
  };
}

/**
 * Fingerprint of exactly what a human reviewed. Line endings and trailing
 * whitespace are normalised so a Windows checkout does not invalidate an
 * approval, but any word change does.
 */
export function computeContentHash(subject: ReviewSubject): string {
  const canonical = JSON.stringify({
    scriptId: subject.scriptId,
    narrations: subject.narrations.map((line) => line.trim()),
    caption: subject.caption.trim(),
    subtitles: subject.subtitles.replace(/\r\n/g, '\n').trim(),
  });
  return sha256(canonical);
}

export interface CreateApprovalOptions {
  approvedBy: string;
  notes?: string;
  now?: () => Date;
}

export function createApproval(subject: ReviewSubject, options: CreateApprovalOptions): Approval {
  const approvedBy = options.approvedBy.trim();
  if (!approvedBy) {
    throw new ShortformError('approval needs a reviewer name', { code: 'APPROVAL' });
  }
  return {
    approved: true,
    approvedAt: (options.now?.() ?? new Date()).toISOString(),
    approvedBy,
    contentHash: computeContentHash(subject),
    ...(options.notes ? { notes: options.notes } : {}),
  };
}

/**
 * The Human-in-the-Loop gate. Publishing refuses to run when the artifact no
 * longer matches what was approved, which is the whole point: an agent may
 * prepare everything, but it cannot ship an unreviewed edit.
 */
export function assertApproval(approval: Approval | null | undefined, subject: ReviewSubject): void {
  if (!approval) {
    throw new ShortformError('no approval on file — run `shortform review --approve` first', {
      code: 'APPROVAL',
      details: { scriptId: subject.scriptId },
    });
  }
  if (!approval.approved) {
    throw new ShortformError('approval is explicitly withheld', {
      code: 'APPROVAL',
      details: { approvedBy: approval.approvedBy, notes: approval.notes },
    });
  }
  const expected = computeContentHash(subject);
  if (expected !== approval.contentHash) {
    throw new ShortformError(
      'content changed after approval — review again before publishing',
      {
        code: 'APPROVAL',
        details: { approvedHash: approval.contentHash, currentHash: expected },
      },
    );
  }
}

export function describeApproval(approval: Approval): string {
  return `${approval.approved ? '승인됨' : '보류'} · ${approval.approvedBy} · ${approval.approvedAt} · ${approval.contentHash.slice(0, 12)}…`;
}
