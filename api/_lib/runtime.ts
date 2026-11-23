/**
 * 배포 런타임 조립. 환경변수가 반만 설정된 상태를 조용히 넘기지 않는다.
 */
import type { SonderEnv } from './env';
import { hasDatabase } from './env';
import type { Store } from './store';
import { createSupabaseStore } from './supabase';

export function storeFromEnv(env: SonderEnv): Store | null {
  if (!hasDatabase(env)) return null;
  return createSupabaseStore({ url: env.supabaseUrl, serviceKey: env.supabaseServiceKey });
}

/** 데이터베이스가 없을 때 핸들러가 돌려주는 문구. 화면은 이 코드를 보고 로컬 모드로 남는다. */
export const DATABASE_MISSING_MESSAGE =
  '데이터베이스가 연결되지 않았습니다. SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY를 설정하면 클라우드 저장이 켜집니다.';
