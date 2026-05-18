// Galcode 复核台 SPA。零依赖 vanilla JS。
//
// 架构：
//   - 顶层 store：{ me, view, filters, items, ... }；任何变更走 setState 触发 render
//   - 视图按 view 字段 dispatch：login / dashboard / images / albums
//   - 详情抽屉是独立挂载层（drawer state），跟主视图正交
//   - 键盘快捷键：/ 聚焦搜索、j/k 选择上下条、a/h 批准/隐藏、Esc 关抽屉、1/2/3 切视图
//
// 与 server 端的接口：
//   GET  /admin/me
//   POST /admin/login / /admin/logout
//   GET  /admin/api/stats
//   GET  /admin/api/images?filter&q&category&dateFrom&dateTo&cursor&offset
//   GET  /admin/api/images/:id
//   PATCH /admin/api/images/:id/status   { status: approved | hidden_by_admin }
//   GET  /admin/api/albums?filter&q&dateFrom&dateTo&cursor
//   PATCH /admin/api/albums/:id/status   { status: active | hidden_by_admin }

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // 全局状态
  // ---------------------------------------------------------------------------
  const state = {
    booting: true,
    me: null,
    /// 主视图：dashboard | images | albums
    view: "dashboard",
    /// 移动端侧栏开关
    mobileNavOpen: false,
    /// dashboard 数据
    dashboard: { loading: false, data: null, err: "" },
    /// images 视图
    images: {
      filter: "rejected",
      q: "",
      category: "",
      dateFrom: "",
      dateTo: "",
      mode: "list", // list | grid
      items: [],
      cursor: null,
      loading: false,
      err: "",
      selectedIds: new Set(),
      focusedIndex: -1,
      pendingReviewBadge: 0,
    },
    /// albums 视图
    albums: {
      filter: "all",
      q: "",
      items: [],
      cursor: null,
      loading: false,
      err: "",
    },
    /// 详情抽屉（image / album / null）
    drawer: null, // { kind: "image"|"album", id, data, loading, err }
    /// toast 列队
    toasts: [],
  };

  function setState(patch) {
    Object.assign(state, patch);
    render();
  }
  function setImagesState(patch) {
    Object.assign(state.images, patch);
    render();
  }
  function setAlbumsState(patch) {
    Object.assign(state.albums, patch);
    render();
  }
  function setDrawer(d) {
    state.drawer = d;
    render();
  }

  // ---------------------------------------------------------------------------
  // DOM helper
  // ---------------------------------------------------------------------------
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") e.className = v;
        else if (k === "style" && typeof v === "object") {
          for (const [sk, sv] of Object.entries(v)) e.style[sk] = sv;
        } else if (k.startsWith("on") && typeof v === "function") {
          e.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === "html") {
          e.innerHTML = v;
        } else if (k === "value") {
          // input value 属性 vs property——同时设两边方便受控
          e.setAttribute(k, v);
          e.value = v;
        } else {
          e.setAttribute(k, v);
        }
      }
    }
    appendChildren(e, children);
    return e;
  }
  function appendChildren(parent, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) appendChildren(parent, c);
      else if (c && c.nodeType) parent.append(c);
      else parent.append(document.createTextNode(String(c)));
    }
  }
  /// 返回一个 DocumentFragment——append 进父节点时它的 children 会被"摊平"成
  /// 父的直接子节点。给 .drawer 这种 flex column 容器返回多个同级节点必备。
  function frag(...children) {
    const f = document.createDocumentFragment();
    appendChildren(f, children);
    return f;
  }

  /// 简易 SVG icon 工厂（避免引入 icon lib）
  function icon(path, opts = {}) {
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", String(opts.stroke ?? 1.6));
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.style.width = `${opts.size ?? 16}px`;
    svg.style.height = `${opts.size ?? 16}px`;
    const p = document.createElementNS(svgNS, "path");
    p.setAttribute("d", path);
    svg.append(p);
    return svg;
  }

  const ICONS = {
    dashboard: "M2 3h5v6H2V3zm0 8h5v3H2v-3zm7-8h5v3H9V3zm0 5h5v6H9V8z",
    image: "M2 3h12v10H2V3zm2.5 6L6 7.5 9 11l2-2 3 3H2.5l2-3z",
    album: "M3 4h7l2 2h0v6H3V4zm10 1v8a1 1 0 01-1 1H4",
    search: "M7 12a5 5 0 100-10 5 5 0 000 10zm3.5-1.5L14 14",
    refresh: "M13 6.5A5 5 0 003.5 6m-1.5 0V3m1.5 3H6M3 9.5A5 5 0 0012.5 10m1.5 0v3m-1.5-3H10",
    close: "M3 3l10 10M13 3L3 13",
    check: "M3 8.5L6.5 12 13 4.5",
    eye: "M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z M8 10a2 2 0 100-4 2 2 0 000 4z",
    eyeOff: "M2 2l12 12M5 4.5C6 4 7 3.5 8 3.5c4 0 6.5 4 6.5 4s-.7 1-2 2M9.5 9.5a2 2 0 11-3-3",
    list: "M3 4h10M3 8h10M3 12h10",
    grid: "M3 3h4v4H3zm6 0h4v4H9zM3 9h4v4H3zm6 0h4v4H9z",
    menu: "M2 4h12M2 8h12M2 12h12",
    logout: "M10 3h-7v10h7M7 8h7m-2.5-2.5L14 8l-2.5 2.5",
    chevronRight: "M6 3l5 5-5 5",
    chevronLeft: "M10 3l-5 5 5 5",
    arrowUp: "M8 13V3m0 0l-4 4m4-4l4 4",
    arrowDown: "M8 3v10m0 0l-4-4m4 4l4-4",
    user: "M8 9a3 3 0 100-6 3 3 0 000 6zM2 14a6 6 0 0112 0",
    warn: "M8 1.5L15 14H1L8 1.5zm0 5v4m0 2v1",
    flag: "M3 14V3m0 0l8 .5-1.5 3L11 9 3 8.5",
    ban: "M8 14a6 6 0 100-12 6 6 0 000 12zM3.5 3.5l9 9",
    heart: "M8 13.5C2 9.5 2 5 5 4c1.5-.5 2.5.5 3 1.5C8.5 4.5 9.5 3.5 11 4c3 1 3 5.5-3 9.5z",
  };

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------
  async function api(method, path, body) {
    const opts = { method, credentials: "include", headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    if (!res.ok) {
      const err = new Error(parsed?.message || parsed?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------
  function toast(message, kind = "") {
    const t = { id: Math.random().toString(36).slice(2), message, kind };
    state.toasts.push(t);
    render();
    setTimeout(() => {
      state.toasts = state.toasts.filter((x) => x.id !== t.id);
      render();
    }, 2600);
  }

  // ---------------------------------------------------------------------------
  // 格式化
  // ---------------------------------------------------------------------------
  const STATUS_LABEL = {
    approved: "已通过",
    rejected: "AI 拒绝",
    hidden_by_owner: "本人隐藏",
    hidden_by_admin: "后台下架",
    pending_ai: "审核中",
    active: "公开",
  };
  const CATEGORY_LABEL = {
    welcome: "欢迎",
    thinking: "思考",
    waiting: "等待",
    complete: "完成",
    error: "错误",
    others: "互动彩蛋",
  };

  function fmtNumber(n) {
    if (typeof n !== "number") return "—";
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    return String(n);
  }
  function fmtTime(ms) {
    if (!ms) return "—";
    const d = new Date(ms);
    const Y = d.getFullYear();
    const M = String(d.getMonth() + 1).padStart(2, "0");
    const D = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${Y}-${M}-${D} ${h}:${m}`;
  }
  function fmtAgo(ms) {
    if (!ms) return "—";
    const diff = Date.now() - ms;
    if (diff < 0) return "刚刚";
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s 前`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m 前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h 前`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d 前`;
    return fmtTime(ms);
  }
  function shortId(id, len = 8) {
    if (!id) return "—";
    return id.length > len ? id.slice(0, len) : id;
  }
  function fmtBytes(b) {
    if (typeof b !== "number" || !b) return "—";
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  }

  function statusBadge(s) {
    return el("span", { class: "badge " + s }, STATUS_LABEL[s] ?? s);
  }
  function categoryBadge(c) {
    return el("span", { class: "badge category" }, CATEGORY_LABEL[c] ?? c);
  }

  // ---------------------------------------------------------------------------
  // 顶层渲染
  // ---------------------------------------------------------------------------
  const $app = document.getElementById("app");

  function render() {
    if (state.booting) {
      $app.replaceChildren(el("div", { class: "center" }, el("div", { class: "loading-block" }, "加载中…")));
      return;
    }
    if (!state.me) {
      $app.replaceChildren(renderLogin());
      return;
    }
    $app.replaceChildren(renderShell());
  }

  function renderToasts() {
    if (state.toasts.length === 0) return null;
    return el(
      "div",
      { class: "toasts" },
      state.toasts.map((t) => el("div", { class: "toast " + t.kind }, t.message)),
    );
  }

  // ---------------------------------------------------------------------------
  // 登录页
  // ---------------------------------------------------------------------------
  function renderLogin() {
    let uIn, pIn, errBox;
    const onSubmit = async (e) => {
      e?.preventDefault();
      errBox.classList.remove("show");
      const u = uIn.value.trim();
      const p = pIn.value;
      if (!u || !p) {
        errBox.textContent = "用户名 / 密码不能为空";
        errBox.classList.add("show");
        return;
      }
      try {
        const me = await api("POST", "/admin/login", { username: u, password: p });
        setState({ me });
        await loadDashboard();
      } catch (err) {
        errBox.textContent = err.message || "登录失败";
        errBox.classList.add("show");
      }
    };
    const form = el(
      "form",
      { class: "login-card", onSubmit },
      el(
        "h1",
        {},
        el(
          "span",
          { style: "display:flex; align-items:center; gap: 10px;" },
          el("span", { class: "brand-icon" }, "G"),
          "Galcode 复核台",
        ),
      ),
      el("div", { class: "sub" }, "请用管理员凭据登录。会话有效期 12 小时。"),
      el("label", {}, "用户名"),
      (uIn = el("input", { type: "text", autocomplete: "username", placeholder: "admin" })),
      el("label", {}, "密码"),
      (pIn = el("input", { type: "password", autocomplete: "current-password" })),
      (errBox = el("div", { class: "err" })),
      el(
        "div",
        { class: "submit", style: "display:flex; justify-content:flex-end;" },
        el("button", { type: "submit", class: "primary" }, "登录"),
      ),
    );
    setTimeout(() => uIn?.focus(), 50);
    return el("div", { class: "center" }, form, renderToasts());
  }

  // ---------------------------------------------------------------------------
  // Shell：sidebar + content
  // ---------------------------------------------------------------------------
  function renderShell() {
    const initials = (state.me.username || "?")[0]?.toUpperCase() ?? "?";
    const sidebar = el(
      "aside",
      { class: "sidebar" + (state.mobileNavOpen ? " open" : "") },
      el(
        "div",
        { class: "brand" },
        el("span", { class: "brand-icon" }, "G"),
        el(
          "span",
          {},
          "Galcode",
          el("span", { class: "brand-sub" }, "复核台 · ADMIN"),
        ),
      ),
      el(
        "nav",
        { class: "nav" },
        navItem("dashboard", "仪表盘", ICONS.dashboard),
        navItem("images", "图片", ICONS.image, state.images.pendingReviewBadge),
        navItem("albums", "图集", ICONS.album),
      ),
      el(
        "div",
        { class: "sidebar-bottom" },
        el(
          "div",
          { class: "user-chip" },
          el("span", { class: "avatar" }, initials),
          el("span", { class: "name" }, state.me.username),
          el(
            "button",
            { class: "logout", title: "退出登录", onClick: onLogout },
            icon(ICONS.logout, { size: 14, stroke: 1.6 }),
          ),
        ),
      ),
    );
    let viewBody;
    if (state.view === "dashboard") viewBody = renderDashboard();
    else if (state.view === "images") viewBody = renderImages();
    else if (state.view === "albums") viewBody = renderAlbums();

    return el(
      "div",
      { class: "app-shell" },
      sidebar,
      el("main", { class: "content" }, viewBody),
      state.drawer ? renderDrawer() : null,
      renderToasts(),
      renderKbdHint(),
    );
  }

  function navItem(viewKey, label, iconPath, badge) {
    const active = state.view === viewKey;
    return el(
      "div",
      {
        class: "nav-item" + (active ? " active" : ""),
        onClick: () => {
          state.view = viewKey;
          state.mobileNavOpen = false;
          render();
          if (viewKey === "dashboard" && !state.dashboard.data && !state.dashboard.loading) loadDashboard();
          if (viewKey === "images" && state.images.items.length === 0 && !state.images.loading)
            loadImages({ reset: true });
          if (viewKey === "albums" && state.albums.items.length === 0 && !state.albums.loading)
            loadAlbums({ reset: true });
        },
      },
      el("span", { class: "nav-icon" }, icon(iconPath, { size: 16, stroke: 1.5 })),
      el("span", {}, label),
      badge > 0 ? el("span", { class: "nav-badge" }, fmtNumber(badge)) : null,
    );
  }

  function renderKbdHint() {
    if (state.view !== "images" && state.view !== "albums") return null;
    return el(
      "div",
      { class: "kbd-hint" },
      el("span", {}, el("kbd", {}, "j"), "/", el("kbd", {}, "k"), " 选条"),
      state.view === "images"
        ? el("span", {}, el("kbd", {}, "a"), " 批准 ", el("kbd", {}, "h"), " 下架")
        : null,
      el("span", {}, el("kbd", {}, "/"), " 搜索"),
      el("span", {}, el("kbd", {}, "Esc"), " 关闭"),
    );
  }

  async function onLogout() {
    try {
      await api("POST", "/admin/logout");
    } catch {
      /* ignore */
    }
    state.me = null;
    state.view = "dashboard";
    state.dashboard.data = null;
    state.images.items = [];
    state.albums.items = [];
    state.drawer = null;
    render();
  }

  // ---------------------------------------------------------------------------
  // 仪表盘
  // ---------------------------------------------------------------------------
  function renderDashboard() {
    const d = state.dashboard;
    return el(
      "div",
      {},
      el(
        "div",
        { class: "view-header" },
        el(
          "div",
          { class: "view-title" },
          el("h2", {}, "仪表盘"),
          el("p", {}, "社区当前的概览与热门内容"),
        ),
        el(
          "div",
          { style: "display:flex; gap:6px;" },
          el(
            "button",
            {
              class: "ghost hamburger",
              onClick: () => setState({ mobileNavOpen: !state.mobileNavOpen }),
              title: "菜单",
            },
            icon(ICONS.menu, { size: 16 }),
          ),
          el(
            "button",
            { class: "ghost", onClick: () => loadDashboard() },
            icon(ICONS.refresh, { size: 14 }),
            "刷新",
          ),
        ),
      ),
      el(
        "div",
        { class: "view-body" },
        d.loading && !d.data
          ? el("div", { class: "loading-block" }, "加载中…")
          : d.err
            ? el("div", { class: "empty" }, "加载失败：" + d.err)
            : d.data
              ? renderDashboardContent(d.data)
              : el("div", { class: "loading-block" }, "—"),
      ),
    );
  }

  function renderDashboardContent(data) {
    const { images, albums, moderation } = data;
    const reported = data.topReportedImages || [];
    return el(
      "div",
      {},
      // —— 4 张核心卡 ——
      el(
        "div",
        { class: "stat-grid" },
        statCard(
          "待复核",
          fmtNumber(images.pendingReview),
          `AI 拒绝 ${images.byStatus.rejected ?? 0} · 审核中 ${images.byStatus.pending_ai ?? 0}`,
          images.pendingReview > 0 ? "warning" : "",
        ),
        statCard(
          "举报数",
          fmtNumber(moderation.totalReports),
          `涉及 ${moderation.reportedImageCount} 张图`,
          moderation.totalReports > 0 ? "danger" : "",
        ),
        statCard("图片总数", fmtNumber(images.total), `近 24h +${images.uploadedLast24h}`),
        statCard("图集总数", fmtNumber(albums.total), `近 24h +${albums.uploadedLast24h}`),
      ),

      // —— 单个面板：被举报最多的图（admin 应该最先看这个） ——
      el(
        "div",
        { class: "panel" },
        el(
          "div",
          { class: "panel-title" },
          el("h3", {}, "需关注：被举报最多"),
          el(
            "button",
            {
              class: "ghost small",
              onClick: () => {
                state.images.filter = "reported";
                state.view = "images";
                loadImages({ reset: true });
              },
            },
            "查看全部 →",
          ),
        ),
        reported.length === 0
          ? el("div", { class: "empty", style: "padding: 32px;" }, "暂无被举报的内容")
          : el(
              "div",
              { class: "top-list" },
              reported.map((img) =>
                el(
                  "div",
                  { class: "top-row", onClick: () => openImageDrawer(img.id) },
                  el("div", { class: "thumb" }, el("img", { src: img.url, alt: "", loading: "lazy" })),
                  el(
                    "div",
                    { class: "info" },
                    el(
                      "div",
                      { class: "name" },
                      img.uploaderName || "匿名",
                    ),
                    el(
                      "div",
                      { class: "sub" },
                      `${CATEGORY_LABEL[img.category] ?? img.category} · ${STATUS_LABEL[img.status] ?? img.status} · ${fmtAgo(img.createdAt)}`,
                    ),
                  ),
                  el("div", { class: "score danger" }, "举报 " + img.reportCount),
                ),
              ),
            ),
      ),
    );
  }

  function statCard(label, value, delta, variant) {
    return el(
      "div",
      { class: "stat-card" + (variant ? " " + variant : "") },
      el("div", { class: "label" }, label),
      el("div", { class: "value" }, value),
      delta ? el("div", { class: "delta" }, delta) : null,
    );
  }

  async function loadDashboard() {
    state.dashboard.loading = true;
    state.dashboard.err = "";
    render();
    try {
      const data = await api("GET", "/admin/api/stats");
      state.dashboard.data = data;
      state.images.pendingReviewBadge = data.images.pendingReview ?? 0;
    } catch (err) {
      state.dashboard.err = err.message || "未知错误";
    } finally {
      state.dashboard.loading = false;
      render();
    }
  }

  // ---------------------------------------------------------------------------
  // 图片视图
  // ---------------------------------------------------------------------------
  function renderImages() {
    const s = state.images;
    return el(
      "div",
      {},
      el(
        "div",
        { class: "view-header" },
        el(
          "div",
          { class: "view-title" },
          el("h2", {}, "图片"),
          el("p", {}, "复核 / 浏览所有图片"),
        ),
        el(
          "button",
          {
            class: "ghost hamburger",
            onClick: () => setState({ mobileNavOpen: !state.mobileNavOpen }),
          },
          icon(ICONS.menu, { size: 16 }),
        ),
      ),
      el(
        "div",
        { class: "view-body" },
        renderImageToolbar(),
        s.selectedIds.size > 0 ? renderBulkBar() : null,
        renderImageList(),
        s.cursor && s.items.length > 0
          ? el(
              "div",
              { class: "pager" },
              el(
                "button",
                { class: "ghost", onClick: () => loadImages({ reset: false }) },
                s.loading ? "加载中…" : "加载更多",
              ),
            )
          : null,
      ),
    );
  }

  function renderImageToolbar() {
    const s = state.images;
    let qInput;
    return el(
      "div",
      { class: "toolbar" },
      el(
        "label",
        { class: "search", id: "imageSearch" },
        el("span", { class: "icon" }, icon(ICONS.search, { size: 14 })),
        (qInput = el("input", {
          type: "search",
          placeholder: "搜索 deviceId / uploader 名…",
          value: s.q,
          onInput: (e) => {
            s.q = e.target.value;
          },
          onKeydown: (e) => {
            if (e.key === "Enter") {
              loadImages({ reset: true });
            } else if (e.key === "Escape") {
              s.q = "";
              loadImages({ reset: true });
            }
          },
        })),
      ),
      filterSelect("filter", s.filter, [
        ["rejected", "AI 拒绝"],
        ["reported", "被举报"],
        ["pending_ai", "审核中"],
        ["approved", "已通过"],
        ["hidden_by_owner", "本人隐藏"],
        ["hidden_by_admin", "后台下架"],
        ["all", "全部"],
      ], (v) => {
        s.filter = v;
        loadImages({ reset: true });
      }),
      filterSelect("category", s.category || "", [
        ["", "全部类别"],
        ...Object.entries(CATEGORY_LABEL),
      ], (v) => {
        s.category = v;
        loadImages({ reset: true });
      }),
      el("div", { class: "spacer" }),
      el(
        "div",
        { class: "view-toggle" },
        el(
          "button",
          {
            class: s.mode === "list" ? "active" : "",
            onClick: () => setImagesState({ mode: "list" }),
            title: "列表",
          },
          icon(ICONS.list, { size: 14 }),
        ),
        el(
          "button",
          {
            class: s.mode === "grid" ? "active" : "",
            onClick: () => setImagesState({ mode: "grid" }),
            title: "网格",
          },
          icon(ICONS.grid, { size: 14 }),
        ),
      ),
      el(
        "button",
        { class: "ghost", onClick: () => loadImages({ reset: true }) },
        icon(ICONS.refresh, { size: 14 }),
        "刷新",
      ),
    );
  }

  function filterSelect(label, value, options, onChange) {
    const sel = el(
      "select",
      {
        onChange: (e) => onChange(e.target.value),
      },
      options.map(([v, lbl]) => {
        const opt = el("option", { value: v }, lbl);
        if (v === value) opt.setAttribute("selected", "selected");
        return opt;
      }),
    );
    sel.value = value;
    return sel;
  }

  function renderBulkBar() {
    const s = state.images;
    const count = s.selectedIds.size;
    return el(
      "div",
      { class: "bulk-bar" },
      el("span", {}, "已选 ", el("span", { class: "count" }, count), " 张"),
      el("button", { class: "small ghost", onClick: () => clearSelection() }, "取消选择"),
      el("div", { class: "spacer" }),
      el(
        "button",
        { class: "small success", onClick: () => bulkSetStatus("approved") },
        icon(ICONS.check, { size: 12 }),
        "批量上架",
      ),
      el(
        "button",
        { class: "small danger", onClick: () => bulkSetStatus("hidden_by_admin") },
        icon(ICONS.eyeOff, { size: 12 }),
        "批量下架",
      ),
    );
  }

  function renderImageList() {
    const s = state.images;
    if (s.loading && s.items.length === 0) {
      // 骨架屏
      const skeletons = Array.from({ length: 5 });
      return s.mode === "grid"
        ? el("div", { class: "grid" }, skeletons.map(() => el("div", { class: "skeleton tile-img" })))
        : el("div", {}, skeletons.map(() => el("div", { class: "skeleton row" })));
    }
    if (s.err) return el("div", { class: "empty" }, "加载失败：" + s.err);
    if (s.items.length === 0)
      return el(
        "div",
        { class: "empty" },
        el("div", { class: "big" }, "—"),
        el("div", {}, "没有匹配的图片"),
        el("div", { style: "font-size:11px; margin-top:4px;" }, "试试切换筛选条件或清空搜索"),
      );
    if (s.mode === "grid") return el("div", { class: "grid" }, s.items.map((it, idx) => renderImageTile(it, idx)));
    return el("div", {}, s.items.map((it, idx) => renderImageRow(it, idx)));
  }

  function renderImageRow(item, idx) {
    const s = state.images;
    const selected = s.selectedIds.has(item.id);
    return el(
      "div",
      {
        class: "row" + (selected ? " selected" : "") + (idx === s.focusedIndex ? " focused" : ""),
        onClick: (e) => {
          if (e.target.closest(".pick") || e.target.closest(".actions")) return;
          openImageDrawer(item.id);
        },
      },
      el(
        "div",
        { class: "pick" },
        el("input", {
          type: "checkbox",
          checked: selected ? "checked" : null,
          onClick: (e) => {
            e.stopPropagation();
            toggleSelection(item.id);
          },
        }),
      ),
      el(
        "div",
        { class: "thumb" },
        el("img", { src: item.url, alt: "", loading: "lazy" }),
      ),
      el(
        "div",
        { class: "meta" },
        el(
          "div",
          { class: "title" },
          el("span", { class: "name" }, item.uploaderName || "匿名"),
          categoryBadge(item.category),
          statusBadge(item.status),
          item.reportCount > 0 ? el("span", { class: "badge reports" }, "举报 " + item.reportCount) : null,
        ),
        item.prompt
          ? el("div", { class: "prompt" }, "风格：" + item.prompt)
          : el("div", { class: "prompt", style: "color: var(--faint); font-style: italic;" }, "（无 prompt）"),
        el(
          "div",
          { class: "ids" },
          el("span", { class: "code" }, "id=" + shortId(item.id, 12)),
          el("span", { class: "code" }, "device=" + shortId(item.deviceId, 12)),
          el("span", {}, "热度 " + fmtNumber(item.useCount ?? 0)),
          item.aiVerdict ? el("span", {}, "ai=" + item.aiVerdict) : null,
          el("span", {}, fmtAgo(item.createdAt)),
        ),
      ),
      el(
        "div",
        { class: "actions" },
        item.status !== "approved"
          ? el(
              "button",
              {
                class: "small success",
                onClick: (e) => {
                  e.stopPropagation();
                  setImageStatus(item.id, "approved");
                },
              },
              icon(ICONS.check, { size: 12 }),
              "上架",
            )
          : null,
        item.status !== "hidden_by_admin"
          ? el(
              "button",
              {
                class: "small danger",
                onClick: (e) => {
                  e.stopPropagation();
                  setImageStatus(item.id, "hidden_by_admin");
                },
              },
              icon(ICONS.eyeOff, { size: 12 }),
              "下架",
            )
          : null,
      ),
    );
  }

  function renderImageTile(item, idx) {
    const s = state.images;
    const selected = s.selectedIds.has(item.id);
    return el(
      "div",
      {
        class: "tile" + (selected ? " selected" : "") + (idx === s.focusedIndex ? " focused" : ""),
        onClick: (e) => {
          if (e.target.closest(".pick")) return;
          openImageDrawer(item.id);
        },
      },
      el(
        "div",
        { class: "pick", onClick: (e) => e.stopPropagation() },
        el("input", {
          type: "checkbox",
          checked: selected ? "checked" : null,
          onChange: () => toggleSelection(item.id),
        }),
      ),
      el(
        "div",
        { class: "img" },
        el("img", { src: item.url, alt: "", loading: "lazy" }),
        el(
          "div",
          { class: "corner-badges" },
          statusBadge(item.status),
          item.reportCount > 0 ? el("span", { class: "badge reports" }, "举报 " + item.reportCount) : null,
        ),
      ),
      el(
        "div",
        { class: "info" },
        el(
          "div",
          { class: "row-1" },
          el("span", { class: "name" }, item.uploaderName || "匿名"),
          categoryBadge(item.category),
        ),
        el("div", { class: "sub" }, shortId(item.id, 8) + " · " + fmtAgo(item.createdAt)),
      ),
    );
  }

  function toggleSelection(id) {
    const s = state.images;
    if (s.selectedIds.has(id)) s.selectedIds.delete(id);
    else s.selectedIds.add(id);
    render();
  }
  function clearSelection() {
    state.images.selectedIds.clear();
    render();
  }

  async function loadImages({ reset }) {
    const s = state.images;
    if (s.loading) return;
    s.loading = true;
    s.err = "";
    if (reset) {
      s.items = [];
      s.cursor = null;
      s.selectedIds.clear();
      s.focusedIndex = -1;
    }
    render();
    try {
      const params = new URLSearchParams({ filter: s.filter });
      if (s.q) params.set("q", s.q);
      if (s.category) params.set("category", s.category);
      if (s.dateFrom) params.set("dateFrom", s.dateFrom);
      if (s.dateTo) params.set("dateTo", s.dateTo);
      if (!reset && s.cursor) {
        if (s.filter === "reported") params.set("offset", s.cursor);
        else params.set("cursor", s.cursor);
      }
      const data = await api("GET", "/admin/api/images?" + params.toString());
      s.items = reset ? data.items : s.items.concat(data.items);
      s.cursor = data.nextCursor;
    } catch (err) {
      s.err = err.message;
    } finally {
      s.loading = false;
      render();
    }
  }

  async function setImageStatus(id, status) {
    try {
      await api("PATCH", `/admin/api/images/${encodeURIComponent(id)}/status`, { status });
      toast(status === "approved" ? "已上架" : "已下架", "ok");
      // 局部更新：列表里把该项的 status 改了，避免整页重新拉
      const s = state.images;
      const idx = s.items.findIndex((x) => x.id === id);
      if (idx >= 0) s.items[idx] = { ...s.items[idx], status };
      if (state.drawer && state.drawer.kind === "image" && state.drawer.data?.image?.id === id) {
        state.drawer.data.image = { ...state.drawer.data.image, status };
      }
      render();
    } catch (err) {
      toast("操作失败：" + err.message, "err");
    }
  }

  async function bulkSetStatus(status) {
    const s = state.images;
    if (s.selectedIds.size === 0) return;
    const ids = Array.from(s.selectedIds);
    toast(`正在处理 ${ids.length} 张…`);
    let ok = 0;
    let fail = 0;
    // 顺序请求，避免并发触发限速
    for (const id of ids) {
      try {
        await api("PATCH", `/admin/api/images/${encodeURIComponent(id)}/status`, { status });
        const idx = s.items.findIndex((x) => x.id === id);
        if (idx >= 0) s.items[idx] = { ...s.items[idx], status };
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    s.selectedIds.clear();
    toast(`完成：成功 ${ok}${fail > 0 ? `，失败 ${fail}` : ""}`, fail > 0 ? "err" : "ok");
    render();
  }

  // ---------------------------------------------------------------------------
  // 图集视图
  // ---------------------------------------------------------------------------
  function renderAlbums() {
    const s = state.albums;
    return el(
      "div",
      {},
      el(
        "div",
        { class: "view-header" },
        el(
          "div",
          { class: "view-title" },
          el("h2", {}, "图集"),
          el("p", {}, "用户发布的预设图集"),
        ),
        el(
          "button",
          {
            class: "ghost hamburger",
            onClick: () => setState({ mobileNavOpen: !state.mobileNavOpen }),
          },
          icon(ICONS.menu, { size: 16 }),
        ),
      ),
      el(
        "div",
        { class: "view-body" },
        renderAlbumToolbar(),
        renderAlbumList(),
        s.cursor && s.items.length > 0
          ? el(
              "div",
              { class: "pager" },
              el(
                "button",
                { class: "ghost", onClick: () => loadAlbums({ reset: false }) },
                s.loading ? "加载中…" : "加载更多",
              ),
            )
          : null,
      ),
    );
  }

  function renderAlbumToolbar() {
    const s = state.albums;
    return el(
      "div",
      { class: "toolbar" },
      el(
        "label",
        { class: "search" },
        el("span", { class: "icon" }, icon(ICONS.search, { size: 14 })),
        el("input", {
          type: "search",
          placeholder: "搜索图集名 / deviceId / uploader…",
          value: s.q,
          onInput: (e) => {
            s.q = e.target.value;
          },
          onKeydown: (e) => {
            if (e.key === "Enter") loadAlbums({ reset: true });
            else if (e.key === "Escape") {
              s.q = "";
              loadAlbums({ reset: true });
            }
          },
        }),
      ),
      filterSelect(
        "filter",
        s.filter,
        [
          ["all", "全部"],
          ["active", "公开"],
          ["hidden_by_owner", "本人隐藏"],
          ["hidden_by_admin", "后台下架"],
        ],
        (v) => {
          s.filter = v;
          loadAlbums({ reset: true });
        },
      ),
      el("div", { class: "spacer" }),
      el(
        "button",
        { class: "ghost", onClick: () => loadAlbums({ reset: true }) },
        icon(ICONS.refresh, { size: 14 }),
        "刷新",
      ),
    );
  }

  function renderAlbumList() {
    const s = state.albums;
    if (s.loading && s.items.length === 0) {
      return el(
        "div",
        { class: "grid" },
        Array.from({ length: 6 }, () => el("div", { class: "skeleton tile-img" })),
      );
    }
    if (s.err) return el("div", { class: "empty" }, "加载失败：" + s.err);
    if (s.items.length === 0)
      return el(
        "div",
        { class: "empty" },
        el("div", { class: "big" }, "—"),
        el("div", {}, "没有图集"),
      );
    return el(
      "div",
      { class: "grid" },
      s.items.map((alb) => renderAlbumCard(alb)),
    );
  }

  function renderAlbumCard(alb) {
    return el(
      "div",
      {
        class: "album-card",
        onClick: () => openAlbumDrawer(alb.id),
      },
      el(
        "div",
        { class: "cover" },
        alb.coverUrl
          ? el("img", { src: alb.coverUrl, alt: "", loading: "lazy" })
          : el("div", { class: "empty-cover" }, "—"),
        el("div", { class: "count" }, alb.imageCount + " 张"),
      ),
      el(
        "div",
        { class: "body" },
        el("div", { class: "name" }, alb.name),
        el(
          "div",
          { class: "uploader" },
          (alb.uploaderName || "匿名") + " · " + shortId(alb.deviceId, 8),
        ),
        el(
          "div",
          { class: "desc" },
          alb.description || "（无描述）",
        ),
        el(
          "div",
          { class: "row-bottom" },
          statusBadge(alb.status),
          el("span", {}, "♨ " + fmtNumber(alb.popularity ?? 0)),
          el("span", { style: "margin-left:auto;" }, fmtAgo(alb.createdAt)),
        ),
      ),
    );
  }

  async function loadAlbums({ reset }) {
    const s = state.albums;
    if (s.loading) return;
    s.loading = true;
    s.err = "";
    if (reset) {
      s.items = [];
      s.cursor = null;
    }
    render();
    try {
      const params = new URLSearchParams({ filter: s.filter });
      if (s.q) params.set("q", s.q);
      if (!reset && s.cursor) params.set("cursor", s.cursor);
      const data = await api("GET", "/admin/api/albums?" + params.toString());
      s.items = reset ? data.items : s.items.concat(data.items);
      s.cursor = data.nextCursor;
    } catch (err) {
      s.err = err.message;
    } finally {
      s.loading = false;
      render();
    }
  }

  async function setAlbumStatus(id, status) {
    try {
      await api("PATCH", `/admin/api/albums/${encodeURIComponent(id)}/status`, { status });
      toast(status === "active" ? "已恢复" : "已下架", "ok");
      const s = state.albums;
      const idx = s.items.findIndex((x) => x.id === id);
      if (idx >= 0) s.items[idx] = { ...s.items[idx], status };
      if (state.drawer && state.drawer.kind === "album" && state.drawer.data?.album?.id === id) {
        state.drawer.data.album = { ...state.drawer.data.album, status };
      }
      render();
    } catch (err) {
      toast("操作失败：" + err.message, "err");
    }
  }

  // ---------------------------------------------------------------------------
  // 详情抽屉
  // ---------------------------------------------------------------------------
  function renderDrawer() {
    if (!state.drawer) return null;
    return el(
      "div",
      {},
      el("div", { class: "drawer-mask", onClick: () => setDrawer(null) }),
      el(
        "div",
        { class: "drawer" },
        renderDrawerContent(),
      ),
    );
  }

  function renderDrawerContent() {
    const d = state.drawer;
    if (d.loading) {
      return frag(
        el(
          "div",
          { class: "drawer-header" },
          el("h3", {}, d.kind === "image" ? "图片详情" : "图集详情"),
          el("button", { class: "ghost", onClick: () => setDrawer(null), title: "关闭" }, icon(ICONS.close, { size: 14 })),
        ),
        el("div", { class: "drawer-body" }, el("div", { class: "loading-block" }, "加载中…")),
      );
    }
    if (d.err) {
      return frag(
        el(
          "div",
          { class: "drawer-header" },
          el("h3", {}, "加载失败"),
          el("button", { class: "ghost", onClick: () => setDrawer(null) }, icon(ICONS.close, { size: 14 })),
        ),
        el("div", { class: "drawer-body" }, el("div", { class: "empty" }, d.err)),
      );
    }
    if (d.kind === "image") return renderImageDrawer(d.data);
    if (d.kind === "album") return renderAlbumDrawer(d.data);
    return null;
  }

  function renderImageDrawer(data) {
    const img = data.image;
    return frag(
      el(
        "div",
        { class: "drawer-header" },
        el("h3", {}, "图片详情"),
        el("button", { class: "ghost", onClick: () => setDrawer(null), title: "关闭 (Esc)" }, icon(ICONS.close, { size: 14 })),
      ),
      el(
        "div",
        { class: "drawer-body" },
        el(
          "div",
          { class: "preview" },
          el("img", { src: img.url, alt: "" }),
        ),
        el(
          "div",
          { class: "panel", style: "margin: 0;" },
          el(
            "div",
            { class: "panel-title" },
            el(
              "h3",
              {},
              statusBadge(img.status),
              " ",
              categoryBadge(img.category),
              data.reports?.length > 0
                ? el("span", { class: "badge reports", style: "margin-left:4px;" }, "举报 " + data.reports.length)
                : null,
            ),
            el("span", { class: "meta" }, fmtTime(img.createdAt)),
          ),
          el(
            "div",
            { class: "field-grid" },
            el("p", { class: "label" }, "ID"),
            el("div", { class: "value code" }, img.id),
            el("p", { class: "label" }, "设备"),
            el("div", { class: "value code" }, img.deviceId),
            el("p", { class: "label" }, "上传者"),
            el("div", { class: "value" }, img.uploaderName || el("span", { style: "color:var(--muted);" }, "（匿名）")),
            el("p", { class: "label" }, "文件"),
            el("div", { class: "value" }, `${img.mime} · ${fmtBytes(img.sizeBytes)}` + (img.width ? ` · ${img.width}×${img.height}` : "")),
            el("p", { class: "label" }, "热度"),
            el("div", { class: "value" }, `popularity ${img.popularity ?? 0} · use ${img.useCount ?? 0} · likes ${img.likes ?? 0}`),
            img.aiVerdict
              ? [
                  el("p", { class: "label" }, "AI 判定"),
                  el("div", { class: "value" }, img.aiVerdict),
                ]
              : null,
            img.prompt
              ? [
                  el("p", { class: "label" }, "Prompt"),
                  el("div", { class: "value", style: "white-space: pre-wrap;" }, img.prompt),
                ]
              : null,
          ),
        ),
        // —— 所属图集 ——
        data.albums?.length > 0
          ? el(
              "div",
              { class: "panel", style: "margin: 0;" },
              el(
                "div",
                { class: "panel-title" },
                el("h3", {}, "所属图集"),
                el("span", { class: "meta" }, data.albums.length + " 个"),
              ),
              el(
                "div",
                {},
                data.albums.map((a) =>
                  el(
                    "span",
                    {
                      class: "album-pill",
                      onClick: () => openAlbumDrawer(a.id),
                      title: `${a.uploaderName || "匿名"} · ${fmtAgo(a.createdAt)}`,
                    },
                    a.name,
                    a.status !== "active" ? el("span", { class: "badge " + a.status, style: "margin-left:4px;" }, STATUS_LABEL[a.status] ?? a.status) : null,
                  ),
                ),
              ),
            )
          : null,
        // —— 举报记录 ——
        el(
          "div",
          { class: "panel", style: "margin: 0;" },
          el(
            "div",
            { class: "panel-title" },
            el("h3", {}, "举报记录"),
            el("span", { class: "meta" }, (data.reports?.length ?? 0) + " 条"),
          ),
          data.reports?.length === 0
            ? el("div", { class: "empty", style: "padding: 24px;" }, "暂无举报")
            : el(
                "div",
                { class: "report-list" },
                data.reports.map((r) =>
                  el(
                    "div",
                    { class: "report-item" },
                    el(
                      "div",
                      { class: "head" },
                      icon(ICONS.flag, { size: 12 }),
                      el("span", { class: "device" }, shortId(r.deviceId, 16)),
                      el("span", { class: "time" }, fmtTime(r.createdAt)),
                    ),
                    el("div", { class: "reason" }, r.reason || el("span", { style: "color: var(--faint); font-style: italic;" }, "（未填理由）")),
                  ),
                ),
              ),
        ),
      ),
      el(
        "div",
        { class: "drawer-footer" },
        el("button", { class: "ghost", onClick: () => setDrawer(null) }, "关闭"),
        img.status !== "approved"
          ? el(
              "button",
              { class: "success", onClick: () => setImageStatus(img.id, "approved") },
              icon(ICONS.check, { size: 14 }),
              "通过上架",
            )
          : null,
        img.status !== "hidden_by_admin"
          ? el(
              "button",
              { class: "danger", onClick: () => setImageStatus(img.id, "hidden_by_admin") },
              icon(ICONS.eyeOff, { size: 14 }),
              "下架",
            )
          : null,
      ),
    );
  }

  function renderAlbumDrawer(data) {
    const alb = data.album;
    const images = data.images || [];
    return frag(
      el(
        "div",
        { class: "drawer-header" },
        el("h3", {}, alb.name),
        el("button", { class: "ghost", onClick: () => setDrawer(null), title: "关闭 (Esc)" }, icon(ICONS.close, { size: 14 })),
      ),
      el(
        "div",
        { class: "drawer-body" },
        el(
          "div",
          { class: "panel", style: "margin: 0;" },
          el(
            "div",
            { class: "panel-title" },
            el("h3", {}, statusBadge(alb.status), " ", el("span", { style: "color:var(--text);" }, alb.name)),
            el("span", { class: "meta" }, fmtTime(alb.createdAt)),
          ),
          el(
            "div",
            { class: "field-grid" },
            el("p", { class: "label" }, "ID"),
            el("div", { class: "value code" }, alb.id),
            el("p", { class: "label" }, "设备"),
            el("div", { class: "value code" }, alb.deviceId),
            el("p", { class: "label" }, "上传者"),
            el("div", { class: "value" }, alb.uploaderName || el("span", { style: "color:var(--muted);" }, "（匿名）")),
            el("p", { class: "label" }, "图片数量"),
            el("div", { class: "value" }, alb.imageCount + " 张"),
            el("p", { class: "label" }, "热度 / 点赞"),
            el("div", { class: "value" }, `popularity ${alb.popularity ?? 0} · likes ${alb.likes ?? 0}`),
            alb.description
              ? [
                  el("p", { class: "label" }, "描述"),
                  el("div", { class: "value", style: "white-space: pre-wrap;" }, alb.description),
                ]
              : null,
          ),
        ),
        el(
          "div",
          { class: "panel", style: "margin: 0;" },
          el(
            "div",
            { class: "panel-title" },
            el("h3", {}, "图集内容"),
            el("span", { class: "meta" }, images.length + " 张"),
          ),
          images.length === 0
            ? el("div", { class: "empty", style: "padding: 24px;" }, "（空图集）")
            : el(
                "div",
                { class: "grid", style: "grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px;" },
                images.map((img) =>
                  el(
                    "div",
                    {
                      class: "tile",
                      style: "border-radius: var(--radius);",
                      onClick: () => openImageDrawer(img.id),
                      title: `${CATEGORY_LABEL[img.category] ?? img.category} · ${STATUS_LABEL[img.status] ?? img.status}`,
                    },
                    el(
                      "div",
                      { class: "img" },
                      el("img", { src: img.url, alt: "", loading: "lazy" }),
                      el(
                        "div",
                        { class: "corner-badges" },
                        img.status !== "approved" ? statusBadge(img.status) : null,
                      ),
                    ),
                    el(
                      "div",
                      { class: "info", style: "padding: 6px 8px;" },
                      el("div", { class: "row-1" }, categoryBadge(img.category)),
                    ),
                  ),
                ),
              ),
        ),
      ),
      el(
        "div",
        { class: "drawer-footer" },
        el("button", { class: "ghost", onClick: () => setDrawer(null) }, "关闭"),
        alb.status === "hidden_by_admin"
          ? el(
              "button",
              { class: "success", onClick: () => setAlbumStatus(alb.id, "active") },
              icon(ICONS.check, { size: 14 }),
              "恢复显示",
            )
          : el(
              "button",
              { class: "danger", onClick: () => setAlbumStatus(alb.id, "hidden_by_admin") },
              icon(ICONS.eyeOff, { size: 14 }),
              "强制下架",
            ),
      ),
    );
  }

  async function openImageDrawer(id) {
    state.drawer = { kind: "image", id, loading: true, data: null, err: "" };
    render();
    try {
      const data = await api("GET", "/admin/api/images/" + encodeURIComponent(id));
      if (state.drawer?.id === id) {
        state.drawer.data = data;
        state.drawer.loading = false;
        render();
      }
    } catch (err) {
      if (state.drawer?.id === id) {
        state.drawer.err = err.message;
        state.drawer.loading = false;
        render();
      }
    }
  }

  async function openAlbumDrawer(id) {
    state.drawer = { kind: "album", id, loading: true, data: null, err: "" };
    render();
    try {
      // 走 admin 专属端点——public /api/albums/:id 对 hidden_by_owner / hidden_by_admin
      // 一律 404，admin 还是要能看到这些做处置。
      const data = await api("GET", "/admin/api/albums/" + encodeURIComponent(id));
      if (state.drawer?.id === id) {
        state.drawer.data = data;
        state.drawer.loading = false;
        render();
      }
    } catch (err) {
      if (state.drawer?.id === id) {
        state.drawer.err = err.message;
        state.drawer.loading = false;
        render();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 键盘快捷键
  // ---------------------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    // 输入框聚焦时不接管（除了 ESC）
    const target = e.target;
    const inField =
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

    if (e.key === "Escape") {
      if (state.drawer) {
        setDrawer(null);
        e.preventDefault();
        return;
      }
      if (inField) {
        target.blur();
        return;
      }
    }
    if (inField) return;
    if (!state.me) return;

    // 抽屉打开时键盘事件不参与列表导航
    if (state.drawer) return;

    // 视图切换
    if (e.key === "1") {
      state.view = "dashboard";
      render();
      if (!state.dashboard.data) loadDashboard();
    } else if (e.key === "2") {
      state.view = "images";
      render();
      if (state.images.items.length === 0) loadImages({ reset: true });
    } else if (e.key === "3") {
      state.view = "albums";
      render();
      if (state.albums.items.length === 0) loadAlbums({ reset: true });
    } else if (e.key === "/") {
      const input = document.querySelector(".toolbar .search input");
      if (input) {
        input.focus();
        e.preventDefault();
      }
    } else if (e.key === "r" && (e.metaKey || e.ctrlKey)) {
      // 让浏览器刷新；不拦
    } else if (state.view === "images") {
      const s = state.images;
      if (e.key === "j") {
        s.focusedIndex = Math.min(s.items.length - 1, s.focusedIndex + 1);
        render();
        scrollFocusedIntoView();
        e.preventDefault();
      } else if (e.key === "k") {
        s.focusedIndex = Math.max(0, s.focusedIndex - 1);
        render();
        scrollFocusedIntoView();
        e.preventDefault();
      } else if (e.key === "Enter" && s.focusedIndex >= 0) {
        openImageDrawer(s.items[s.focusedIndex].id);
        e.preventDefault();
      } else if ((e.key === "x" || e.key === " ") && s.focusedIndex >= 0) {
        toggleSelection(s.items[s.focusedIndex].id);
        e.preventDefault();
      } else if (e.key === "a" && s.focusedIndex >= 0) {
        setImageStatus(s.items[s.focusedIndex].id, "approved");
        e.preventDefault();
      } else if (e.key === "h" && s.focusedIndex >= 0) {
        setImageStatus(s.items[s.focusedIndex].id, "hidden_by_admin");
        e.preventDefault();
      }
    }
  });

  function scrollFocusedIntoView() {
    const focused = document.querySelector(".row.focused, .tile.focused");
    if (focused) focused.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------
  (async function boot() {
    try {
      state.me = await api("GET", "/admin/me");
    } catch {
      state.me = null;
    }
    state.booting = false;
    render();
    if (state.me) {
      await loadDashboard();
    }
  })();
})();
