# Vercel + Supabase 연결 — 15분 설정

정적 모드(GitHub Pages)는 그대로 두고, 클라우드 저장·서버 대본 생성을 원할 때만
합니다. 설정하지 않아도 지금 사이트의 모든 기능은 브라우저에서 동작합니다.

연결이 끝나면 화면 위쪽 배지가 `로컬 모드` → `클라우드 DB 연결됨`으로 바뀌고,
채널 정체성·트렌드 보관함·기획안·성과 로그가 기기와 무관하게 같은 데이터를 씁니다.

---

## 1. Supabase — 데이터베이스 만들기 (약 5분)

1. <https://supabase.com> → **New project** → 이름 `sns-shortform` 정도, 리전은
   **Seoul(ap-northeast-2)** 추천, DB 비밀번호는 아무 것이나(복구용이 아니라 그냥 저장).
2. 프로젝트가 준비되면 좌측 **SQL Editor** → **New query**.
3. 이 저장소의 [`supabase/schema.sql`](supabase/schema.sql) 전체를 붙여넣고 **Run**.
   - 표 4개(`channel_identities`, `trend_vault_items`, `content_plans`,
     `performance_logs`)가 만들어지고, 마지막에 표 목록이 보이면 끝.
4. **Project Settings → API**에서 두 값을 복사해 둔다.
   - `Project URL` → `SUPABASE_URL`
   - `service_role` 시크릿 키 → `SUPABASE_SERVICE_ROLE_KEY`
   - ⚠️ service_role 키는 절대 GitHub에 올리거나 브라우저 코드에 넣지 않습니다.
     Vercel 환경변수에만 넣습니다.

## 2. Vercel — 배포 + 환경변수 (약 5분)

1. <https://vercel.com> → GitHub로 로그인 → **Add New → Project**.
2. 저장소 목록에서 **`sns-shortform-automation`** → **Import**.
   - Framework Preset: **Other**(자동 감지돼도 무관)
   - Build Command: `npm run build:web`, Output Directory: `docs` — 둘 다
     저장소의 `vercel.json`이 정하므로 손대지 않아도 됩니다.
3. **Deploy** 전에 **Environment Variables**에서 아래 4개를 입력(Production·Preview 둘 다):

   | 이름 | 값 |
   | --- | --- |
   | `SUPABASE_URL` | 1단계에서 복사한 Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | 1단계에서 복사한 service_role 키 |
   | `OPENAI_API_KEY` | (선택) 서버에서 대본을 쓰게 할 때만 |
   | `ANTHROPIC_API_KEY` | (선택, OPENAI_API_KEY와 둘 중 하나면 됨) |

4. **Deploy**. 첫 배포가 끝나면 `https://<프로젝트명>.vercel.app`이 열립니다.

## 3. 확인 (약 2분)

1. 배포 주소를 열고, 위쪽 배지가 **`클라우드 DB 연결됨`**인지 확인.
   - 여전히 `로컬 모드`면: Vercel → Settings → Environment Variables에서
     `SUPABASE_URL`·`SUPABASE_SERVICE_ROLE_KEY` 오탈자 확인 → **Redeploy**.
2. 트렌드 보관함에서 참고 영상 하나를 저장 → 다른 기기(휴대폰)에서 같은 주소를
   열어 같은 항목이 보이면 클라우드 저장이 작동하는 겁니다.
3. 배포 주소를 휴대폰 홈 화면에 추가하면 앱처럼 씁니다.

---

## 자주 묻는 것

- **GitHub Pages는 계속 유지되나요?** 네. 정적 모드는 그대로 살아 있고, Vercel
  배포는 별도 주소로 얹히는 것입니다. Vercel을 지워도 Pages 사이트는 그대로입니다.
- **Supabase 무료 플랜으로 충분한가요?** 충분합니다. 이 앱의 데이터는 텍스트
  몇 KB 단위이고, 무료 한도(500MB DB)로 수천 건을 저장할 수 있습니다.
- **대본 품질이 바뀌나요?** 서버에 LLM 키를 넣으면 기획안의 문장을 그 모델이
  씁니다. 키가 없으면 내장 문장 엔진이 쓰는데, 시간 계산·자막·박자표는 어느 쪽이든
  같은 엔진이 계산합니다. 모델 호출이 실패하면 자동으로 내장 엔진으로 돌아오고,
  화면에 그 사실을 한 줄로 알려줍니다.
- **비용이 나가나요?** Vercel·Supabase·GitHub Pages 모두 무료 플랜 범위에서
  동작합니다. OpenAI/Anthropic 키를 넣은 경우에만 대본 생성 건당 모델 사용료가
  붙습니다(1건당 원 단위 수준).
