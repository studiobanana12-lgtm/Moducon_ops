import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encryptToken } from "../_shared/crypto.ts";

function buildRedirect(baseUrl: string, params: Record<string, string>) {
  const url = new URL(baseUrl);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return Response.redirect(url.toString(), 302);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
  const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
  const redirectUri =
    Deno.env.get("YOUTUBE_REDIRECT_URI") ||
    `${supabaseUrl}/functions/v1/youtube-oauth-callback`;

  if (!stateToken) {
    return new Response("Missing OAuth state parameter.", { status: 400 });
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // Atomically fetch and consume the one-time state token
  const { data: stateRow, error: stateErr } = await adminClient
    .from("oauth_states")
    .select("*")
    .eq("state", stateToken)
    .maybeSingle();

  if (stateErr || !stateRow) {
    return new Response("Invalid or already-used OAuth state.", { status: 400 });
  }

  await adminClient.from("oauth_states").delete().eq("state", stateToken);

  if (new Date(stateRow.state_expires_at).getTime() < Date.now()) {
    return buildRedirect(stateRow.return_url, {
      tab: "channels",
      oauth: "error",
      reason: "인증 요청 시간이 만료되었습니다. 다시 시도해 주세요."
    });
  }

  if (oauthError || !code) {
    return buildRedirect(stateRow.return_url, {
      tab: "channels",
      oauth: "cancelled",
      reason: oauthError || "사용자가 승인을 취소했습니다."
    });
  }

  try {
    // 1. Exchange authorization code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || "Google 토큰 발급 실패");
    }

    // 2. Fetch YouTube channel identity
    const ytRes = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );
    const ytData = await ytRes.json();
    const channel = ytData?.items?.[0];
    if (!ytRes.ok || !channel) {
      throw new Error("선택한 Google 계정에 생성된 YouTube 채널이 없습니다.");
    }

    const snippet = channel.snippet || {};
    const handle = snippet.customUrl || snippet.title || channel.id;
    const channelTitle = snippet.title || handle;
    const avatarUrl = snippet.thumbnails?.default?.url || null;
    const nowIso = new Date().toISOString();

    // 3. Upsert social_channels metadata
    const { data: savedChannel, error: chErr } = await adminClient
      .from("social_channels")
      .upsert(
        {
          organization_id: stateRow.organization_id,
          platform: "youtube",
          external_account_id: channel.id,
          handle,
          channel_title: channelTitle,
          avatar_url: avatarUrl,
          status: "connected",
          permission_level: stateRow.permission_level,
          connected_by: stateRow.user_id,
          connected_at: nowIso,
          expires_at: stateRow.access_expires_at,
          revoked_at: null,
          updated_at: nowIso
        },
        { onConflict: "organization_id,platform" }
      )
      .select("id")
      .single();

    if (chErr || !savedChannel) throw chErr || new Error("채널 저장 실패");

    // 4. Encrypt and store tokens in server-only table
    const accessTokenEnc = await encryptToken(tokenData.access_token);
    const refreshTokenEnc = tokenData.refresh_token
      ? await encryptToken(tokenData.refresh_token)
      : null;
    const tokenExpiresAt = tokenData.expires_in
      ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
      : null;

    const tokenPayload: Record<string, unknown> = {
      channel_id: savedChannel.id,
      access_token_enc: accessTokenEnc,
      scope: tokenData.scope || "",
      token_expires_at: tokenExpiresAt,
      updated_at: nowIso
    };
    if (refreshTokenEnc) tokenPayload.refresh_token_enc = refreshTokenEnc;

    const { error: tokErr } = await adminClient
      .from("social_channel_tokens")
      .upsert(tokenPayload, { onConflict: "channel_id" });
    if (tokErr) throw tokErr;

    // 5. Write audit log
    const { data: actorMem } = await adminClient
      .from("memberships")
      .select("role")
      .eq("user_id", stateRow.user_id)
      .eq("organization_id", stateRow.organization_id)
      .maybeSingle();

    await adminClient.from("channel_audit_logs").insert({
      organization_id: stateRow.organization_id,
      channel_id: savedChannel.id,
      actor_id: stateRow.user_id,
      actor_role: actorMem?.role || "admin",
      action: "channel_connected",
      detail: {
        platform: "youtube",
        channel_title: channelTitle,
        handle,
        permission_level: stateRow.permission_level,
        expires_at: stateRow.access_expires_at
      }
    });

    return buildRedirect(stateRow.return_url, {
      tab: "channels",
      oauth: "success",
      platform: "youtube"
    });
  } catch (err) {
    return buildRedirect(stateRow.return_url, {
      tab: "channels",
      oauth: "error",
      reason: err instanceof Error ? err.message : String(err)
    });
  }
});
