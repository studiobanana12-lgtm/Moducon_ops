# MODUCON OPS: 실제 로그인 설정

이 버전은 Supabase 인증과 고객사별 RLS(행 수준 보안)를 위한 코드가 준비되어 있지만, 프로젝트 키가 설정되기 전에는 로그인할 수 없습니다.

1. https://supabase.com/dashboard 에서 새 프로젝트 생성
2. SQL Editor에서 supabase/schema.sql 실행
3. Authentication > Providers > Email 활성화
4. Authentication > Users에서 직원/고객 계정을 관리자가 생성 (실제 운영 시 초대/비밀번호 재설정 절차 사용)
5. SQL Editor에서 고객사 생성 및 사용자 역할 연결:
   insert into public.organizations(name) values ('바나나') returning id;
   insert into public.memberships(user_id,organization_id,role) values ('AUTH_USER_UUID','ORG_UUID','client');
   직원 계정은 role 'admin' 또는 'staff'로 연결.
6. Supabase Settings > API의 Project URL과 공개용 publishable/anon key를 config.js에 입력. 절대 service_role 키 입력 금지.
7. GitHub에 커밋하면 Vercel이 자동 배포하는지 확인.

**주의:** 고객용 계정이 다른 고객사 영상에 접근할 수 없는지 서로 다른 계정으로 검증해야 합니다. 이 데모는 실제 영상 업로드/게시 기능을 아직 제공하지 않습니다.
