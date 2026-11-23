/**
 * 서버 환경변수. 브라우저로 나가지 않는 값만 여기서 읽는다.
 * 값이 없으면 기능을 끄고, 절반만 설정된 상태를 성공으로 보고하지 않는다.
 */

export interface SonderEnv {
  supabaseUrl: string;
  supabaseServiceKey: string;
  openaiKey: string;
  openaiModel: string;
  anthropicKey: string;
  anthropicModel: string;
}

type EnvSource = Record<string, string | undefined>;

export function readEnv(source: EnvSource = process.env): SonderEnv {
  const clean = (value: string | undefined): string => (value ?? '').trim();
  return {
    supabaseUrl: clean(source.SUPABASE_URL),
    supabaseServiceKey: clean(source.SUPABASE_SERVICE_ROLE_KEY),
    openaiKey: clean(source.OPENAI_API_KEY),
    openaiModel: clean(source.OPENAI_SCRIPT_MODEL) || 'gpt-4o-mini',
    anthropicKey: clean(source.ANTHROPIC_API_KEY),
    anthropicModel: clean(source.ANTHROPIC_SCRIPT_MODEL) || 'claude-sonnet-4-5',
  };
}

export function hasDatabase(env: SonderEnv): boolean {
  return env.supabaseUrl.length > 0 && env.supabaseServiceKey.length > 0;
}

export function aiProvider(env: SonderEnv): 'openai' | 'anthropic' | 'rules' {
  if (env.openaiKey) return 'openai';
  if (env.anthropicKey) return 'anthropic';
  return 'rules';
}
