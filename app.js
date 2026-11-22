(() => {
  const STATUS_META = {
    draft: { label: "초안", cls: "pill-muted" },
    review: { label: "승인 대기", cls: "pill-review" },
    revision: { label: "수정 요청", cls: "pill-revision" },
    approved: { label: "승인 완료", cls: "pill-approved" },
    scheduled: { label: "게시 예정", cls: "" },
    published: { label: "게시 완료", cls: "pill-published" }
  };

  const SCHEDULE_STATUS = {
    planned: { label: "예정됨", cls: "" },
    published: { label: "게시 완료", cls: "pill-published" },
    cancelled: { label: "취소됨", cls: "pill-muted" }
  };

  const CHANNEL_STATUS = {
    connected: { label: "승인·연결됨", cls: "pill-approved" },
    pending: { label: "승인 대기", cls: "pill-review" },
    expired: { label: "만료됨", cls: "pill-warn" },
    revoked: { label: "연결 해제됨", cls: "pill-revision" }
  };

  const PERMISSION_LEVELS = {
    viewer: {
      short: "Lv.1 열람 전용",
      desc: "채널 정보·구독자·조회수·영상 목록 조회만 허용 (가장 안전)"
    },
    editor: {
      short: "Lv.2 초안·보조",
      desc: "열람 권한 + 비공개 초안 업로드 허용"
    },
    publisher: {
      short: "Lv.3 운영 대행",
      desc: "열람 권한 + 영상 게시·예약 및 댓글 관리 허용"
    },
    full: {
      short: "Lv.4 풀 매니저",
      desc: "전반적인 채널 운영 위임 (계정 삭제·비밀번호·결제는 원천 차단)"
    }
  };

  const AUDIT_LABELS = {
    oauth_started: "YouTube 승인 절차 시작",
    channel_connected: "YouTube 채널 승인·연결 완료",
    permission_updated: "위임 권한 범위/기간 변경",
    channel_revoked: "즉시 연결 해제 (토큰 영구 폐기)",
    stats_synced: "YouTube 채널 성과·피드 실시간 조회"
  };

  const PRIVACY_META = {
    public: { label: "공개", cls: "pill-approved" },
    unlisted: { label: "일부 공개", cls: "pill-review" },
    private: { label: "비공개", cls: "pill-muted" }
  };

  const PLATFORMS = [
    { id: "youtube", name: "YouTube", ready: true },
    { id: "instagram", name: "Instagram", ready: false },
    { id: "tiktok", name: "TikTok", ready: false },
    { id: "threads", name: "Threads", ready: false },
    { id: "x", name: "X (Twitter)", ready: false },
    { id: "naver", name: "네이버 블로그 (반자동)", ready: false }
  ];

  const state = {
    sb: null,
    session: null,
    roles: [],
    orgs: [],
    videos: [],
    schedules: [],
    channels: [],
    snapshots: {},
    auditLogs: [],
    kakaoUrl: "",
    page: "home",
    selectedOrgId: "all",
    videoStatusFilter: "all",
    feedSort: "recent",
    syncingChannelId: null,
    error: "",
    recoveryMode: false,
    oauthNoticeHandled: false
  };

  const el = document.getElementById("app");
  const logoutBtn = document.getElementById("logout");
  const roleBadge = document.getElementById("roleBadge");
  const toastEl = document.getElementById("toast");
  let toastTimer = null;

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));

  const fmtDate = (s) =>
    new Date(s).toLocaleString("ko-KR", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });

  const fmtExpiry = (iso) => {
    if (!iso) return "무기한 (직접 해제 시까지)";
    const diffDays = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
    const dateStr = new Date(iso).toLocaleDateString("ko-KR");
    return diffDays > 0 ? `${dateStr} (D-${diffDays})` : `${dateStr} (만료됨)`;
  };

  const fmtNum = (n) => Number(n || 0).toLocaleString("ko-KR");

  const fmtDuration = (iso) => {
    if (!iso) return "";
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
    if (!m) return iso;
    const h = Number(m[1] || 0);
    const min = Number(m[2] || 0);
    const sec = Number(m[3] || 0);
    const pad = (x) => String(x).padStart(2, "0");
    return h > 0 ? `${h}:${pad(min)}:${pad(sec)}` : `${min}:${pad(sec)}`;
  };

  const configured = Boolean(
    window.MODUCON_MOCK_CLIENT ||
      (window.MODUCON_SUPABASE_URL && window.MODUCON_SUPABASE_ANON_KEY)
  );

  function showToast(message, type = "ok") {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = "toast show " + (type === "error" ? "toast-error" : "toast-ok");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("show");
    }, 3600);
  }

  const isAdmin = () => state.roles.some((r) => r.role === "admin");
  const isStaff = () => state.roles.some((r) => r.role === "admin" || r.role === "staff");
  const clientOrgs = () => state.orgs.filter((o) => o.name !== "모두콘 (내부 운영)");
  const myOrgName = (id) => state.orgs.find((o) => o.id === id)?.name || "고객사";

  function primaryClientOrg() {
    if (isStaff()) {
      return state.selectedOrgId !== "all"
        ? clientOrgs().find((o) => o.id === state.selectedOrgId) || null
        : null;
    }
    return state.orgs[0] || null;
  }

  function filteredVideos() {
    let list = state.videos;
    if (isStaff() && state.selectedOrgId !== "all") {
      list = list.filter((v) => v.organization_id === state.selectedOrgId);
    }
    return list;
  }

  function filteredSchedules() {
    let list = state.schedules;
    if (isStaff() && state.selectedOrgId !== "all") {
      list = list.filter((s) => s.organization_id === state.selectedOrgId);
    }
    return list;
  }

  function filteredChannels() {
    if (isStaff()) {
      return state.selectedOrgId === "all"
        ? state.channels
        : state.channels.filter((c) => c.organization_id === state.selectedOrgId);
    }
    const org = primaryClientOrg();
    return org ? state.channels.filter((c) => c.organization_id === org.id) : state.channels;
  }

  function filteredAuditLogs() {
    if (isStaff()) {
      return state.selectedOrgId === "all"
        ? state.auditLogs
        : state.auditLogs.filter((l) => l.organization_id === state.selectedOrgId);
    }
    const org = primaryClientOrg();
    return org ? state.auditLogs.filter((l) => l.organization_id === org.id) : state.auditLogs;
  }

  function menus() {
    return isStaff()
      ? [
          ["home", "대시보드"],
          ["clients", "고객사 관리"],
          ["channels", "SNS 연동"],
          ["videos", "영상 관리"],
          ["calendar", "게시 일정"],
          ["stats", "성과 분석"],
          ["talk", "카톡 상담"]
        ]
      : [
          ["home", "내 대시보드"],
          ["channels", "SNS 승인"],
          ["videos", "영상 확인"],
          ["calendar", "게시 일정"],
          ["stats", "성과 확인"],
          ["talk", "상담"]
        ];
  }

  function statusPill(status, map = STATUS_META) {
    const meta = map[status] || { label: status, cls: "pill-muted" };
    return `<span class="pill ${meta.cls}">${esc(meta.label)}</span>`;
  }

  function box(inner) {
    return `<section class="card">${inner}</section>`;
  }

  function updateHeader(loggedIn) {
    logoutBtn.style.display = loggedIn ? "inline-block" : "none";
    if (!roleBadge) return;
    if (!loggedIn || !state.roles.length) {
      roleBadge.style.display = "none";
      return;
    }
    roleBadge.style.display = "inline-block";
    roleBadge.textContent = isAdmin() ? "관리자" : isStaff() ? "운영 직원" : "고객사";
  }

  function handleUrlParamsOnce() {
    if (state.oauthNoticeHandled) return;
    const params = new URLSearchParams(location.search);
    const tab = params.get("tab");
    const oauth = params.get("oauth");
    const reason = params.get("reason");
    if (tab && menus().some(([id]) => id === tab)) {
      state.page = tab;
    }
    if (oauth === "success") {
      showToast("YouTube 채널 승인과 연결이 안전하게 완료되었습니다!");
    } else if (oauth === "cancelled") {
      showToast("YouTube 승인이 취소되었습니다.", "error");
    } else if (oauth === "error") {
      showToast("연결 실패: " + (reason || "알 수 없는 오류"), "error");
    }
    if (tab || oauth) {
      state.oauthNoticeHandled = true;
      history.replaceState(null, "", location.pathname);
    }
  }

  /* ── Auth Views ── */
  function renderLogin() {
    updateHeader(false);
    el.innerHTML = `
      <section class="card auth">
        <h1>모두콘 OPS 로그인</h1>
        <p>모두콘 직원과 고객사가 각자 자신의 계정으로 접속합니다.</p>
        ${
          configured
            ? ""
            : `<div class="alert">현재 Supabase 연결 설정이 필요합니다. 관리자가 프로젝트 URL과 공개 키를 설정해야 로그인할 수 있습니다.</div>`
        }
        <form id="loginForm">
          <label>이메일
            <input id="email" type="email" required autocomplete="username" placeholder="name@company.com">
          </label>
          <label>비밀번호
            <input id="password" type="password" required autocomplete="current-password">
          </label>
          <button class="primary wide" ${!configured ? "disabled" : ""}>로그인</button>
        </form>
        ${state.error ? `<p class="error" id="err">${esc(state.error)}</p>` : ""}
        <p style="margin-top:14px">
          <a href="#" id="forgotLink">비밀번호 설정 / 재설정 메일 받기</a>
        </p>
        <p class="muted">고객 계정은 모두콘 관리자가 초대합니다. 공개 회원가입은 제공하지 않습니다.</p>
      </section>
    `;
    document.getElementById("loginForm")?.addEventListener("submit", signIn);
    document.getElementById("forgotLink")?.addEventListener("click", forgotPassword);
  }

  function renderPasswordForm() {
    updateHeader(false);
    el.innerHTML = `
      <section class="card auth">
        <h1>새 비밀번호 설정</h1>
        <p>모두콘 OPS 로그인에 사용할 새 비밀번호(8자 이상)를 입력하세요.</p>
        <form id="pwForm">
          <label>새 비밀번호
            <input id="newpassword" type="password" minlength="8" required autocomplete="new-password">
          </label>
          <button class="primary wide">비밀번호 저장</button>
        </form>
        <p class="error" id="pwerr"></p>
      </section>
    `;
    document.getElementById("pwForm")?.addEventListener("submit", savePassword);
  }

  async function signIn(e) {
    e.preventDefault();
    if (!state.sb) return;
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const { error } = await state.sb.auth.signInWithPassword({ email, password });
    if (error) {
      state.error = error.message;
      renderLogin();
    } else {
      state.error = "";
      if (window.MODUCON_MOCK_CLIENT) await refresh();
    }
  }

  async function forgotPassword(e) {
    e.preventDefault();
    if (!state.sb) return;
    const email = prompt("비밀번호 설정 메일을 받을 이메일을 입력하세요", "");
    if (!email) return;
    const { error } = await state.sb.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: location.origin + location.pathname
    });
    if (error) {
      showToast("메일 발송 실패: " + error.message, "error");
    } else {
      showToast("비밀번호 설정 메일을 발송했습니다. 메일함을 확인하세요.");
    }
  }

  async function savePassword(e) {
    e.preventDefault();
    const password = document.getElementById("newpassword").value;
    const { error } = await state.sb.auth.updateUser({ password });
    if (error) {
      document.getElementById("pwerr").textContent = error.message;
      return;
    }
    state.recoveryMode = false;
    history.replaceState(null, "", location.pathname);
    showToast("비밀번호 설정이 완료되었습니다.");
    await refresh();
  }

  async function logout() {
    await state.sb?.auth.signOut();
    state.session = null;
    state.roles = [];
    state.selectedOrgId = "all";
    renderLogin();
  }

  /* ── Data Loading ── */
  async function refresh() {
    if (!state.sb) return;
    const { data: { session } } = await state.sb.auth.getSession();
    state.session = session;
    if (!session) {
      state.roles = [];
      state.orgs = [];
      state.error = "";
      renderLogin();
      return;
    }

    const [m, o] = await Promise.all([
      state.sb.from("memberships").select("organization_id,role").eq("user_id", session.user.id),
      state.sb.from("organizations").select("id,name").order("created_at", { ascending: true })
    ]);

    if (m.error || o.error) {
      updateHeader(true);
      el.innerHTML = box(
        `<h1>계정 권한 확인 필요</h1><p>${esc(m.error?.message || o.error?.message)}</p><p>관리자에게 소속 회사 및 역할 설정을 요청하세요.</p>`
      );
      return;
    }

    state.roles = m.data || [];
    if (!state.roles.length) {
      updateHeader(true);
      el.innerHTML = box(
        `<h1>접근 권한 없음</h1><p>이 계정에는 아직 고객사 또는 직원 역할이 부여되지 않았습니다. 모두콘 관리자에게 문의하세요.</p>`
      );
      return;
    }

    state.orgs = o.data || [];
    if (state.selectedOrgId !== "all" && !clientOrgs().some((x) => x.id === state.selectedOrgId)) {
      state.selectedOrgId = "all";
    }

    const [v, sc, ch, ka, al, sn] = await Promise.all([
      state.sb
        .from("videos")
        .select("id,title,status,organization_id,created_at,storage_path,feedback")
        .order("created_at", { ascending: false })
        .limit(150),
      state.sb
        .from("publish_schedule")
        .select("id,organization_id,video_id,platform,scheduled_at,status")
        .order("scheduled_at", { ascending: true })
        .limit(200),
      state.sb
        .from("social_channels")
        .select("id,organization_id,platform,handle,channel_title,avatar_url,external_account_id,status,permission_level,connected_at,expires_at,revoked_at"),
      state.sb.from("app_settings").select("value").eq("key", "kakao_channel_url").maybeSingle(),
      state.sb
        .from("channel_audit_logs")
        .select("id,organization_id,actor_role,action,detail,created_at")
        .order("created_at", { ascending: false })
        .limit(30),
      state.sb
        .from("social_channel_snapshots")
        .select("channel_id,organization_id,subscriber_count,view_count,video_count,recent_videos,synced_at")
    ]);

    if (v.error) {
      updateHeader(true);
      el.innerHTML = box(`<h1>영상 목록을 불러올 수 없습니다.</h1><p>${esc(v.error.message)}</p>`);
      return;
    }

    state.videos = v.data || [];
    state.schedules = sc.data || [];
    state.channels = ch.data || [];
    state.kakaoUrl = ka.data?.value || "";
    state.auditLogs = al.data || [];
    state.snapshots = {};
    (sn.data || []).forEach((row) => {
      state.snapshots[row.channel_id] = row;
    });

    handleUrlParamsOnce();
    render();
  }

  /* ── Step 2: YouTube OAuth & Delegation Mutations ── */
  async function connectYouTube(e) {
    e.preventDefault();
    const org = primaryClientOrg();
    if (!org) {
      showToast("먼저 상단 워크스페이스에서 고객사를 선택하세요.", "error");
      return;
    }
    const permission_level = document.getElementById("ytPermLevel")?.value || "viewer";
    const durationRaw = document.getElementById("ytDuration")?.value || "";
    const duration_days = durationRaw ? Number(durationRaw) : null;
    const btn = document.getElementById("ytConnectBtn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Google 승인 페이지 준비 중...";
    }
    try {
      if (window.MODUCON_MOCK_CLIENT?.startYouTubeOAuth) {
        const ok = await window.MODUCON_MOCK_CLIENT.startYouTubeOAuth({
          organization_id: org.id,
          permission_level,
          duration_days
        });
        await refresh();
        if (ok) showToast("YouTube 채널 승인과 연결이 완료되었습니다! (데모)");
        return;
      }
      const { data: { session } } = await state.sb.auth.getSession();
      const res = await fetch(window.MODUCON_SUPABASE_URL + "/functions/v1/youtube-oauth-start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + session.access_token,
          apikey: window.MODUCON_SUPABASE_ANON_KEY
        },
        body: JSON.stringify({
          organization_id: org.id,
          permission_level,
          duration_days,
          return_url: location.origin + location.pathname
        })
      });
      const data = await res.json();
      if (!res.ok || !data.authUrl) throw new Error(data.error || "OAuth 시작 실패");
      location.href = data.authUrl;
    } catch (err) {
      showToast("YouTube 연결 실패: " + err.message, "error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Google 계정으로 YouTube 승인·연결하기";
      }
    }
  }

  async function updateChannelPermission(e) {
    e.preventDefault();
    const channelId = e.target.dataset.channelId;
    const permission_level = document.getElementById("editYtPermLevel").value;
    const durationRaw = document.getElementById("editYtDuration").value;
    const duration_days = durationRaw ? Number(durationRaw) : null;
    const { error } = await state.sb.rpc("update_channel_permission", {
      p_channel_id: channelId,
      p_permission_level: permission_level,
      p_duration_days: duration_days
    });
    if (error) {
      showToast("권한 변경 실패: " + error.message, "error");
      return;
    }
    await refresh();
    showToast("위임 권한 범위와 만료 기간이 업데이트되었습니다.");
  }

  async function revokeChannel(channelId) {
    if (
      !confirm(
        "정말 YouTube 연결을 즉시 차단(해제)할까요?\n\nGoogle 인증 토큰이 영구 폐기되며, 대행사는 즉시 채널에 접근할 수 없게 됩니다."
      )
    ) {
      return;
    }
    try {
      if (window.MODUCON_MOCK_CLIENT?.revokeYouTubeOAuth) {
        await window.MODUCON_MOCK_CLIENT.revokeYouTubeOAuth({ channel_id: channelId });
        await refresh();
        showToast("YouTube 연결이 즉시 차단되고 토큰이 폐기되었습니다.");
        return;
      }
      const { data: { session } } = await state.sb.auth.getSession();
      const res = await fetch(window.MODUCON_SUPABASE_URL + "/functions/v1/youtube-oauth-revoke", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + session.access_token,
          apikey: window.MODUCON_SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ channel_id: channelId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "연결 해제 실패");
      await refresh();
      showToast("YouTube 연결이 즉시 차단되고 토큰이 폐기되었습니다.");
    } catch (err) {
      showToast("연결 해제 실패: " + err.message, "error");
    }
  }

  async function copyApprovalLink(orgName) {
    const link = `${location.origin}${location.pathname}?tab=channels`;
    try {
      await navigator.clipboard.writeText(link);
      showToast(`${orgName} 고객에게 보낼 SNS 승인 링크를 복사했습니다.`);
    } catch {
      prompt(`${orgName} 고객에게 아래 링크를 전달하세요:`, link);
    }
  }

  /* ── Step 3: Live YouTube Insights & Feed Sync ── */
  async function syncChannelInsights(channelId, forceRefresh = true) {
    if (!channelId || state.syncingChannelId) return;
    state.syncingChannelId = channelId;
    render();
    try {
      if (window.MODUCON_MOCK_CLIENT?.syncYouTubeInsights) {
        await window.MODUCON_MOCK_CLIENT.syncYouTubeInsights({
          channel_id: channelId,
          force_refresh: forceRefresh
        });
        state.syncingChannelId = null;
        await refresh();
        showToast("YouTube 채널 통계와 최근 영상 피드를 최신화했습니다.");
        return;
      }
      const { data: { session } } = await state.sb.auth.getSession();
      const res = await fetch(
        window.MODUCON_SUPABASE_URL + "/functions/v1/youtube-channel-insights",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + session.access_token,
            apikey: window.MODUCON_SUPABASE_ANON_KEY
          },
          body: JSON.stringify({ channel_id: channelId, force_refresh: forceRefresh })
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "채널 조회 실패");
      state.syncingChannelId = null;
      await refresh();
      showToast(
        data.cached
          ? "최근 15분 이내 캐시된 채널 데이터를 불러왔습니다."
          : "YouTube 실시간 통계와 최근 영상을 동기화했습니다."
      );
    } catch (err) {
      state.syncingChannelId = null;
      render();
      showToast("채널 조회 실패: " + err.message, "error");
    }
  }

  /* ── Step 1 Mutations ── */
  async function createCustomer(e) {
    e.preventDefault();
    if (!isAdmin()) return;
    const input = document.getElementById("customerName");
    const name = input?.value.trim();
    if (!name || name.length < 2) return;
    const btn = document.getElementById("createCustomerButton");
    btn.disabled = true;
    const { error } = await state.sb.rpc("create_customer_organization", { customer_name: name });
    if (error) {
      showToast("고객사 등록 실패: " + error.message, "error");
      btn.disabled = false;
      return;
    }
    await refresh();
    state.page = "clients";
    render();
    showToast(`고객사 '${name}'가 등록되었습니다.`);
  }

  async function inviteCustomer(e) {
    e.preventDefault();
    if (!isAdmin()) return;
    const email = document.getElementById("inviteEmail").value.trim();
    const organization_id = document.getElementById("inviteOrg").value;
    const btn = document.getElementById("inviteButton");
    btn.disabled = true;
    try {
      if (window.MODUCON_MOCK_CLIENT?.inviteCustomer) {
        await window.MODUCON_MOCK_CLIENT.inviteCustomer({ email, organization_id });
        showToast(`${email}로 고객 초대 메일을 발송했습니다.`);
        document.getElementById("inviteEmail").value = "";
        return;
      }
      const { data: { session } } = await state.sb.auth.getSession();
      const res = await fetch(window.MODUCON_SUPABASE_URL + "/functions/v1/invite-customer", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + session.access_token,
          apikey: window.MODUCON_SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ email, organization_id })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "초대 실패");
      document.getElementById("inviteEmail").value = "";
      showToast(`${email}로 고객 초대 메일을 발송했습니다.`);
    } catch (err) {
      showToast("초대 실패: " + err.message, "error");
    } finally {
      btn.disabled = false;
    }
  }

  async function uploadVideo(e) {
    e.preventDefault();
    if (!isStaff()) return;
    const org = document.getElementById("videoOrg").value;
    const title = document.getElementById("videoTitle").value.trim();
    const file = document.getElementById("videoFile").files[0];
    const btn = document.getElementById("uploadButton");
    if (!org || !title) return;
    if (!file && !window.MODUCON_MOCK_CLIENT) return;
    if (file) {
      if (file.size > 100 * 1024 * 1024) {
        showToast("100MB 이하 영상만 업로드할 수 있습니다.", "error");
        return;
      }
      if (!["video/mp4", "video/quicktime", "video/webm"].includes(file.type)) {
        showToast("MP4, MOV, WebM 파일만 지원합니다.", "error");
        return;
      }
    }
    btn.disabled = true;
    btn.textContent = "업로드 중...";
    const ext = file ? (file.name.split(".").pop() || "mp4").replace(/[^a-z0-9]/gi, "") : "mp4";
    const path = `${org}/${crypto.randomUUID()}.${ext}`;
    try {
      const up = await state.sb.storage
        .from("client-videos")
        .upload(path, file || new Blob(), { contentType: file?.type || "video/mp4" });
      if (up.error) throw up.error;
      const db = await state.sb
        .from("videos")
        .insert({ organization_id: org, title, status: "review", storage_path: path });
      if (db.error) {
        await state.sb.storage.from("client-videos").remove([path]);
        throw db.error;
      }
      await refresh();
      state.page = "videos";
      render();
      showToast("영상이 등록되었습니다. 고객 검수 대기 상태입니다.");
    } catch (err) {
      showToast("업로드 실패: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "영상 업로드";
    }
  }

  async function openVideo(id) {
    const v = state.videos.find((x) => x.id === id);
    if (!v?.storage_path) return;
    const { data, error } = await state.sb.storage
      .from("client-videos")
      .createSignedUrl(v.storage_path, 120);
    if (error) {
      showToast("영상 열기 실패: " + error.message, "error");
      return;
    }
    if (data.demoAlert) {
      alert(data.demoAlert);
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function reviewVideo(id, status) {
    const feedback = status === "revision" ? prompt("수정 요청 내용을 입력하세요") : "";
    if (feedback === null) return;
    if (status === "revision" && !feedback.trim()) {
      showToast("수정 요청 내용을 입력해 주세요.", "error");
      return;
    }
    const { error } = await state.sb.rpc("review_video", {
      p_video_id: id,
      p_status: status,
      p_feedback: feedback || ""
    });
    if (error) {
      showToast("처리 실패: " + error.message, "error");
      return;
    }
    await refresh();
    render();
    showToast(status === "approved" ? "영상이 승인되었습니다." : "수정 요청이 저장되었습니다.");
  }

  async function editVideoTitle(id) {
    if (!isStaff()) return;
    const v = state.videos.find((x) => x.id === id);
    if (!v) return;
    const nextTitle = prompt("새 영상 제목을 입력하세요", v.title);
    if (nextTitle === null) return;
    const trimmed = nextTitle.trim();
    if (!trimmed || trimmed === v.title) return;
    const { error } = await state.sb.from("videos").update({ title: trimmed }).eq("id", id);
    if (error) {
      showToast("제목 수정 실패: " + error.message, "error");
      return;
    }
    await refresh();
    render();
    showToast("영상 제목이 수정되었습니다.");
  }

  async function deleteVideo(id) {
    if (!isStaff()) return;
    const v = state.videos.find((x) => x.id === id);
    if (!v) return;
    if (!confirm(`'${v.title}' 영상을 삭제할까요?\n연결된 영상 파일도 함께 삭제되며 되돌릴 수 없습니다.`)) {
      return;
    }
    const { error } = await state.sb.from("videos").delete().eq("id", id);
    if (error) {
      showToast("삭제 실패: " + error.message + " (schema.sql의 DELETE 정책을 확인하세요)", "error");
      return;
    }
    if (v.storage_path) {
      await state.sb.storage.from("client-videos").remove([v.storage_path]);
    }
    await refresh();
    render();
    showToast("영상이 삭제되었습니다.");
  }

  async function saveSchedule(e) {
    e.preventDefault();
    if (!isStaff()) return;
    const videoId = document.getElementById("scheduleVideo").value;
    const video = state.videos.find((v) => v.id === videoId);
    const platform = document.getElementById("schedulePlatform").value;
    const local = document.getElementById("scheduleDate").value;
    if (!video || !local) return;
    const at = new Date(local);
    if (Number.isNaN(at.getTime()) || at <= new Date()) {
      showToast("미래 날짜와 시간을 선택하세요.", "error");
      return;
    }
    const { error } = await state.sb.from("publish_schedule").insert({
      organization_id: video.organization_id,
      video_id: video.id,
      platform,
      scheduled_at: at.toISOString(),
      status: "planned"
    });
    if (error) {
      showToast("일정 저장 실패: " + error.message, "error");
      return;
    }
    await refresh();
    state.page = "calendar";
    render();
    showToast("게시 계획이 저장되었습니다. (내부 일정)");
  }

  async function cancelSchedule(id) {
    if (!confirm("이 게시 계획을 취소할까요?")) return;
    const { error } = await state.sb
      .from("publish_schedule")
      .update({ status: "cancelled" })
      .eq("id", id);
    if (error) {
      showToast("취소 실패: " + error.message, "error");
      return;
    }
    await refresh();
    state.page = "calendar";
    render();
    showToast("게시 계획이 취소되었습니다.");
  }

  async function saveKakao(e) {
    e.preventDefault();
    if (!isAdmin()) return;
    const url = document.getElementById("kakaoInput").value.trim();
    const { error } = await state.sb.rpc("set_kakao_channel_url", { p_url: url });
    if (error) {
      showToast("저장 실패: " + error.message, "error");
      return;
    }
    await refresh();
    state.page = "talk";
    render();
    showToast("카카오톡 채널 주소가 저장되었습니다.");
  }

  /* ── Render Sections ── */
  function renderWorkspaceBar() {
    if (!isStaff()) return "";
    const orgs = clientOrgs();
    const activeOrg = primaryClientOrg();
    return `
      <div class="workspace-bar">
        <div class="ws-label">
          <span>워크스페이스</span>
          <span class="pill ${activeOrg ? "" : "pill-muted"}">${esc(activeOrg ? activeOrg.name : "전체 고객사")}</span>
        </div>
        <div class="ws-controls">
          <select id="workspaceSelect" aria-label="고객사 워크스페이스 선택">
            <option value="all" ${state.selectedOrgId === "all" ? "selected" : ""}>전체 고객사 (${orgs.length}곳)</option>
            ${orgs
              .map(
                (o) =>
                  `<option value="${esc(o.id)}" ${state.selectedOrgId === o.id ? "selected" : ""}>${esc(o.name)}</option>`
              )
              .join("")}
          </select>
          ${
            state.selectedOrgId !== "all"
              ? `<button type="button" class="ws-reset" id="workspaceReset">전체 보기</button>`
              : ""
          }
        </div>
      </div>
    `;
  }

  function renderVideoRows(list) {
    const staff = isStaff();
    if (!list.length) {
      return `<p class="muted" style="padding:8px 0">표시할 영상이 없습니다.</p>`;
    }
    return list
      .map((v) => {
        const canReview = ["review", "revision", "approved"].includes(v.status);
        return `
          <div class="item">
            <div class="row">
              <div>
                <b>${esc(v.title)}</b>
                <div class="muted">${esc(myOrgName(v.organization_id))} · ${fmtDate(v.created_at)}</div>
              </div>
              ${statusPill(v.status)}
            </div>
            ${v.feedback ? `<div class="feedback-box"><b>수정 요청 메모:</b> ${esc(v.feedback)}</div>` : ""}
            <div class="actions">
              ${v.storage_path ? `<button type="button" data-action="open" data-id="${esc(v.id)}">영상 보기</button>` : ""}
              ${
                !staff && canReview
                  ? `${v.status !== "approved" ? `<button type="button" class="btn-approve" data-action="approve" data-id="${esc(v.id)}">승인하기</button>` : ""}
                     <button type="button" class="btn-warn" data-action="revision" data-id="${esc(v.id)}">수정 요청</button>`
                  : ""
              }
              ${
                staff
                  ? `<button type="button" class="btn-ghost" data-action="edit" data-id="${esc(v.id)}">제목 수정</button>
                     ${
                       v.status === "revision"
                         ? `<button type="button" class="btn-approve" data-action="approve" data-id="${esc(v.id)}">수정 완료·승인</button>`
                         : v.status === "review"
                         ? `<button type="button" class="btn-ghost" data-action="approve" data-id="${esc(v.id)}">대리 승인</button>`
                         : ""
                     }
                     <button type="button" class="btn-danger" data-action="delete" data-id="${esc(v.id)}">삭제</button>`
                  : ""
              }
            </div>
          </div>
        `;
      })
      .join("");
  }

  function renderHome() {
    const staff = isStaff();
    const vList = filteredVideos();
    const chList = filteredChannels().filter((c) => c.status === "connected");
    const activeOrg = primaryClientOrg();

    const cards = staff
      ? activeOrg
        ? [
            ["연결된 SNS", chList.length],
            ["선택 고객사 영상", vList.length],
            ["승인 대기", vList.filter((v) => v.status === "review").length],
            ["승인·게시 완료", vList.filter((v) => ["approved", "published"].includes(v.status)).length]
          ]
        : [
            ["등록 고객사", clientOrgs().length],
            ["연결된 SNS", chList.length],
            ["승인 대기", vList.filter((v) => v.status === "review").length],
            ["전체 영상", vList.length]
          ]
      : [
          ["연결된 SNS", chList.length],
          ["등록된 영상", vList.length],
          ["승인 대기", vList.filter((v) => v.status === "review").length],
          ["승인 완료", vList.filter((v) => v.status === "approved").length]
        ];

    return `
      <div class="grid">
        ${cards.map(([k, val]) => box(`<div class="muted">${k}</div><div class="stat">${val}</div>`)).join("")}
      </div>
      ${box(`<h2>최근 영상${activeOrg ? ` · ${esc(activeOrg.name)}` : ""}</h2>${renderVideoRows(vList.slice(0, 6))}`)}
    `;
  }

  function renderChannels() {
    const staff = isStaff();
    const admin = isAdmin();
    const activeOrg = primaryClientOrg();
    const logs = filteredAuditLogs();

    // Staff viewing ALL clients: show overview across organizations
    if (staff && !activeOrg) {
      const orgs = clientOrgs();
      const rows = orgs.length
        ? orgs
            .map((o) => {
              const yt = state.channels.find(
                (c) => c.organization_id === o.id && c.platform === "youtube"
              );
              const isConn = yt?.status === "connected";
              const perm = PERMISSION_LEVELS[yt?.permission_level]?.short || "";
              return `
                <div class="item">
                  <div class="row">
                    <div>
                      <b>${esc(o.name)}</b>
                      <div class="muted">
                        ${
                          isConn
                            ? `YouTube · ${esc(yt.channel_title || yt.handle || "")} (${esc(perm)}) · 만료: ${fmtExpiry(yt.expires_at)}`
                            : yt?.status === "revoked"
                            ? "YouTube 연결 해제됨 (재승인 필요)"
                            : "YouTube 미연결 — 고객 승인 대기 중"
                        }
                      </div>
                    </div>
                    <div class="actions" style="margin-top:0">
                      ${statusPill(yt?.status || "pending", CHANNEL_STATUS)}
                      <button type="button" data-copy-approval="${esc(o.name)}">승인 링크 복사</button>
                      <button type="button" class="btn-ghost" data-open-org-channels="${esc(o.id)}">상세 관리</button>
                    </div>
                  </div>
                </div>
              `;
            })
            .join("")
        : `<p class="muted">등록된 고객사가 없습니다.</p>`;

      return (
        box(`
          <h2>고객사별 YouTube 승인·연결 현황</h2>
          <p>비밀번호를 받지 않고 고객이 직접 Google 공식 OAuth로 권한을 승인합니다. 고객사별로 링크를 보내 승인을 요청하세요.</p>
          ${rows}
        `) + renderAuditLogCard(logs)
      );
    }

    // Single organization view (Client OR Staff with selected workspace)
    const yt = state.channels.find(
      (c) => c.organization_id === activeOrg.id && c.platform === "youtube"
    );
    const isConnected = yt?.status === "connected";
    const canAuthorize = !staff || admin;

    const ytSection = isConnected
      ? `
        <div class="channel-card connected">
          <div class="channel-head">
            <div class="channel-profile">
              <div class="channel-avatar">
                ${yt.avatar_url ? `<img src="${esc(yt.avatar_url)}" alt="">` : "YT"}
              </div>
              <div>
                <b>${esc(yt.channel_title || yt.handle || "YouTube 채널")}</b>
                <div class="muted">${esc(yt.handle || "")} · 연결일 ${yt.connected_at ? fmtDate(yt.connected_at) : "-"}</div>
              </div>
            </div>
            <div class="client-meta" style="margin-top:0">
              ${statusPill("connected", CHANNEL_STATUS)}
              <span class="pill">${esc(PERMISSION_LEVELS[yt.permission_level]?.short || yt.permission_level)}</span>
            </div>
          </div>

          <p class="muted" style="margin-top:10px">
            <b>만료 예정:</b> ${esc(fmtExpiry(yt.expires_at))}
          </p>

          <div class="actions">
            <button type="button" class="primary" data-go-tab="stats">승인된 채널 접속·성과 보기 →</button>
          </div>

          ${
            canAuthorize
              ? `<form id="updatePermForm" data-channel-id="${esc(yt.id)}">
                   <div class="form-grid">
                     <label>위임 권한 범위 조정
                       <select id="editYtPermLevel">
                         ${Object.entries(PERMISSION_LEVELS)
                           .map(
                             ([k, meta]) =>
                               `<option value="${k}" ${yt.permission_level === k ? "selected" : ""}>${meta.short} — ${meta.desc}</option>`
                           )
                           .join("")}
                       </select>
                     </label>
                     <label>권한 유효 기간 재설정
                       <select id="editYtDuration">
                         <option value="30">오늘부터 30일</option>
                         <option value="90" selected>오늘부터 90일 (3개월)</option>
                         <option value="180">오늘부터 180일 (6개월)</option>
                         <option value="">무기한 (직접 해제 시까지)</option>
                       </select>
                     </label>
                   </div>
                   <div class="actions">
                     <button type="submit" class="primary">권한 설정 저장</button>
                   </div>
                 </form>
                 <div class="kill-switch-bar">
                   <span class="muted">문제가 있거나 계약이 종료되면 클릭 한 번으로 즉시 차단할 수 있습니다.</span>
                   <button type="button" class="btn-danger" id="ytRevokeBtn" data-channel-id="${esc(yt.id)}">즉시 연결 해제 (Kill Switch)</button>
                 </div>`
              : `<div class="safety-box">고객사가 승인한 권한 범위(<b>${esc(PERMISSION_LEVELS[yt.permission_level]?.short || "")}</b>) 내에서만 접근할 수 있습니다. 권한 변경과 해제는 고객사 계정에서 직접 관리합니다.</div>`
          }
        </div>
      `
      : `
        <div class="channel-card">
          <div class="channel-head">
            <div class="channel-profile">
              <div class="channel-avatar">YT</div>
              <div>
                <b>YouTube 공식 계정 연결</b>
                <div class="muted">${yt?.status === "revoked" ? "이전에 연결이 해제되었습니다. 언제든 다시 승인할 수 있습니다." : "아직 연결되지 않았습니다."}</div>
              </div>
            </div>
            ${statusPill(yt?.status || "pending", CHANNEL_STATUS)}
          </div>

          <div class="safety-box">
            <b>보안 안전장치:</b> 비밀번호를 공유하지 않으며 Google 공식 OAuth로 연결됩니다.
            <b>계정 삭제 · 비밀번호 변경 · 결제 수단 변경</b> 권한은 원천 차단되며, 언제든 원클릭으로 즉시 차단(토큰 폐기)할 수 있습니다.
          </div>

          ${
            canAuthorize
              ? `<form id="ytConnectForm">
                   <div class="form-grid">
                     <label>허용할 권한 범위
                       <select id="ytPermLevel">
                         ${Object.entries(PERMISSION_LEVELS)
                           .map(([k, meta]) => `<option value="${k}">${meta.short} — ${meta.desc}</option>`)
                           .join("")}
                       </select>
                     </label>
                     <label>권한 유지 기간
                       <select id="ytDuration">
                         <option value="30">30일 (1개월)</option>
                         <option value="90" selected>90일 (3개월 · 추천)</option>
                         <option value="180">180일 (6개월)</option>
                         <option value="">무기한 (직접 해제 시까지)</option>
                       </select>
                     </label>
                   </div>
                   <button type="submit" id="ytConnectBtn" class="btn-youtube">Google 계정으로 YouTube 승인·연결하기</button>
                 </form>`
              : `<div class="actions">
                   <button type="button" class="primary" data-copy-approval="${esc(activeOrg.name)}">고객에게 승인 요청 링크 복사</button>
                 </div>`
          }
        </div>
      `;

    const upcomingPlatforms = PLATFORMS.filter((p) => !p.ready)
      .map(
        (p) => `
          <div class="item row">
            <div>
              <b>${esc(p.name)}</b>
              <div class="muted">YouTube 연동 검증 완료 후 순차 확장 예정 (Step 4)</div>
            </div>
            <span class="pill pill-muted">준비 중</span>
          </div>
        `
      )
      .join("");

    return (
      box(`
        <div class="row">
          <div>
            <h2>${staff ? `${esc(activeOrg.name)} · SNS 권한 연동` : "내 SNS 권한 승인 센터"}</h2>
            <p>${staff ? "승인받은 권한 범위 내에서 채널을 안전하게 관리합니다." : "대행사에 비밀번호를 알려주지 않고, 원하는 권한과 기간만 선택해 안전하게 승인하세요."}</p>
          </div>
          ${staff ? `<button type="button" class="ws-reset" data-copy-approval="${esc(activeOrg.name)}">승인 링크 복사</button>` : ""}
        </div>
        ${ytSection}
      `) +
      box(`<h2>확장 예정 플랫폼</h2>${upcomingPlatforms}`) +
      renderAuditLogCard(logs)
    );
  }

  function renderAuditLogCard(logs) {
    return box(`
      <h2>보안 감사 로그 (최근 활동 기록)</h2>
      <p>권한 승인·변경·차단 내역이 투명하게 기록됩니다.</p>
      ${
        logs.length
          ? logs
              .slice(0, 12)
              .map((l) => {
                const label = AUDIT_LABELS[l.action] || l.action;
                const roleLabel = l.actor_role === "admin" ? "관리자" : l.actor_role === "staff" ? "직원" : "고객사";
                const perm = l.detail?.permission_level
                  ? ` · ${PERMISSION_LEVELS[l.detail.permission_level]?.short || l.detail.permission_level}`
                  : "";
                const chName = l.detail?.channel_title ? ` (${l.detail.channel_title})` : "";
                return `
                  <div class="audit-item">
                    <div>
                      <b>${esc(label)}${esc(chName)}</b>
                      <div class="muted">${esc(myOrgName(l.organization_id))} · 실행자: ${roleLabel}${esc(perm)}</div>
                    </div>
                    <span class="muted" style="white-space:nowrap">${fmtDate(l.created_at)}</span>
                  </div>
                `;
              })
              .join("")
          : `<p class="muted" style="margin-top:10px">아직 기록된 권한 활동이 없습니다.</p>`
      }
    `);
  }

  function renderClients() {
    const orgs = clientOrgs();
    const admin = isAdmin();
    return box(`
      ${
        admin
          ? `<h2>새 고객사 등록</h2>
             <form id="createCustomerForm">
               <label for="customerName">고객사 이름
                 <input id="customerName" maxlength="100" minlength="2" placeholder="예: 스튜디오 바나나" required>
               </label>
               <button id="createCustomerButton" class="primary wide">고객사 등록</button>
             </form>
             <hr>`
          : ""
      }
      <h2>고객사 목록 (${orgs.length}곳)</h2>
      <p>고객사를 선택하면 해당 고객사 전용 워크스페이스로 바로 전환됩니다.</p>
      ${
        orgs.length
          ? orgs
              .map((o) => {
                const orgVideos = state.videos.filter((v) => v.organization_id === o.id);
                const pending = orgVideos.filter((v) => v.status === "review").length;
                const connected = state.channels.filter(
                  (c) => c.organization_id === o.id && c.status === "connected"
                ).length;
                return `
                  <div class="item">
                    <div class="row">
                      <div>
                        <b>${esc(o.name)}</b>
                        <div class="client-meta">
                          <span class="pill pill-muted">영상 ${orgVideos.length}</span>
                          ${pending ? `<span class="pill pill-review">승인 대기 ${pending}</span>` : ""}
                          <span class="pill ${connected ? "pill-approved" : "pill-muted"}">연결 SNS ${connected}</span>
                        </div>
                      </div>
                      <div class="actions" style="margin-top:0">
                        <button type="button" data-open-org="${esc(o.id)}">워크스페이스 열기</button>
                      </div>
                    </div>
                  </div>
                `;
              })
              .join("")
          : `<p class="muted" style="margin-top:12px">아직 등록된 고객사가 없습니다. 위 폼에서 첫 고객사를 등록하세요.</p>`
      }
      ${
        admin && orgs.length
          ? `<hr>
             <h2>고객 계정 초대</h2>
             <p>초대 메일을 보내면 고객이 직접 비밀번호를 설정하고 본인 회사 화면에만 접속할 수 있습니다.</p>
             <form id="inviteForm">
               <label>고객사
                 <select id="inviteOrg" required>
                   ${orgs
                     .map(
                       (o) =>
                         `<option value="${esc(o.id)}" ${state.selectedOrgId === o.id ? "selected" : ""}>${esc(o.name)}</option>`
                     )
                     .join("")}
                 </select>
               </label>
               <label>고객 이메일
                 <input id="inviteEmail" type="email" required placeholder="client@company.com">
               </label>
               <button id="inviteButton" class="primary wide">초대 메일 발송</button>
             </form>`
          : ""
      }
    `);
  }

  function renderVideos() {
    const staff = isStaff();
    const orgs = clientOrgs();
    const baseList = filteredVideos();
    const shown =
      state.videoStatusFilter === "all"
        ? baseList
        : baseList.filter((v) => v.status === state.videoStatusFilter);

    const chips = [
      ["all", `전체 (${baseList.length})`],
      ["review", `승인 대기 (${baseList.filter((v) => v.status === "review").length})`],
      ["revision", `수정 요청 (${baseList.filter((v) => v.status === "revision").length})`],
      ["approved", `승인 완료 (${baseList.filter((v) => v.status === "approved").length})`],
      ["published", `게시 완료 (${baseList.filter((v) => v.status === "published").length})`]
    ];

    const uploadCard = staff
      ? box(`
          <h2>영상 업로드</h2>
          ${
            orgs.length
              ? `<form id="uploadVideoForm">
                   <label>고객사
                     <select id="videoOrg">
                       ${orgs
                         .map(
                           (o) =>
                             `<option value="${esc(o.id)}" ${state.selectedOrgId === o.id ? "selected" : ""}>${esc(o.name)}</option>`
                         )
                         .join("")}
                     </select>
                   </label>
                   <label>영상 제목
                     <input id="videoTitle" required maxlength="150" placeholder="예: [릴스] 12월 신메뉴 티저">
                   </label>
                   <label>영상 파일 (최대 100MB · MP4/MOV/WebM)
                     <input id="videoFile" type="file" accept="video/mp4,video/quicktime,video/webm" ${window.MODUCON_MOCK_CLIENT ? "" : "required"}>
                   </label>
                   <button id="uploadButton" class="primary wide">영상 업로드</button>
                 </form>`
              : `<p>고객사를 먼저 등록하세요.</p>`
          }
        `)
      : "";

    return (
      uploadCard +
      box(`
        <h2>영상 목록</h2>
        <div class="chips">
          ${chips
            .map(
              ([key, label]) =>
                `<button type="button" class="chip ${state.videoStatusFilter === key ? "active" : ""}" data-status-filter="${key}">${label}</button>`
            )
            .join("")}
        </div>
        ${renderVideoRows(shown)}
      `)
    );
  }

  function renderCalendar() {
    const staff = isStaff();
    const vList = filteredVideos();
    const approved = vList.filter((v) => v.status === "approved");
    const sList = filteredSchedules();

    const formCard = staff
      ? box(`
          <h2>게시 계획 등록</h2>
          <p>내부 일정 관리 기능입니다. 실제 SNS 자동 게시는 Step 4에서 연결됩니다.</p>
          ${
            approved.length
              ? `<form id="scheduleForm">
                   <label>승인된 영상
                     <select id="scheduleVideo">
                       ${approved
                         .map(
                           (v) =>
                             `<option value="${esc(v.id)}">${esc(v.title)} · ${esc(myOrgName(v.organization_id))}</option>`
                         )
                         .join("")}
                     </select>
                   </label>
                   <label>플랫폼
                     <select id="schedulePlatform">
                       ${PLATFORMS.slice(0, 3).map((p) => `<option value="${p.id}">${p.name}</option>`).join("")}
                     </select>
                   </label>
                   <label>게시 예정 일시
                     <input id="scheduleDate" type="datetime-local" required>
                   </label>
                   <button class="primary wide">게시 계획 저장</button>
                 </form>`
              : `<p class="alert">게시 계획을 등록하려면 먼저 승인 완료된 영상이 있어야 합니다.</p>`
          }
        `)
      : "";

    const listCard = box(`
      <h2>게시 일정 (${sList.length}건)</h2>
      ${
        sList.length
          ? sList
              .map((x) => {
                const video = state.videos.find((v) => v.id === x.video_id);
                return `
                  <div class="item">
                    <div class="row">
                      <div>
                        <b>${esc(video?.title || "영상")}</b>
                        <div class="muted">${esc(myOrgName(x.organization_id))} · ${esc(x.platform.toUpperCase())} · ${fmtDate(x.scheduled_at)}</div>
                      </div>
                      ${statusPill(x.status, SCHEDULE_STATUS)}
                    </div>
                    ${
                      staff && x.status === "planned"
                        ? `<div class="actions"><button type="button" class="btn-danger" data-cancel-schedule="${esc(x.id)}">계획 취소</button></div>`
                        : ""
                    }
                  </div>
                `;
              })
              .join("")
          : `<p class="muted">등록된 게시 계획이 없습니다.</p>`
      }
    `);

    return formCard + listCard;
  }

  function renderStats() {
    const staff = isStaff();
    const activeOrg = primaryClientOrg();

    // 1) Staff viewing ALL clients: Multi-channel overview grid
    if (staff && !activeOrg) {
      const orgs = clientOrgs();
      const connectedItems = orgs
        .map((o) => ({
          org: o,
          ch: state.channels.find(
            (c) => c.organization_id === o.id && c.platform === "youtube" && c.status === "connected"
          )
        }))
        .filter((x) => Boolean(x.ch));

      const unconnectedOrgs = orgs.filter(
        (o) => !connectedItems.some((x) => x.org.id === o.id)
      );

      const gridHtml = connectedItems.length
        ? `<div class="channel-grid">
            ${connectedItems
              .map(({ org, ch }) => {
                const snap = state.snapshots[ch.id];
                const syncing = state.syncingChannelId === ch.id;
                const permLabel = PERMISSION_LEVELS[ch.permission_level]?.short || ch.permission_level;
                return `
                  <div class="channel-summary-card">
                    <div class="channel-head">
                      <div class="channel-profile">
                        <div class="channel-avatar">
                          ${ch.avatar_url ? `<img src="${esc(ch.avatar_url)}" alt="">` : "YT"}
                        </div>
                        <div>
                          <b>${esc(ch.channel_title || org.name)}</b>
                          <div class="muted">${esc(org.name)} · ${esc(ch.handle || "")}</div>
                        </div>
                      </div>
                      <span class="pill">${esc(permLabel)}</span>
                    </div>
                    <div class="mini-stats">
                      <div>
                        <div class="ms-label">구독자</div>
                        <div class="ms-val">${snap ? fmtNum(snap.subscriber_count) : "-"}</div>
                      </div>
                      <div>
                        <div class="ms-label">누적 조회수</div>
                        <div class="ms-val">${snap ? fmtNum(snap.view_count) : "-"}</div>
                      </div>
                      <div>
                        <div class="ms-label">업로드 영상</div>
                        <div class="ms-val">${snap ? fmtNum(snap.video_count) : "-"}</div>
                      </div>
                    </div>
                    <div class="muted" style="font-size:12px">
                      ${snap ? `마지막 동기화: ${fmtDate(snap.synced_at)}` : "아직 실시간 데이터를 불러오지 않았습니다."}
                    </div>
                    <div class="actions" style="margin-top:4px">
                      <button type="button" class="primary" data-open-org-stats="${esc(org.id)}">채널 들어가서 보기</button>
                      <button type="button" class="btn-ghost" data-sync-channel="${esc(ch.id)}" ${syncing ? "disabled" : ""}>
                        ${syncing ? "불러오는 중..." : "새로고침"}
                      </button>
                    </div>
                  </div>
                `;
              })
              .join("")}
          </div>`
        : `<div class="alert">아직 승인·연결된 고객사 YouTube 채널이 없습니다. <b>SNS 연동</b> 탭에서 고객에게 승인 링크를 보내세요.</div>`;

      const pendingHtml = unconnectedOrgs.length
        ? box(`
            <h2>승인 대기 중인 고객사 (${unconnectedOrgs.length}곳)</h2>
            ${unconnectedOrgs
              .map(
                (o) => `
                  <div class="item row">
                    <div>
                      <b>${esc(o.name)}</b>
                      <div class="muted">YouTube 공식 계정 승인 후 채널 성과와 영상 피드를 열람할 수 있습니다.</div>
                    </div>
                    <button type="button" class="ws-reset" data-copy-approval="${esc(o.name)}">승인 링크 복사</button>
                  </div>
                `
              )
              .join("")}
          `)
        : "";

      return (
        box(`
          <div class="row">
            <div>
              <h2>승인된 SNS 라이브 채널 (${connectedItems.length}개)</h2>
              <p>고객사가 승인한 여러 YouTube 채널에 안전하게 접속해 성과와 최근 영상 피드를 한눈에 확인합니다.</p>
            </div>
            <button type="button" class="ws-reset" data-go-tab="channels">SNS 연동 관리</button>
          </div>
          ${gridHtml}
        `) + pendingHtml
      );
    }

    // 2) Single organization view (Client OR Staff with selected workspace)
    const yt = state.channels.find(
      (c) => c.organization_id === activeOrg.id && c.platform === "youtube" && c.status === "connected"
    );

    if (!yt) {
      return box(`
        <h2>${esc(activeOrg.name)} · 채널 성과 & 피드</h2>
        <div class="alert">
          아직 승인·연결된 YouTube 채널이 없습니다. 고객사가 공식 OAuth 승인을 완료하면 구독자 수, 누적 조회수, 최근 영상 성과를 바로 열람할 수 있습니다.
        </div>
        <div class="actions">
          <button type="button" class="primary" data-go-tab="channels">${staff ? "SNS 연동·승인 링크 관리" : "YouTube 승인·연결하러 가기"}</button>
        </div>
      `);
    }

    const snap = state.snapshots[yt.id];
    const syncing = state.syncingChannelId === yt.id;
    const permMeta = PERMISSION_LEVELS[yt.permission_level] || { short: yt.permission_level };
    const ytChannelUrl = yt.handle?.startsWith("@")
      ? `https://www.youtube.com/${yt.handle}`
      : yt.external_account_id
      ? `https://www.youtube.com/channel/${yt.external_account_id}`
      : "https://studio.youtube.com";

    const readOnlyBanner =
      yt.permission_level === "viewer"
        ? `<div class="readonly-banner">
             <span>읽기 전용 안전 모드 (Lv.1 열람 전용) — 채널 조회·성과 모니터링만 가능하며 영상 수정·삭제는 차단됩니다.</span>
             <span class="pill pill-approved">READ-ONLY SAFE</span>
           </div>`
        : "";

    const headerCard = box(`
      ${readOnlyBanner}
      <div class="channel-head">
        <div class="channel-profile">
          <div class="channel-avatar">
            ${yt.avatar_url ? `<img src="${esc(yt.avatar_url)}" alt="">` : "YT"}
          </div>
          <div>
            <h2 style="margin:0">${esc(yt.channel_title || activeOrg.name)}</h2>
            <div class="muted">${esc(yt.handle || "")} · 권한: ${esc(permMeta.short)} · 만료: ${esc(fmtExpiry(yt.expires_at))}</div>
          </div>
        </div>
        <div class="actions" style="margin-top:0">
          <button type="button" class="primary" data-sync-channel="${esc(yt.id)}" ${syncing ? "disabled" : ""}>
            ${syncing ? "YouTube 동기화 중..." : "실시간 새로고침"}
          </button>
          <a href="${esc(ytChannelUrl)}" target="_blank" rel="noopener noreferrer" class="ws-reset" style="text-decoration:none">YouTube 열기 ↗</a>
        </div>
      </div>
      <div class="muted" style="margin-top:10px;font-size:12px">
        ${snap ? `마지막 동기화: ${fmtDate(snap.synced_at)}` : "아직 동기화된 스냅샷이 없습니다. [실시간 새로고침] 버튼을 눌러 YouTube 데이터를 가져오세요."}
      </div>
    `);

    if (!snap) {
      return (
        headerCard +
        box(`
          <h2>첫 데이터 동기화가 필요합니다</h2>
          <p>승인된 YouTube 계정의 구독자·조회수·최근 업로드 영상을 안전하게 불러옵니다.</p>
          <div class="actions">
            <button type="button" class="primary" data-sync-channel="${esc(yt.id)}" ${syncing ? "disabled" : ""}>
              ${syncing ? "불러오는 중..." : "지금 YouTube 데이터 불러오기"}
            </button>
          </div>
        `)
      );
    }

    const videos = Array.isArray(snap.recent_videos) ? [...snap.recent_videos] : [];
    const avgViews = videos.length
      ? Math.round(videos.reduce((acc, v) => acc + Number(v.views || 0), 0) / videos.length)
      : 0;

    if (state.feedSort === "views") {
      videos.sort((a, b) => Number(b.views || 0) - Number(a.views || 0));
    } else if (state.feedSort === "comments") {
      videos.sort((a, b) => Number(b.comments || 0) - Number(a.comments || 0));
    } else {
      videos.sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")));
    }

    const maxViews = Math.max(1, ...videos.map((v) => Number(v.views || 0)));

    const kpiHtml = `
      <div class="grid">
        ${[
          ["구독자 수", fmtNum(snap.subscriber_count)],
          ["누적 조회수", fmtNum(snap.view_count)],
          ["업로드 영상", fmtNum(snap.video_count)],
          ["최근 평균 조회수", fmtNum(avgViews)]
        ]
          .map(([k, val]) => box(`<div class="muted">${k}</div><div class="stat" style="font-size:26px">${val}</div>`))
          .join("")}
      </div>
    `;

    const feedHtml = box(`
      <div class="row">
        <div>
          <h2>최근 업로드 영상 피드 (${videos.length}개)</h2>
          <p>승인된 채널에 실제 게시된 영상들의 실시간 성과입니다.</p>
        </div>
        <div class="chips" style="margin:0">
          ${[
            ["recent", "최신순"],
            ["views", "조회수 높은순"],
            ["comments", "댓글 많은순"]
          ]
            .map(
              ([k, label]) =>
                `<button type="button" class="chip ${state.feedSort === k ? "active" : ""}" data-feed-sort="${k}">${label}</button>`
            )
            .join("")}
        </div>
      </div>
      ${
        videos.length
          ? videos
              .map((v) => {
                const views = Number(v.views || 0);
                const likes = Number(v.likes || 0);
                const comments = Number(v.comments || 0);
                const er = views > 0 ? (((likes + comments) / views) * 100).toFixed(1) : "0.0";
                const pct = Math.max(4, Math.round((views / maxViews) * 100));
                const dur = fmtDuration(v.duration);
                const ytUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`;
                return `
                  <div class="yt-feed-item">
                    <div class="yt-thumb">
                      ${v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="">` : "<span>YouTube</span>"}
                      ${dur ? `<span class="yt-dur">${esc(dur)}</span>` : ""}
                    </div>
                    <div class="yt-feed-body">
                      <div class="row" style="align-items:flex-start">
                        <a class="yt-feed-title" href="${ytUrl}" target="_blank" rel="noopener noreferrer">${esc(v.title)}</a>
                        ${statusPill(v.privacyStatus || "public", PRIVACY_META)}
                      </div>
                      <div class="muted" style="font-size:12px;margin-top:3px">
                        게시일: ${v.publishedAt ? fmtDate(v.publishedAt) : "-"}
                      </div>
                      <div class="yt-metrics">
                        <span>조회수 ${fmtNum(views)}</span>
                        <span>좋아요 ${fmtNum(likes)}</span>
                        <span>댓글 ${fmtNum(comments)}</span>
                        <span style="color:#2458c6">참여율 ${er}%</span>
                      </div>
                      <div class="perf-bar-track" title="최고 조회수 대비 ${pct}%">
                        <div class="perf-bar-fill" style="width:${pct}%"></div>
                      </div>
                    </div>
                  </div>
                `;
              })
              .join("")
          : `<p class="muted" style="margin-top:12px">아직 업로드된 영상이 없습니다.</p>`
      }
    `);

    return headerCard + kpiHtml + feedHtml;
  }

  function renderTalk() {
    return box(`
      <h2>카카오톡 상담</h2>
      ${
        state.kakaoUrl
          ? `<p>등록된 카카오톡 채널로 담당자와 빠르게 상담할 수 있습니다.</p>
             <div class="actions">
               <a href="${esc(state.kakaoUrl)}" target="_blank" rel="noopener noreferrer" class="primary" style="text-decoration:none;display:inline-block">카카오톡 상담 열기 ↗</a>
             </div>`
          : `<p>카카오톡 채널 주소가 아직 등록되지 않았습니다.</p>`
      }
      ${
        isAdmin()
          ? `<hr>
             <form id="kakaoForm">
               <label>카카오톡 채널 URL
                 <input id="kakaoInput" type="url" placeholder="https://pf.kakao.com/..." value="${esc(state.kakaoUrl)}">
               </label>
               <button class="primary wide">상담 채널 저장</button>
             </form>`
          : ""
      }
    `);
  }

  function render() {
    updateHeader(true);
    const menu = menus();
    if (!menu.some(([id]) => id === state.page)) state.page = "home";
    const staff = isStaff();
    const activeOrg = primaryClientOrg();

    const heroTitle = staff
      ? activeOrg
        ? `${activeOrg.name} 운영`
        : "모두콘 운영센터"
      : `${activeOrg ? activeOrg.name + " · " : ""}내 콘텐츠 관리`;

    const heroDesc = staff
      ? activeOrg
        ? `${activeOrg.name}의 SNS 권한·영상·게시 일정을 집중 관리합니다.`
        : "승인받은 고객사 SNS와 콘텐츠를 하나의 흐름으로 관리합니다."
      : "SNS 권한 승인과 콘텐츠 검수를 한눈에 관리하세요.";

    let bodyHtml = "";
    if (state.page === "home") bodyHtml = renderHome();
    else if (state.page === "clients" && staff) bodyHtml = renderClients();
    else if (state.page === "channels") bodyHtml = renderChannels();
    else if (state.page === "videos") bodyHtml = renderVideos();
    else if (state.page === "calendar") bodyHtml = renderCalendar();
    else if (state.page === "stats") bodyHtml = renderStats();
    else if (state.page === "talk") bodyHtml = renderTalk();

    el.innerHTML = `
      <section class="hero">
        <div class="eyebrow">MODUCON · CONTENT OPERATIONS</div>
        <h1>${esc(heroTitle)}</h1>
        <p>${esc(heroDesc)}</p>
      </section>
      ${renderWorkspaceBar()}
      <nav class="nav">
        ${menu
          .map(
            ([id, label]) =>
              `<button type="button" class="${state.page === id ? "on" : ""}" data-nav="${id}">${label}</button>`
          )
          .join("")}
      </nav>
      ${bodyHtml}
    `;

    bindEvents();
  }

  function bindEvents() {
    el.querySelectorAll("[data-nav]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.page = btn.dataset.nav;
        render();
        window.scrollTo({ top: 0, behavior: "instant" });
      })
    );

    el.querySelectorAll("[data-go-tab]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.page = btn.dataset.goTab;
        render();
        window.scrollTo({ top: 0, behavior: "instant" });
      })
    );

    document.getElementById("workspaceSelect")?.addEventListener("change", (e) => {
      state.selectedOrgId = e.target.value;
      render();
    });

    document.getElementById("workspaceReset")?.addEventListener("click", () => {
      state.selectedOrgId = "all";
      render();
    });

    el.querySelectorAll("[data-open-org]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.selectedOrgId = btn.dataset.openOrg;
        state.page = "home";
        render();
        showToast(`${myOrgName(state.selectedOrgId)} 워크스페이스로 전환했습니다.`);
      })
    );

    el.querySelectorAll("[data-open-org-channels]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.selectedOrgId = btn.dataset.openOrgChannels;
        state.page = "channels";
        render();
      })
    );

    el.querySelectorAll("[data-open-org-stats]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.selectedOrgId = btn.dataset.openOrgStats;
        state.page = "stats";
        render();
        window.scrollTo({ top: 0, behavior: "instant" });
      })
    );

    el.querySelectorAll("[data-sync-channel]").forEach((btn) =>
      btn.addEventListener("click", () => syncChannelInsights(btn.dataset.syncChannel, true))
    );

    el.querySelectorAll("[data-feed-sort]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.feedSort = btn.dataset.feedSort;
        render();
      })
    );

    el.querySelectorAll("[data-copy-approval]").forEach((btn) =>
      btn.addEventListener("click", () => copyApprovalLink(btn.dataset.copyApproval))
    );

    el.querySelectorAll("[data-status-filter]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.videoStatusFilter = btn.dataset.statusFilter;
        render();
      })
    );

    el.querySelectorAll("[data-action]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const { action, id } = btn.dataset;
        if (action === "open") openVideo(id);
        else if (action === "approve") reviewVideo(id, "approved");
        else if (action === "revision") reviewVideo(id, "revision");
        else if (action === "edit") editVideoTitle(id);
        else if (action === "delete") deleteVideo(id);
      })
    );

    el.querySelectorAll("[data-cancel-schedule]").forEach((btn) =>
      btn.addEventListener("click", () => cancelSchedule(btn.dataset.cancelSchedule))
    );

    document.getElementById("ytConnectForm")?.addEventListener("submit", connectYouTube);
    document.getElementById("updatePermForm")?.addEventListener("submit", updateChannelPermission);
    document.getElementById("ytRevokeBtn")?.addEventListener("click", (e) =>
      revokeChannel(e.currentTarget.dataset.channelId)
    );

    document.getElementById("createCustomerForm")?.addEventListener("submit", createCustomer);
    document.getElementById("inviteForm")?.addEventListener("submit", inviteCustomer);
    document.getElementById("uploadVideoForm")?.addEventListener("submit", uploadVideo);
    document.getElementById("scheduleForm")?.addEventListener("submit", saveSchedule);
    document.getElementById("kakaoForm")?.addEventListener("submit", saveKakao);
  }

  /* ── Bootstrap ── */
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  window.addEventListener("pageshow", () => window.scrollTo(0, 0));
  logoutBtn?.addEventListener("click", logout);

  window.__MODUCON_APP__ = {
    refresh,
    renderLogin,
    resetToHome() {
      state.page = "home";
      state.selectedOrgId = "all";
      return refresh();
    }
  };

  if (window.MODUCON_MOCK_CLIENT) {
    state.sb = window.MODUCON_MOCK_CLIENT;
    refresh();
  } else if (configured && window.supabase) {
    state.sb = window.supabase.createClient(
      window.MODUCON_SUPABASE_URL,
      window.MODUCON_SUPABASE_ANON_KEY
    );
    state.sb.auth.onAuthStateChange((event) => {
      if (
        event === "PASSWORD_RECOVERY" ||
        (event === "SIGNED_IN" && location.hash.includes("type=invite"))
      ) {
        state.recoveryMode = true;
        renderPasswordForm();
      } else if (!state.recoveryMode) {
        setTimeout(refresh, 0);
      }
    });
    if (location.hash.includes("type=recovery") || location.hash.includes("type=invite")) {
      state.recoveryMode = true;
      renderPasswordForm();
    } else {
      refresh();
    }
  } else {
    renderLogin();
  }
})();
