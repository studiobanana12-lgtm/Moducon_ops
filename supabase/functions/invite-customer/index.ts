import { createClient } from "npm:@supabase/supabase-js@2";

const PROD_ORIGIN = "https://moduconops.vercel.app";
const ALLOWED_ORIGINS = new Set([
  PROD_ORIGIN,
  "http://localhost:8765",
  "http://127.0.0.1:8765"
]);

function corsHeaders(reqOrigin: string | null) {
  const allow = reqOrigin && ALLOWED_ORIGINS.has(reqOrigin) ? reqOrigin : PROD_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
}

Deno.serve(async (req) => {
  const reqOrigin = req.headers.get("origin");
  const cors = corsHeaders(reqOrigin);
  const reply = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: cors });

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  if (!reqOrigin || !ALLOWED_ORIGINS.has(reqOrigin)) {
    return reply({ error: "Origin not allowed" }, 403);
  }

  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "Authentication required" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!url || !anon || !service) return reply({ error: "Server configuration missing" }, 503);

  const auth = createClient(url, anon, {
    global: { headers: { Authorization: "Bearer " + token } }
  });
  const { data: { user }, error: userError } = await auth.auth.getUser(token);
  if (userError || !user) return reply({ error: "Invalid session" }, 401);

  const { data: roles, error: roleError } = await auth
    .from("memberships")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .limit(1);
  if (roleError || !roles?.length) return reply({ error: "Administrator access required" }, 403);

  let body;
  try {
    body = await req.json();
  } catch {
    return reply({ error: "Invalid JSON" }, 400);
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

  // Always send invited clients to the live Vercel production URL
  const { data: invite, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: PROD_ORIGIN
  });
  if (inviteError) return reply({ error: inviteError.message }, 400);

  const { error: memberError } = await admin
    .from("memberships")
    .upsert(
      { user_id: invite.user.id, organization_id, role: "client" },
      { onConflict: "user_id,organization_id" }
    );
  if (memberError) {
    return reply(
      { error: "초대 메일은 발송됐지만 소속 연결에 실패했습니다. 관리자에게 문의하세요." },
      500
    );
  }

  return reply({ ok: true, email, organization: org.name });
});
