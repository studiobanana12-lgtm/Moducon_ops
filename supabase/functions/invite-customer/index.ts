import { createClient } from "npm:@supabase/supabase-js@2";

const PROD_ORIGIN = "https://moduconops.vercel.app";

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.origin === PROD_ORIGIN) return true;
    if (u.protocol === "https:" && u.hostname.endsWith(".vercel.app")) return true;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function corsHeaders(reqOrigin: string | null) {
  const allow = isAllowedOrigin(reqOrigin) ? reqOrigin! : PROD_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };
}

Deno.serve(async (req) => {
  const reqOrigin = req.headers.get("origin");
  const cors = corsHeaders(reqOrigin);
  const reply = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: cors });

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  if (!isAllowedOrigin(reqOrigin)) {
    return reply({ error: `허용되지 않은 도메인입니다: ${reqOrigin || "unknown"}` }, 403);
  }

  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "로그인이 필요합니다." }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!url || !anon || !service) return reply({ error: "서버 환경 설정이 누락되었습니다." }, 503);

  const auth = createClient(url, anon, {
    global: { headers: { Authorization: "Bearer " + token } }
  });
  const { data: { user }, error: userError } = await auth.auth.getUser(token);
  if (userError || !user) return reply({ error: "로그인 세션이 만료되었습니다. 다시 로그인해 주세요." }, 401);

  const { data: roles, error: roleError } = await auth
    .from("memberships")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .limit(1);
  if (roleError || !roles?.length) return reply({ error: "관리자 권한이 필요합니다." }, 403);

  let body;
  try {
    body = await req.json();
  } catch {
    return reply({ error: "잘못된 요청 형식입니다." }, 400);
  }

  const email = String(body.email || "").trim().toLowerCase();
  const organization_id = String(body.organization_id || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[0-9a-f-]{36}$/i.test(organization_id)) {
    return reply({ error: "이메일 또는 고객사 정보가 올바르지 않습니다." }, 400);
  }

  const admin = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, name")
    .eq("id", organization_id)
    .single();
  if (orgError || !org || org.name === "모두콘 (내부 운영)") {
    return reply({ error: "유효하지 않은 고객사입니다." }, 400);
  }

  // 1) Try standard email invitation first
  const { data: invite, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: PROD_ORIGIN
  });

  if (!inviteError && invite?.user) {
    const { error: memberError } = await admin
      .from("memberships")
      .upsert(
        { user_id: invite.user.id, organization_id, role: "client" },
        { onConflict: "user_id,organization_id" }
      );
    if (memberError) {
      return reply({ error: "초대 메일은 발송됐지만 소속 연결에 실패했습니다: " + memberError.message }, 500);
    }
    return reply({
      ok: true,
      mode: "email",
      email,
      organization: org.name,
      message: `${email}로 초대 메일을 발송했습니다.`
    });
  }

  // 2) Fallback: generate a direct one-time invite/recovery link (handles rate limit & existing users!)
  const errMsg = inviteError?.message || "";
  const isExisting = /already.*registered|already.*exists/i.test(errMsg);

  let targetUserId: string | null = null;
  let actionLink: string | null = null;

  if (isExisting) {
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo: PROD_ORIGIN }
    });
    if (linkErr || !linkData?.user) {
      return reply({ error: `이미 가입된 계정이지만 링크 생성에 실패했습니다: ${linkErr?.message || errMsg}` }, 400);
    }
    targetUserId = linkData.user.id;
    actionLink = linkData.properties?.action_link || null;
  } else {
    // e.g. Supabase free tier hourly email rate limit exceeded -> generate invite link directly!
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "invite",
      email,
      options: { redirectTo: PROD_ORIGIN }
    });
    if (linkErr || !linkData?.user) {
      return reply({ error: `${errMsg} (링크 생성 실패: ${linkErr?.message || "알 수 없음"})` }, 400);
    }
    targetUserId = linkData.user.id;
    actionLink = linkData.properties?.action_link || null;
  }

  const { error: memberError } = await admin
    .from("memberships")
    .upsert(
      { user_id: targetUserId, organization_id, role: "client" },
      { onConflict: "user_id,organization_id" }
    );
  if (memberError) {
    return reply({ error: "소속 연결 실패: " + memberError.message }, 500);
  }

  return reply({
    ok: true,
    mode: "link",
    email,
    organization: org.name,
    invite_link: actionLink,
    message: isExisting
      ? `이미 등록된 이메일(${email})을 '${org.name}'에 연결했습니다. 아래 링크를 카톡으로 전달하세요!`
      : `이메일 시간당 발송 제한으로 카톡 전달용 초대 링크를 대신 생성했습니다!`
  });
});
