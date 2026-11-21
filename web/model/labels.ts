/**
 * 화면에 보이는 말.
 *
 * 엔진의 상태값(`dlq`, `failed`)과 오류 문자열(`ffmpeg exited with code 1 (out of
 * memory)`)은 로그·API·CLI가 쓰는 값이다. 그 값을 화면에 그대로 그리면 이 화면을
 * 쓰는 사람(운영자·크리에이터)이 읽을 수 없고, 읽을 수 없으면 고칠 수도 없다.
 *
 * 그래서 표시 계층에서만 한국어로 옮긴다. 엔진의 값은 바꾸지 않는다 —
 * `tests/webModels.test.ts`가 원본 상태값이 그대로 남아 있는지 확인한다.
 * 모르는 오류는 추측해서 꾸미지 않고, "원인을 확인하지 못했습니다"로 끝낸 뒤
 * 확인할 곳(터미널의 `queue dlq`)을 알려 준다.
 */

export interface FriendlyReason {
  /** 한 줄 제목 — 무엇이 일어났나 */
  title: string;
  /** 다음에 무엇을 하면 되는지 */
  hint: string;
  /** 사용자가 직접 할 수 있는 조치가 있는가 */
  actionable: boolean;
}

export type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'dlq' | string;

const KIND_LABEL: Record<string, string> = {
  render: '영상 변환',
  upload: '업로드',
  publish: '발행',
  convert: '변환',
};

export function jobKindLabel(kind: string | null | undefined): string {
  if (!kind) return '작업';
  return KIND_LABEL[kind] ?? '작업';
}

/** 목록에 그리는 상태 이름. 색은 `tone`으로 따로 준다. */
export function jobStateLabel(
  state: JobState,
  kind?: string | null,
): { label: string; tone: 'ok' | 'warn' | 'bad' | 'ghost' } {
  switch (state) {
    case 'waiting':
      return { label: '대기 중', tone: 'ghost' };
    case 'delayed':
      return { label: '다시 시도 대기', tone: 'ghost' };
    case 'active':
      return { label: '처리 중', tone: 'ghost' };
    case 'completed':
      return { label: '완료', tone: 'ok' };
    case 'dlq':
      // 자동 재시도로 풀리지 않아 사람이 판단해야 하는 상태.
      return { label: '보류됨', tone: 'warn' };
    case 'failed':
      return kind === 'upload' || kind === 'publish'
        ? { label: '업로드 실패', tone: 'bad' }
        : { label: '변환 실패', tone: 'bad' };
    default:
      return { label: '확인 필요', tone: 'warn' };
  }
}

/**
 * 엔진이 남긴 실패 사유를 사람이 읽는 문장으로 바꾼다.
 *
 * 패턴은 실제로 이 저장소의 로그에 남는 것들이다. 새 오류가 생기면 여기에 한 줄을
 * 추가하면 되고, 추가하지 않은 오류는 원문을 노출하지 않고 안전한 문장으로 떨어진다.
 */
export function friendlyFailure(raw: string | null | undefined): FriendlyReason {
  const text = (raw ?? '').trim();
  const lower = text.toLowerCase();

  if (text === '') {
    return {
      title: '이유가 기록되지 않았습니다',
      hint: '다시 시도하면 대부분 해결됩니다. 같은 일이 반복되면 작업 기록을 확인해 주세요.',
      actionable: true,
    };
  }

  if (lower.includes('out of memory') || lower.includes('oom') || lower.includes('memory')) {
    return {
      title: '영상 변환 중 메모리가 부족했습니다',
      hint: '영상을 2~3개로 나눠 올리거나 화질을 한 단계 낮추면 다시 변환됩니다.',
      actionable: true,
    };
  }

  if (lower.includes('duration') || lower.includes('too long') || lower.includes('over platform limit')) {
    return {
      title: '영상 길이가 플랫폼 허용 시간을 넘었습니다',
      hint: '릴스는 최대 90초, 쇼츠는 최대 60초입니다. 길이를 줄여 다시 올려 주세요.',
      actionable: true,
    };
  }

  if (lower.includes('quota') || lower.includes('limit reached')) {
    return {
      title: '오늘 발행 한도를 다 썼습니다',
      hint: '한도가 다시 채워지면 자동으로 이어서 올립니다. 급하면 다른 채널로 먼저 올려 주세요.',
      actionable: false,
    };
  }

  if (lower.includes('sla') || lower.includes('deadline')) {
    return {
      title: '제한 시간 안에 처리하지 못했습니다',
      hint: '쿠폰은 늦게 보내지 않는 규칙이라 취소됐습니다. 댓글 작성자에게는 안내 문구가 나갑니다.',
      actionable: false,
    };
  }

  if (lower.includes('signature') || lower.includes('verify')) {
    return {
      title: '보낸 요청의 서명이 맞지 않습니다',
      hint: '앱 설정의 보안 키가 서버와 같은지 확인해 주세요. 확인 전에는 이 요청을 처리하지 않습니다.',
      actionable: true,
    };
  }

  if (lower.includes('401') || lower.includes('reauth') || lower.includes('token') || lower.includes('permission')) {
    return {
      title: '계정 연결이 만료됐습니다',
      hint: '인스타그램·유튜브 계정을 다시 연결하면 다음 예약부터 정상 발행됩니다.',
      actionable: true,
    };
  }

  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many')) {
    return {
      title: '플랫폼이 잠시 요청을 막았습니다',
      hint: '자동으로 잠시 기다렸다가 다시 시도합니다. 보통 몇 분 안에 풀립니다.',
      actionable: false,
    };
  }

  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('network')) {
    return {
      title: '응답이 늦어 연결이 끊겼습니다',
      hint: '네트워크가 회복되면 자동으로 다시 시도합니다. 반복되면 잠시 뒤 직접 눌러 주세요.',
      actionable: true,
    };
  }

  if (lower.includes('400') || lower.includes('invalid') || lower.includes('rejected')) {
    return {
      title: '플랫폼이 업로드를 거절했습니다',
      hint: '영상 형식(9:16·mp4)과 캡션 길이를 확인해 주세요. 고친 뒤 다시 시도하면 됩니다.',
      actionable: true,
    };
  }

  return {
    title: '처리하지 못했지만 원인은 기록되지 않았습니다',
    hint: '다시 시도해 보고, 같은 일이 반복되면 작업 기록에서 원본 로그를 확인해 주세요.',
    actionable: true,
  };
}

/** 남은 시간을 "2시간 10분 뒤"처럼 쓴다. 화면에서 ms를 그대로 보여 주지 않는다. */
export function resetLabel(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  if (totalMin <= 1) return '곧';
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours === 0) return `${totalMin}분 뒤`;
  if (minutes === 0) return `${hours}시간 뒤`;
  return `${hours}시간 ${minutes}분 뒤`;
}

/** 지표 이름 — 표에서 쓰는 짧은 한국어. */
export const METRIC_LABEL = {
  viewRate3s: '3초 유지율',
  retention: '끝까지 본 비율',
  commentRate: '댓글 비율',
  couponRate: '쿠폰 전환율',
} as const;

/** 통계 표의 열 이름. */
export const STAT_COLUMN = {
  lift: '차이',
  pValue: '우연일 확률',
  interval: '95% 오차 범위',
  verdict: '판정',
} as const;
