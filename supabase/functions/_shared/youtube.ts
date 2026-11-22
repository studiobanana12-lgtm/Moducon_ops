import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptToken, encryptToken } from "./crypto.ts";

export async function getValidYouTubeAccessToken(
  adminClient: SupabaseClient,
  channelId: string
): Promise<string> {
  const { data: channel, error: chErr } = await adminClient
    .from("social_channels")
    .select("id, status, expires_at")
    .eq("id", channelId)
    .maybeSingle();

  if (chErr || !channel) throw new Error("연결된 YouTube 채널을 찾을 수 없습니다.");
  if (channel.status !== "connected") {
    throw new Error("현재 연결 상태가 아닙니다. 고객사의 재승인이 필요합니다.");
  }

  // Enforce client-configured delegation expiry
  if (channel.expires_at && new Date(channel.expires_at).getTime() <= Date.now()) {
    await adminClient
      .from("social_channels")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("id", channelId);
    throw new Error("고객사가 설정한 권한 유효 기간이 만료되었습니다. 재승인을 요청하세요.");
  }

  const { data: tok, error: tokErr } = await adminClient
    .from("social_channel_tokens")
    .select("access_token_enc, refresh_token_enc, token_expires_at")
    .eq("channel_id", channelId)
    .maybeSingle();

  if (tokErr || !tok) {
    throw new Error("저장된 인증 토큰이 없습니다. 채널을 다시 연결해 주세요.");
  }

  const expiresMs = tok.token_expires_at ? new Date(tok.token_expires_at).getTime() : 0;
  const needsRefresh = !expiresMs || expiresMs - Date.now() < 2 * 60 * 1000;

  if (!needsRefresh) {
    return decryptToken(tok.access_token_enc);
  }

  if (!tok.refresh_token_enc) {
    throw new Error("토큰이 만료되었고 갱신 토큰이 없습니다. 고객사 재승인이 필요합니다.");
  }

  const refreshToken = await decryptToken(tok.refresh_token_enc);
  const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
  const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: googleClientId,
      client_secret: googleClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  const data = await res.json();

  if (!res.ok || !data.access_token) {
    if (data.error === "invalid_grant") {
      await adminClient
        .from("social_channels")
        .update({ status: "expired", updated_at: new Date().toISOString() })
        .eq("id", channelId);
      throw new Error("Google에서 권한이 철회되었거나 만료되었습니다. 재승인이 필요합니다.");
    }
    throw new Error(data.error_description || data.error || "Google 토큰 자동 갱신 실패");
  }

  const nextAccessEnc = await encryptToken(data.access_token);
  const nextExpiresIso = data.expires_in
    ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
    : null;

  await adminClient
    .from("social_channel_tokens")
    .update({
      access_token_enc: nextAccessEnc,
      token_expires_at: nextExpiresIso,
      updated_at: new Date().toISOString()
    })
    .eq("channel_id", channelId);

  return data.access_token;
}
