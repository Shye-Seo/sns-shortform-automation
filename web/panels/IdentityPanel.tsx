import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Button, Card, Kpi } from '../ui';
import { renderVoiceDoc } from '../../src/services/sonder/identity';
import type { ChannelIdentity, IdentityDraft } from '../../src/services/sonder/types';
import type { SonderMode, SonderStore } from '../model/sonder/repo';

/**
 * 채널 정체성 — 계정마다 말투·타깃·고정 강점·금지 표현을 정한다.
 *
 * 이 화면에서 저장한 값은 기획안이 실제로 읽는다. 금지 표현은 대본·캡션 검사에
 * 쓰이고, 시그니처는 캡션 마지막 줄이 되고, 말투는 문장 다듬기에 반영된다.
 */

interface FormState {
  id?: string;
  name: string;
  handle: string;
  posture: string;
  audience: string;
  voice: string;
  strengths: string;
  banned: string;
  signature: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  handle: '',
  posture: '',
  audience: '',
  voice: '',
  strengths: '',
  banned: '',
  signature: '',
};

function toForm(identity: ChannelIdentity): FormState {
  return {
    id: identity.id,
    name: identity.name,
    handle: identity.handle,
    posture: identity.posture,
    audience: identity.audience,
    voice: identity.voice,
    strengths: identity.strengths.join(', '),
    banned: identity.banned.join(', '),
    signature: identity.signature.join(', '),
  };
}

const splitList = (value: string): string[] =>
  value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);

export interface IdentityPanelProps {
  store: SonderStore | null;
  mode: SonderMode;
}

export function IdentityPanel({ store, mode }: IdentityPanelProps) {
  const [identities, setIdentities] = useState<ChannelIdentity[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!store) return;
    let alive = true;
    store
      .listIdentities()
      .then((items) => {
        if (!alive) return;
        setIdentities(items);
        if (items[0]) setForm(toForm(items[0]));
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : '채널을 불러오지 못했습니다');
      });
    return () => {
      alive = false;
    };
  }, [store]);

  const draft: IdentityDraft = useMemo(
    () => ({
      id: form.id,
      name: form.name,
      handle: form.handle,
      posture: form.posture,
      audience: form.audience,
      voice: form.voice,
      strengths: splitList(form.strengths),
      banned: splitList(form.banned),
      signature: splitList(form.signature),
    }),
    [form],
  );

  const preview = useMemo(() => {
    try {
      return renderVoiceDoc({
        id: form.id ?? 'preview',
        name: form.name || '채널 이름',
        handle: form.handle,
        posture: form.posture,
        audience: form.audience,
        voice: form.voice,
        strengths: splitList(form.strengths),
        banned: splitList(form.banned),
        signature: splitList(form.signature),
        updatedAt: new Date().toISOString(),
      });
    } catch {
      return '';
    }
  }, [form]);

  const totalBanned = identities.reduce((sum, identity) => sum + identity.banned.length, 0);

  const save = async (): Promise<void> => {
    if (!store) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await store.saveIdentity(draft);
      setIdentities(await store.listIdentities());
      setForm(toForm(saved));
      setNotice(`${saved.name} 채널 정체성을 저장했습니다. 기획안이 이 값을 읽습니다.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '저장하지 못했습니다');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(preview);
      setNotice('voice.md를 복사했습니다. 다른 도구에도 그대로 붙여 넣을 수 있습니다.');
    } catch {
      setError('이 브라우저에서는 클립보드에 쓰지 못했습니다. 아래 문서를 직접 선택해 복사해 주세요.');
    }
  };

  const update = (key: keyof FormState) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm((prev) => ({ ...prev, [key]: event.target.value }));
    setNotice('');
  };

  return (
    <div className="stack">
      <div className="grid kpi">
        <Kpi label="저장된 채널" value={`${identities.length}개`} sub={mode === 'cloud' ? '클라우드에 저장' : '이 브라우저에 저장'} />
        <Kpi label="쓰지 않는 표현" value={`${totalBanned}개`} sub="대본·캡션에서 검사합니다" />
        <Kpi
          label="지금 고치는 채널"
          value={form.name || '새 채널'}
          sub={form.handle || '핸들 없음'}
        />
        <Kpi label="캡션 마무리" value={splitList(form.signature).length > 0 ? '있음' : '없음'} sub="캡션 마지막 줄" />
      </div>

      <div className="grid sidebar">
        <Card
          eyebrow="내 자산 프로필"
          title="계정"
          hint="계정마다 말투가 다릅니다. 여기서 고른 채널이 기획안의 기준이 됩니다."
          actions={
            <Button
              small
              ghost
              onClick={() => {
                setForm(EMPTY_FORM);
                setNotice('');
                setError('');
              }}
            >
              새 채널
            </Button>
          }
        >
          <div className="preset-list">
            {identities.map((identity) => (
              <button
                key={identity.id}
                type="button"
                className={identity.id === form.id ? 'preset active' : 'preset'}
                onClick={() => {
                  setForm(toForm(identity));
                  setNotice('');
                  setError('');
                }}
                aria-pressed={identity.id === form.id}
              >
                <span className="preset-label">{identity.name}</span>
                <span className="small muted">{identity.handle || '핸들 없음'}</span>
                <span className="small muted">{identity.posture || '한 줄 정체성 없음'}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card
          title={form.id ? '정체성 고치기' : '새 채널 만들기'}
          hint="비워 둔 항목은 기획안에서 쓰이지 않습니다. 저장하면 오른쪽 문서가 바로 바뀝니다."
          actions={
            <Button primary small onClick={() => void save()} disabled={busy || !store}>
              {busy ? '저장 중…' : '저장'}
            </Button>
          }
        >
          <div className="form-block">
            <div className="field-row">
              <label className="field">
                <span>이름</span>
                <input type="text" value={form.name} onChange={update('name')} placeholder="일상·리빙" />
              </label>
              <label className="field">
                <span>핸들</span>
                <input type="text" value={form.handle} onChange={update('handle')} placeholder="@shye__s" />
              </label>
            </div>
            <label className="field">
              <span>한 줄 정체성</span>
              <input
                type="text"
                value={form.posture}
                onChange={update('posture')}
                placeholder="부산 신혼집 살림을 직접 해보고 남는 것만 기록"
              />
            </label>
            <label className="field">
              <span>타깃</span>
              <input type="text" value={form.audience} onChange={update('audience')} placeholder="결혼 1~3년 차" />
            </label>
            <label className="field">
              <span>말투</span>
              <textarea
                value={form.voice}
                onChange={update('voice')}
                rows={3}
                placeholder="문장은 짧게 끊고, 숫자와 실제로 써 본 기간을 먼저 말한다."
              />
            </label>
            <label className="field">
              <span>고정 강점 (쉼표로 구분)</span>
              <input
                type="text"
                value={form.strengths}
                onChange={update('strengths')}
                placeholder="3평 주방 실측 수납, 한 달 써 보고 남긴 것만 소개"
              />
            </label>
            <label className="field">
              <span>쓰지 않는 표현 (쉼표로 구분)</span>
              <input type="text" value={form.banned} onChange={update('banned')} placeholder="완벽, 무조건, 역대급" />
            </label>
            <label className="field">
              <span>캡션 마무리 (쉼표로 구분)</span>
              <input
                type="text"
                value={form.signature}
                onChange={update('signature')}
                placeholder="오늘도 하나만 남기고 갑니다"
              />
            </label>
          </div>

          {error ? <p className="notice bad">{error}</p> : null}
          {notice ? <p className="notice ok">{notice}</p> : null}
        </Card>
      </div>

      <Card
        eyebrow="voice.md"
        title="그대로 복사해 갈 수 있는 문서"
        hint="다른 도구에 붙여 넣어도 같은 말투가 나오게 정리한 형태입니다."
        actions={
          <Button small onClick={() => void copy()}>
            복사
          </Button>
        }
      >
        <pre className="voice-doc" data-testid="voice-doc">
          {preview}
        </pre>
        <p className="note" style={{ marginTop: 10 }}>
          {mode === 'cloud'
            ? '클라우드에 저장되어 다른 기기에서도 같은 정체성을 씁니다.'
            : '이 브라우저에 저장됩니다. 주소를 바꾸거나 저장 기록을 지우면 사라집니다.'}
        </p>
      </Card>

      <Card title="이 값이 쓰이는 곳" hint="정체성은 장식이 아니라 계산에 들어갑니다.">
        <ul className="plain-list">
          <li>
            <strong>후킹 3안</strong> — 말투와 고정 강점이 문장 선택에 반영됩니다.
          </li>
          <li>
            <strong>금지 표현 검사</strong> — 대본과 캡션에 들어간 금지 표현을 기획안에서 바로 짚습니다.
          </li>
          <li>
            <strong>캡션</strong> — 마무리 문장이 캡션 마지막 줄로 붙습니다.
          </li>
        </ul>
      </Card>
    </div>
  );
}
