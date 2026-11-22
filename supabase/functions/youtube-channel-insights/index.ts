import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getValidYouTubeAccessToken } from "../_shared/youtube.ts";

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes default cache to protect YouTube API quota

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

    const { channel_id, force_refresh = false } = await req.json();
    if (!channel_id) return jsonResponse({ error: "channel_id가 필요합니다." }, 400);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: channel, error: chErr } = await adminClient
      .from("social_channels")
      .select("id, organization_id, platform, status, permission_level, expires_at")
      .eq("id", channel_id)
      .maybeSingle();

    if (chErr || !channel) return jsonResponse({ error: "채널을 찾을 수 없습니다." }, 404);
    if (channel.platform !== "youtube") {
      return jsonResponse({ error: "현재는 YouTube 채널 조회만 지원합니다." }, 400);
    }

    // Verify caller has read access (staff OR client of this organization)
    const { data: memberships } = await adminClient
      .from("memberships")
      .select("organization_id, role")
      .eq("user_id", user.id);

    const staffRole = (memberships || []).find((m) => ["admin", "staff"].includes(m.role))?.role;
    const isClientOfOrg = (memberships || []).some(
      (m) => m.organization_id === channel.organization_id && m.role === "client"
    );
    if (!staffRole && !isClientOfOrg) {
      return jsonResponse({ error: "이 채널을 조회할 권한이 없습니다." }, 403);
    }

    // Return cached snapshot if fresh and not forced
    if (!force_refresh) {
      const { data: cached } = await adminClient
        .from("social_channel_snapshots")
        .select("*")
        .eq("channel_id", channel.id)
        .maybeSingle();

      if (cached && Date.now() - new Date(cached.synced_at).getTime() < CACHE_TTL_MS) {
        return jsonResponse({ snapshot: cached, cached: true });
      }
    }

    // Acquire valid (auto-refreshed) OAuth access token
    const accessToken = await getValidYouTubeAccessToken(adminClient, channel.id);

    // 1. Fetch live channel profile, statistics, and uploads playlist ID
    const chRes = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const chData = await chRes.json();
    const ytChannel = chData?.items?.[0];
    if (!chRes.ok || !ytChannel) {
      throw new Error(chData?.error?.message || "YouTube 채널 정보를 불러오지 못했습니다.");
    }

    const snippet = ytChannel.snippet || {};
    const stats = ytChannel.statistics || {};
    const uploadsPlaylistId = ytChannel.contentDetails?.relatedPlaylists?.uploads;

    // 2. Fetch up to 12 most recent uploaded video IDs
    let recentVideos: Array<Record<string, unknown>> = [];
    if (uploadsPlaylistId) {
      const plRes = await fetch(
        `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${encodeURIComponent(uploadsPlaylistId)}&maxResults=12`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const plData = await plRes.json();
      const ids = (plData?.items || [])
        .map((it: { contentDetails?: { videoId?: string } }) => it.contentDetails?.videoId)
        .filter(Boolean);

      if (ids.length) {
        const vidRes = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails,status&id=${encodeURIComponent(ids.join(","))}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const vidData = await vidRes.json();
        recentVideos = (vidData?.items || []).map((v: Record<string, any>) => ({
          id: v.id,
          title: v.snippet?.title || "(제목 없음)",
          thumbnail: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || "",
          publishedAt: v.snippet?.publishedAt || "",
          privacyStatus: v.status?.privacyStatus || "public",
          views: Number(v.statistics?.viewCount || 0),
          likes: Number(v.statistics?.likeCount || 0),
          comments: Number(v.statistics?.commentCount || 0),
          duration: v.contentDetails?.duration || ""
        }));
      }
    }

    const nowIso = new Date().toISOString();

    // Update channel metadata (title/handle/avatar) in case owner changed it on YouTube
    await adminClient
      .from("social_channels")
      .update({
        channel_title: snippet.title || undefined,
        handle: snippet.customUrl || undefined,
        avatar_url: snippet.thumbnails?.default?.url || undefined,
        updated_at: nowIso
      })
      .eq("id", channel.id);

    // Save snapshot cache
    const snapshotPayload = {
      channel_id: channel.id,
      organization_id: channel.organization_id,
      subscriber_count: Number(stats.subscriberCount || 0),
      view_count: Number(stats.viewCount || 0),
      video_count: Number(stats.videoCount || 0),
      recent_videos: recentVideos,
      synced_at: nowIso
    };

    const { error: snapErr } = await adminClient
      .from("social_channel_snapshots")
      .upsert(snapshotPayload, { onConflict: "channel_id" });
    if (snapErr) throw snapErr;

    // Record transparent audit log whenever live data is synced
    await adminClient.from("channel_audit_logs").insert({
      organization_id: channel.organization_id,
      channel_id: channel.id,
      actor_id: user.id,
      actor_role: isClientOfOrg ? "client" : (staffRole || "staff"),
      action: "stats_synced",
      detail: {
        platform: "youtube",
        channel_title: snippet.title || "",
        subscribers: snapshotPayload.subscriber_count,
        videos_fetched: recentVideos.length
      }
    });

    return jsonResponse({ snapshot: snapshotPayload, cached: false });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
