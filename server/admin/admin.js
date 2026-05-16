// 复核台 SPA。零依赖 vanilla JS。状态机：
//   booting → (login | main)
//   main → 切 filter / 列表 / 上下架
//
// 路由不入 URL hash，刷新就 boot 一次。session cookie 自带。

(function () {
  const $app = document.getElementById('app');
  let state = {
    me: null,                 // {username} | null
    filter: 'rejected',       // rejected | reported | all
    items: [],
    cursor: null,
    loading: false,
    err: '',
  };

  // ---------- 通用 ----------
  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach((x) => e.append(x?.nodeType ? x : document.createTextNode(String(x))));
      else if (c.nodeType) e.append(c);
      else e.append(document.createTextNode(String(c)));
    }
    return e;
  }

  async function api(method, path, body) {
    const opts = { method, credentials: 'include', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    const text = await res.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    }
    if (!res.ok) {
      const err = new Error(parsed?.message || parsed?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }

  function toast(msg) {
    const t = el('div', { class: 'toast' }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 2500);
  }

  // ---------- 视图：登录 ----------
  function renderLogin(prefillErr = '') {
    let usernameInput, passwordInput, errBox;
    const onSubmit = async (e) => {
      e?.preventDefault();
      errBox.textContent = '';
      const u = usernameInput.value.trim();
      const p = passwordInput.value;
      if (!u || !p) {
        errBox.textContent = '用户名 / 密码不能为空';
        return;
      }
      try {
        const me = await api('POST', '/admin/login', { username: u, password: p });
        state.me = me;
        render();
      } catch (err) {
        errBox.textContent = err.message || '登录失败';
      }
    };
    const root = el('div', { class: 'center' },
      el('form', { class: 'card', onSubmit },
        el('h1', {}, 'Galcode 复核台'),
        el('div', { class: 'muted' }, '管理员登录'),
        el('label', {}, '用户名'),
        (usernameInput = el('input', { type: 'text', autocomplete: 'username' })),
        el('label', {}, '密码'),
        (passwordInput = el('input', { type: 'password', autocomplete: 'current-password' })),
        (errBox = el('div', { class: 'err' }, prefillErr)),
        el('div', { style: 'margin-top: 16px; display:flex; justify-content:flex-end;' },
          el('button', { type: 'submit' }, '登录'),
        ),
      ),
    );
    $app.replaceChildren(root);
    setTimeout(() => usernameInput?.focus(), 50);
  }

  // ---------- 视图：主界面 ----------
  function statusBadge(s) {
    return el('span', { class: 'badge ' + s }, statusLabel(s));
  }
  function statusLabel(s) {
    return {
      approved: '已通过',
      rejected: 'AI 拒绝',
      hidden_by_owner: '本人隐藏',
      hidden_by_admin: '后台下架',
      pending_ai: '审核中',
    }[s] ?? s;
  }

  function rowView(item) {
    let approveBtn, hideBtn;
    const onApprove = async () => {
      approveBtn.disabled = true;
      try {
        await api('PATCH', `/admin/api/images/${encodeURIComponent(item.id)}/status`, { status: 'approved' });
        toast('已上架');
        await refresh();
      } catch (err) {
        toast(`操作失败：${err.message}`);
        approveBtn.disabled = false;
      }
    };
    const onHide = async () => {
      hideBtn.disabled = true;
      try {
        await api('PATCH', `/admin/api/images/${encodeURIComponent(item.id)}/status`, { status: 'hidden_by_admin' });
        toast('已下架');
        await refresh();
      } catch (err) {
        toast(`操作失败：${err.message}`);
        hideBtn.disabled = false;
      }
    };
    return el('div', { class: 'row' },
      el('div', { class: 'thumb' },
        el('img', { src: item.url, alt: '' }),
      ),
      el('div', { class: 'meta' },
        el('div', { class: 'title' },
          el('strong', {}, item.uploaderName || '匿名'),
          el('span', { class: 'muted' }, item.category),
          statusBadge(item.status),
          item.reportCount > 0 ? el('span', { class: 'badge reports' }, `举报 ${item.reportCount}`) : null,
        ),
        item.prompt
          ? el('div', { class: 'prompt' }, '风格：' + item.prompt)
          : el('div', { class: 'prompt muted' }, '（无 prompt）'),
        el('div', { class: 'ids' },
          'id=' + item.id + ' · device=' + item.deviceId + ' · 热度=' + item.useCount,
          item.aiVerdict ? ' · ai=' + item.aiVerdict : '',
        ),
      ),
      el('div', { class: 'actions' },
        (approveBtn = el('button', { class: 'ok', onClick: onApprove },
          item.status === 'approved' ? '已通过' : '上架',
        )),
        (hideBtn = el('button', { class: 'danger', onClick: onHide },
          item.status === 'hidden_by_admin' ? '已下架' : '下架',
        )),
      ),
    );
  }

  function renderMain() {
    const onFilter = (next) => async () => {
      state.filter = next;
      state.items = [];
      state.cursor = null;
      render();
      await refresh();
    };
    const onLogout = async () => {
      try { await api('POST', '/admin/logout'); } catch { /* ignore */ }
      state.me = null;
      render();
    };
    const root = el('div', { class: 'layout' },
      el('header', { class: 'bar' },
        el('h1', {}, 'Galcode 桌宠图 · 复核台'),
        el('div', { class: 'right' },
          el('span', { class: 'muted' }, state.me.username),
          el('button', { class: 'ghost', onClick: onLogout }, '退出'),
        ),
      ),
      el('nav', { class: 'filters' },
        el('button', { class: state.filter === 'rejected' ? 'active' : '', onClick: onFilter('rejected') }, 'AI 拒绝（待复核）'),
        el('button', { class: state.filter === 'reported' ? 'active' : '', onClick: onFilter('reported') }, '被举报'),
        el('button', { class: state.filter === 'all' ? 'active' : '', onClick: onFilter('all') }, '全部'),
        el('button', { class: 'ghost', style: 'margin-left:auto;', onClick: () => refresh() }, '刷新'),
      ),
      el('main', { class: 'list' },
        state.loading && state.items.length === 0
          ? el('div', { class: 'empty' }, '加载中…')
          : state.err
            ? el('div', { class: 'empty err' }, state.err)
            : state.items.length === 0
              ? el('div', { class: 'empty' }, statusLabel(state.filter) + ' 没有数据')
              : state.items.map(rowView),
        state.cursor && state.items.length > 0
          ? el('div', { style: 'text-align:center; padding: 12px;' },
              el('button', { class: 'ghost', onClick: () => loadMore() }, state.loading ? '加载中…' : '加载更多'),
            )
          : null,
      ),
    );
    $app.replaceChildren(root);
  }

  // ---------- 列表 ----------
  async function refresh() {
    state.loading = true;
    state.err = '';
    state.items = [];
    state.cursor = null;
    render();
    try {
      const data = await api('GET', `/admin/api/images?filter=${encodeURIComponent(state.filter)}`);
      state.items = data.items;
      state.cursor = data.nextCursor;
    } catch (err) {
      state.err = err.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadMore() {
    if (state.loading || !state.cursor) return;
    state.loading = true;
    render();
    try {
      // reported 用 offset 风格的游标；其它走 base64 cursor
      const q = state.filter === 'reported'
        ? `filter=reported&offset=${encodeURIComponent(state.cursor)}`
        : `filter=${encodeURIComponent(state.filter)}&cursor=${encodeURIComponent(state.cursor)}`;
      const data = await api('GET', `/admin/api/images?${q}`);
      state.items = state.items.concat(data.items);
      state.cursor = data.nextCursor;
    } catch (err) {
      state.err = err.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  function render() {
    if (state.me) renderMain();
    else renderLogin();
  }

  // ---------- 启动 ----------
  (async function boot() {
    try {
      state.me = await api('GET', '/admin/me');
    } catch {
      state.me = null;
    }
    render();
    if (state.me) await refresh();
  })();
})();
