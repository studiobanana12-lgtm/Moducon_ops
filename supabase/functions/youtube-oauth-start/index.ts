import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SCOPES_BY_LEVEL: Record<string, string[]> = {
  viewer: [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly"
  ],
  editor: [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    "https://www.googleapis.com/auth/youtube.upload"
  ],
  publisher: [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl"
  ],
  full: [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl"
  ]
};

function isValidReturnUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const allowedEnv = Deno.env.get("ALLOWED_APP_ORIGINS");
    if (allowedEnv) {
      const list = allowedEnv.split(",").map((s) => s.trim()).filter(Boolean);
      return list.includes(u.origin);
    }
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID");
    if (!googleClientId) {
      return jsonResponse({ error: "GOOGLE_CLIENT_ID가 아직 Supabase Secrets에 설정되지 않았습니다." }, 500);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "로그인이 필요합니다." }, 401);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return jsonResponse({ error: "인증 정보가 유효하지 않습니다." }, 401);

    const body = await req.json();
    const organizationId = String(body.organization_id || "");
    const permissionLevel = String(body.permission_level || "viewer");
    const durationDays = body.duration_days == null ? null : Number(body.duration_days);
    const returnUrl = String(body.return_url || "");

    if (!organizationId) return jsonResponse({ error: "organization_id가 필요합니다." }, 400);
    if (!SCOPES_BY_LEVEL[permissionLevel]) {
      return jsonResponse({ error: "허용되지 않은 권한 레벨입니다." }, 400);
    }
    if (!isValidReturnUrl(returnUrl)) {
      return jsonResponse({ error: "허용되지 않은 return_url입니다." }, 400);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Verify user belongs to this organization as client, or is platform admin
    const { data: memberships, error: memErr } = await adminClient
      .from("memberships")
      .select("organization_id, role")
      .eq("user_id", user.id);

    if (memErr || !memberships?.length) {
      return jsonResponse({ error: "소속 권한을 확인할 수 없습니다." }, 403);
    }

    const isClientOfOrg = memberships.some(
      (m) => m.organization_id === organizationId && m.role === "client"
    );
    const isAdmin = memberships.some((m) => m.role === "admin");
    if (!isClientOfOrg && !isAdmin) {
      return jsonResponse({ error: "해당 고객사 소유자 또는 관리자만 SNS를 연결할 수 있습니다." }, 403);
    }

    // Generate cryptographically secure one-time state token
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const stateToken = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

    const accessExpiresAt =
      durationDays && durationDays > 0
        ? new Date(Date.now() + durationDays * 86400 * 1000).toISOString()
        : null;
    const stateExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: stateErr } = await adminClient.from("oauth_states").insert({
      state: stateToken,
      organization_id: organizationId,
      user_id: user.id,
      platform: "youtube",
      permission_level: permissionLevel,
      access_expires_at: accessExpiresAt,
      return_url: returnUrl,
      state_expires_at: stateExpiresAt
    });
    if (stateErr) throw stateErr;

    await adminClient.from("channel_audit_logs").insert({
      organization_id: organizationId,
      actor_id: user.id,
      actor_role: isClientOfOrg ? "client" : "admin",
      action: "oauth_started",
      detail: { platform: "youtube", permission_level: permissionLevel, duration_days: durationDays }
    });

    const redirectUri =
      Deno.env.get("YOUTUBE_REDIRECT_URI") ||
      `${supabaseUrl}/functions/v1/youtube-oauth-callback`;

    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES_BY_LEVEL[permissionLevel].join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: stateToken
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    return jsonResponse({ authUrl });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
