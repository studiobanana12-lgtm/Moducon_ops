# Step 2 실전 연결 가이드: YouTube 공식 OAuth 승인·연결 설정

로컬 프리뷰(`dev/preview.html`)에서는 시뮬레이터로 바로 테스트할 수 있고, **실제 Google/YouTube 계정을 연결하려면** 아래 4단계를 한 번만 설정하면 됩니다.

---

## 1. Supabase DB 스키마 반영
1. Supabase 대시보드 → **SQL Editor** 열기
2. `supabase/schema.sql` 전체 내용을 붙여넣고 **Run** 실행
   - 기존 테이블/데이터는 유지되며 `social_channel_tokens`, `oauth_states`, `channel_audit_logs`, `update_channel_permission` RPC가 안전하게 추가됩니다.

---

## 2. Google Cloud Console에서 OAuth 클라이언트 발급
1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 생성(또는 기존 프로젝트 선택)
2. **API 및 서비스 > 라이브러리**에서 아래 2개 API **사용(Enable)** 클릭:
   - `YouTube Data API v3`
   - `YouTube Analytics API`
3. **API 및 서비스 > OAuth 동의 화면**:
   - 사용자 유형: **외부(External)**
   - 앱 이름: `MODUCON OPS`
   - 테스트 사용자(앱 게시 전 테스트 단계): 테스트할 Google 계정 이메일 추가
4. **API 및 서비스 > 사용자 인증 정보 > 사용자 인증 정보 만들기 > OAuth 클라이언트 ID**:
   - 애플리케이션 유형: **웹 애플리케이션**
   - **승인된 리디렉션 URI**에 아래 주소를 정확히 입력:
     ```text
     https://ccckaqqulzhpqnwqkfce.supabase.co/functions/v1/youtube-oauth-callback
     ```
     *(Supabase 프로젝트 URL이 다르면 본인 프로젝트 URL로 변경)*
5. 발급된 **클라이언트 ID(`GOOGLE_CLIENT_ID`)**와 **클라이언트 보안 비밀번호(`GOOGLE_CLIENT_SECRET`)**를 복사해 둡니다.

---

## 3. Supabase Secrets 등록 및 Edge Functions 배포
터미널에서 Supabase CLI로 비밀 키를 등록하고 함수 3개를 배포합니다.

```powershell
# 1) 비밀 키 등록 (TOKEN_ENCRYPTION_KEY는 32자 이상 임의의 랜덤 문자열)
supabase secrets set GOOGLE_CLIENT_ID="발급받은_클라이언트_ID"
supabase secrets set GOOGLE_CLIENT_SECRET="발급받은_클라이언트_시크릿"
supabase secrets set TOKEN_ENCRYPTION_KEY="여기에_32자_이상_임의의_랜덤_비밀키를_입력하세요"

# 2) Edge Functions 4개 배포 (Step 2 OAuth 3종 + Step 3 라이브 조회 1종)
supabase functions deploy youtube-oauth-start
supabase functions deploy youtube-oauth-callback --no-verify-jwt
supabase functions deploy youtube-oauth-revoke
supabase functions deploy youtube-channel-insights
```

> **주의**: `youtube-oauth-callback`은 Google 서버에서 브라우저 리다이렉트로 호출되므로 반드시 `--no-verify-jwt` 옵션으로 배포해야 합니다. (대신 DB의 일회용 `oauth_states`로 CSRF를 방어합니다.)

---

## 4. 동작 테스트
1. 배포된 Vercel 주소(또는 `http://localhost:8765/index.html`)에 고객사(또는 관리자) 계정으로 로그인
2. **`SNS 승인`** (또는 `SNS 연동`) 탭 클릭
3. 권한 범위(`Lv.1 열람 전용` 추천)와 기간을 고르고 **`[Google 계정으로 YouTube 승인·연결하기]`** 클릭
4. Google 동의 화면에서 허용 → 앱으로 돌아오며 **채널 프로필·권한 배지·감사 로그**가 즉시 표시되는지 확인
5. **`[즉시 연결 해제 (Kill Switch)]`** 클릭 → Google 토큰 폐기 및 상태 `연결 해제됨` 전환 확인
