import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { decryptToken } from "../_shared/crypto.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "로그인이 필요합니다." }, 401);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return jsonResponse({ error: "인증 정보가 유효하지 않습니다." }, 401);

    const { channel_id } = await req.json();
    if (!channel_id) return jsonResponse({ error: "channel_id가 필요합니다." }, 400);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: channel, error: chErr } = await adminClient
      .from("social_channels")
      .select("id, organization_id, platform, channel_title, handle")
      .eq("id", channel_id)
      .maybeSingle();

    if (chErr || !channel) return jsonResponse({ error: "채널을 찾을 수 없습니다." }, 404);

    // Verify caller is client of this org or admin
    const { data: memberships } = await adminClient
      .from("memberships")
      .select("organization_id, role")
      .eq("user_id", user.id);

    const isClientOfOrg = (memberships || []).some(
      (m) => m.organization_id === channel.organization_id && m.role === "client"
    );
    const isAdmin = (memberships || []).some((m) => m.role === "admin");
    if (!isClientOfOrg && !isAdmin) {
      return jsonResponse({ error: "채널 연결을 해제할 권한이 없습니다." }, 403);
    }

    // Best-effort revoke at Google's OAuth endpoint
    const { data: tokenRow } = await adminClient
      .from("social_channel_tokens")
      .select("access_token_enc, refresh_token_enc")
      .eq("channel_id", channel.id)
      .maybeSingle();

    let googleRevoked = false;
    if (tokenRow) {
      try {
        const tokenToRevoke = tokenRow.refresh_token_enc
          ? await decryptToken(tokenRow.refresh_token_enc)
          : await decryptToken(tokenRow.access_token_enc);
        const revokeRes = await fetch(
          `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenToRevoke)}`,
          { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }
        );
        googleRevoked = revokeRes.ok;
      } catch {
        // Proceed with local token deletion even if Google already invalidated the token
      }
    }

    // Permanently delete stored tokens & cached channel snapshots, then mark channel revoked
    await adminClient.from("social_channel_tokens").delete().eq("channel_id", channel.id);
    await adminClient.from("social_channel_snapshots").delete().eq("channel_id", channel.id);

    const nowIso = new Date().toISOString();
    await adminClient
      .from("social_channels")
      .update({ status: "revoked", revoked_at: nowIso, updated_at: nowIso })
      .eq("id", channel.id);

    await adminClient.from("channel_audit_logs").insert({
      organization_id: channel.organization_id,
      channel_id: channel.id,
      actor_id: user.id,
      actor_role: isClientOfOrg ? "client" : "admin",
      action: "channel_revoked",
      detail: {
        platform: channel.platform,
        channel_title: channel.channel_title,
        handle: channel.handle,
        google_revoked: googleRevoked
      }
    });

    return jsonResponse({ ok: true, googleRevoked });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
