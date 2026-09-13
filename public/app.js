/* 墨锭试磨室 · 复测排程与盲测复核台 */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STAGE_KEY = { 待排程: "pending", 试磨中: "active", 待复核: "review", 已结案: "closed" };

const state = {
  me: { role: localStorage.getItem("ink.role") || "manager", name: localStorage.getItem("ink.name") || "" },
  meta: null,
  items: [],
  batches: [],
  queue: [],
  stats: {},
  today: "",
  filter: { status: "", q: "" },
  itemFilter: { status: "", q: "" },
};

// ---------- 基础 ----------
function toast(msg, isErr) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = isErr ? "err" : "";
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3200);
}

async function api(path, { method = "GET", body } = {}) {
  const opts = { method, headers: { "x-role": state.me.role, "x-name": encodeURIComponent(state.me.name) } };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : "rid-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

// 每个表单一个幂等键，提交成功后才更换，失败重试不会产生重复记录
function ridOf(el) {
  if (!el.dataset.rid) el.dataset.rid = uuid();
  return el.dataset.rid;
}
function ridReset(el) {
  delete el.dataset.rid;
}

async function run(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- 数据加载 ----------
async function loadBatches() {
  const data = await api(`/api/batches?role=${encodeURIComponent(state.me.role)}&name=${encodeURIComponent(state.me.name)}`);
  state.batches = data.batches;
  state.queue = data.queue;
  state.stats = data.stats;
  state.today = data.today;
}
async function loadItems() {
  state.items = await api("/api/items");
}
async function loadAll() {
  await Promise.all([loadBatches(), loadItems()]);
  renderBench();
  renderLedger();
}

// ---------- 复测复核台 ----------
function renderBench() {
  renderStats();
  renderQueue();
  renderCreatePanel();
  renderBatchCards();
}

function renderStats() {
  const order = ["待排程", "试磨中", "待复核", "已结案"];
  $("#batchStats").innerHTML =
    order.map((k) => `<div class="stat"><span>${k}</span><strong>${state.stats[k] ?? 0}</strong></div>`).join("") +
    `<div class="stat warn"><span>逾期批次</span><strong>${state.stats["逾期"] ?? 0}</strong></div>`;
}

function renderQueue() {
  const byId = Object.fromEntries(state.batches.map((b) => [b.id, b]));
  const waiting = state.queue.map((id, i) => ({ b: byId[id], i })).filter((x) => x.b);
  const doing = state.batches.filter((b) => b.status === "试磨中" || b.status === "待复核");
  const row = (b, no, cls) => `
    <div class="queue-row ${cls}">
      <span class="no">${no}</span>
      <div class="grow">
        <b>${esc(b.title)}</b> <span class="meta">${esc(b.id)}</span><br>
        <span class="pill prio-${b.priority}">优先级 ${esc(b.priority)}</span>
        <span class="meta">截止 ${esc(b.deadline)}</span>
        ${b.overdue ? '<span class="pill overdue">已逾期</span>' : ""}
      </div>
      <span class="pill st-${STAGE_KEY[b.status]}">${b.status}</span>
    </div>`;
  $("#queueList").innerHTML =
    (waiting.length
      ? waiting.map(({ b, i }) => row(b, "第" + (i + 1) + "位", "")).join("")
      : '<div class="queue-empty">暂无待排程批次</div>') +
    (doing.length
      ? '<h2 style="margin-top:14px">进行中</h2>' + doing.map((b) => row(b, b.status === "试磨中" ? "磨" : "审", b.status === "试磨中" ? "doing" : "reviewing")).join("")
      : "");
}

function occupiedSticks() {
  const map = {};
  for (const b of state.batches) {
    if (b.status === "已结案") continue;
    for (const code of b.itemCodes) map[code] = b.title;
  }
  return map;
}

function renderCreatePanel() {
  const panel = $("#createPanel");
  if (state.me.role !== "manager") {
    panel.innerHTML = `<h2>新建复测批次</h2><div class="hint">当前身份是「${esc(roleLabel())}」。只有负责人可以创建复测批次、安排开磨。</div>`;
    return;
  }
  const occ = occupiedSticks();
  const sticks = state.items
    .map((it) => {
      const code = it.code || it.id;
      const taken = occ[code];
      return `<label class="${taken ? "disabled" : ""}">
        <input type="checkbox" name="stick" value="${esc(code)}" ${taken ? "disabled" : ""}>
        ${esc(code)} · ${esc(it.smokeSource || "")}
        ${taken ? `<span class="taken">已在「${esc(taken)}」</span>` : ""}
      </label>`;
    })
    .join("");
  const tests = state.meta.testItems
    .map((t) => `<label><input type="checkbox" name="test" value="${esc(t)}" checked> ${esc(t)}</label>`)
    .join("");
  panel.innerHTML = `
    <h2>新建复测批次</h2>
    <form id="batchForm">
      <label>批次名称</label>
      <input name="title" required placeholder="如：九月松烟复测">
      <label>优先级</label>
      <select name="priority">${state.meta.priorities.map((p) => `<option>${p}</option>`).join("")}</select>
      <label>截止时间</label>
      <input name="deadline" type="date" required>
      <label>检测项</label>
      <div class="check-grid">${tests}</div>
      <label>选择墨锭（未结案批次中的墨锭不可重复占用）</label>
      <div class="check-grid">${sticks || '<span class="meta">暂无墨锭，请先在台账建档</span>'}</div>
      <div style="margin-top:12px"><button type="submit">创建批次并排程</button></div>
    </form>`;
  $("#batchForm").onsubmit = onCreateBatch;
}

async function onCreateBatch(event) {
  event.preventDefault();
  const form = event.target;
  const fd = new FormData(form);
  const body = {
    title: fd.get("title"),
    priority: fd.get("priority"),
    deadline: fd.get("deadline"),
    testItems: fd.getAll("test"),
    itemCodes: fd.getAll("stick"),
    requestId: ridOf(form),
  };
  await run(form.querySelector("button"), async () => {
    await api("/api/batches", { method: "POST", body });
    ridReset(form);
    toast("批次已创建，系统已按优先级与截止时间排入队列");
    await loadBatches();
    renderBench();
  });
}

function renderBatchCards() {
  const { status, q } = state.filter;
  const visible = state.batches.filter(
    (b) => (!status || b.status === status) && (!q || JSON.stringify(b).includes(q))
  );
  $("#batchCards").innerHTML = visible.length
    ? visible.map(batchCard).join("")
    : '<div class="panel meta">没有符合条件的批次</div>';
  bindBatchActions();
}

function batchCard(b) {
  const sticks = b.stickStatus
    .map((s) => `<span class="stick ${s.submitted ? "done" : ""}">${esc(s.code)}${s.submitted ? " · 已交" : " · 待交"}</span>`)
    .join("");
  const recs = [...b.records].reverse().map(recordHtml).join("");
  const reviews = [...b.reviews].reverse().map(reviewHtml).join("");
  const history = [...b.history].reverse().map((h) => `<div>${esc(h.at.slice(0, 16).replace("T", " "))} · ${esc(h.from || "—")} → ${esc(h.to)} · ${esc(h.by)}${h.note ? " · " + esc(h.note) : ""}</div>`).join("");
  return `
  <article class="card">
    <div class="card-head">
      <h3>${esc(b.title)}</h3>
      <span class="pill st-${STAGE_KEY[b.status]}">${b.status}</span>
    </div>
    <div class="meta">
      ${esc(b.id)} · 第 ${b.round} 轮 · 优先级 <b>${esc(b.priority)}</b> · 截止 ${esc(b.deadline)}
      ${b.overdue ? '<span class="pill overdue">已逾期</span>' : ""}
      ${b.queueOrder ? ` · 队列第 ${b.queueOrder} 位` : ""}
    </div>
    <div class="meta">检测项：${b.testItems.map(esc).join("、")}</div>
    <div>${sticks}</div>
    ${actionsHtml(b)}
    ${recs ? `<div><div class="meta">检测记录（${b.records.length}）</div>${recs}</div>` : ""}
    ${reviews ? `<div><div class="meta">复核结论</div>${reviews}</div>` : ""}
    <details><summary class="meta">流转记录</summary><div class="logs meta">${history}</div></details>
  </article>`;
}

function recordHtml(r) {
  if (r.hidden) {
    return `<div class="rec blind">${esc(r.itemCode)} · ${esc(r.tester)} 已提交（第${r.round}轮）—— 盲测中，评分与结论在你提交前不可见</div>`;
  }
  const results = Object.entries(r.results || {}).map(([k, v]) => `${esc(k)}：${esc(v)}`).join("；");
  return `<div class="rec">
    <b>${esc(r.itemCode)}</b> · ${esc(r.tester)} · 评分 <b>${esc(r.score)}</b>
    <div class="meta">${results}</div>
    ${r.note ? `<div class="meta">备注：${esc(r.note)}</div>` : ""}
    <div class="meta">第${r.round}轮 · ${esc(r.at.slice(0, 16).replace("T", " "))}</div>
  </div>`;
}

function reviewHtml(rv) {
  if (rv.hidden) {
    return `<div class="review-line">第${rv.round}轮 · ${esc(rv.reviewer)} 已复核 —— 结论盲测中不可见</div>`;
  }
  return `<div class="review-line ${rv.verdict === "通过" ? "pass" : ""}">
    第${rv.round}轮 · ${esc(rv.reviewer)}：<b>${esc(rv.verdict)}</b>${rv.comment ? " · " + esc(rv.comment) : ""}
    <div class="meta">${esc(rv.at.slice(0, 16).replace("T", " "))}</div>
  </div>`;
}

function actionsHtml(b) {
  const me = state.me;
  const parts = [];
  if (me.role === "manager" && b.status === "待排程") {
    parts.push(`<div class="actions"><button data-start="${esc(b.id)}">开始试磨</button></div>`);
  }
  if (me.role === "tester" && b.status === "试磨中") {
    const pending = b.stickStatus.filter((s) => !s.submitted);
    if (pending.length) {
      const inputs = b.testItems.map((t) => `<label>${esc(t)}</label><input name="t:${esc(t)}" required placeholder="检测结果">`).join("");
      parts.push(`
      <details open>
        <summary>提交检测结果（盲测）</summary>
        <form data-record-form="${esc(b.id)}">
          <label>墨锭</label>
          <select name="itemCode">${pending.map((s) => `<option>${esc(s.code)}</option>`).join("")}</select>
          ${inputs}
          <label>评分（0-100）</label>
          <input name="score" type="number" min="0" max="100" required>
          <label>备注</label>
          <input name="note" placeholder="选填">
          <div style="margin-top:10px"><button type="submit">提交本轮结果</button></div>
        </form>
      </details>`);
    } else {
      parts.push('<div class="hint">本轮检测已齐，等待复核。</div>');
    }
  }
  if (me.role === "reviewer" && b.status === "待复核") {
    const testers = [...new Set(b.records.filter((r) => r.round === b.round).map((r) => r.tester))];
    if (testers.includes(me.name)) {
      parts.push('<div class="hint">你是本轮记录的提交人，不能复核自己的记录，请由其他复核人处理。</div>');
    } else {
      parts.push(`
      <details open>
        <summary>复核本批次</summary>
        <form data-review-form="${esc(b.id)}">
          <label>复核意见（驳回必填）</label>
          <input name="comment" placeholder="复核意见">
          <div class="actions" style="margin-top:10px">
            <button type="submit" name="verdict" value="通过">通过并结案</button>
            <button type="submit" name="verdict" value="驳回" class="danger">驳回，安排补充复测</button>
          </div>
        </form>
      </details>`);
    }
  }
  return parts.join("");
}

function bindBatchActions() {
  document.querySelectorAll("[data-start]").forEach((btn) => {
    btn.onclick = () =>
      run(btn, async () => {
        await api(`/api/batches/${btn.dataset.start}/start`, { method: "POST", body: { requestId: uuid() } });
        toast("已开始试磨");
        await loadBatches();
        renderBench();
      });
  });
  document.querySelectorAll("[data-record-form]").forEach((form) => {
    form.onsubmit = (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      const results = {};
      for (const [k, v] of fd.entries()) if (k.startsWith("t:")) results[k.slice(2)] = v;
      const body = {
        itemCode: fd.get("itemCode"),
        results,
        score: fd.get("score"),
        note: fd.get("note"),
        requestId: ridOf(form),
      };
      run(form.querySelector("button"), async () => {
        await api(`/api/batches/${form.dataset.recordForm}/records`, { method: "POST", body });
        ridReset(form);
        toast("检测结果已提交");
        await loadBatches();
        renderBench();
      });
    };
  });
  document.querySelectorAll("[data-review-form]").forEach((form) => {
    form.onsubmit = (event) => {
      event.preventDefault();
      const verdict = event.submitter?.value || "通过";
      const body = { verdict, comment: new FormData(form).get("comment"), requestId: ridOf(form) };
      run(event.submitter, async () => {
        await api(`/api/batches/${form.dataset.reviewForm}/review`, { method: "POST", body });
        ridReset(form);
        toast(verdict === "通过" ? "已通过并结案" : "已驳回，批次退回补充复测");
        await loadBatches();
        renderBench();
      });
    };
  });
}

// ---------- 墨锭台账（原有功能） ----------
function renderLedger() {
  const meta = state.meta;
  $("#fields").innerHTML = meta.fields
    .map(([key, label, type]) => `<label>${label}</label><input name="${key}" type="${type}" ${key === "code" ? "required" : ""}>`)
    .join("");
  $("#itemStatus").innerHTML = meta.stages.map((s) => `<option>${s}</option>`).join("");
  $("#extraFields").innerHTML = meta.extraFields.map(([key, label]) => `<label>${label}</label><input name="${key}">`).join("");
  $("#statusFilter").innerHTML = '<option value="">全部状态</option>' + meta.stages.map((s) => `<option>${s}</option>`).join("");
  renderItems();
}

function renderItems() {
  const items = state.items;
  $("#itemSelect").innerHTML = items
    .map((it) => `<option value="${esc(it.id || it.code)}">${esc(it.code || it.id)} · ${esc(it.smokeSource || "")}</option>`)
    .join("");
  const stats = Object.fromEntries(state.meta.stages.map((s) => [s, items.filter((i) => i.status === s).length]));
  $("#itemStats").innerHTML = Object.entries(stats)
    .map(([k, v]) => `<div class="stat"><span>${k}</span><strong>${v}</strong></div>`)
    .join("");
  const { status, q } = state.itemFilter;
  const visible = items.filter((it) => (!status || it.status === status) && (!q || JSON.stringify(it).includes(q)));
  $("#cards").innerHTML = visible.map(itemCard).join("") || '<div class="panel meta">暂无墨锭</div>';
  document.querySelectorAll("[data-item-status]").forEach((sel) => {
    sel.onchange = () =>
      run(null, async () => {
        await api("/api/items/" + sel.dataset.itemStatus, { method: "PATCH", body: { status: sel.value } });
        await loadItems();
        renderItems();
      });
  });
  document.querySelectorAll("[data-item-note]").forEach((btn) => {
    btn.onclick = () => {
      const note = prompt("记录备注");
      if (!note) return;
      run(btn, async () => {
        await api(`/api/items/${btn.dataset.itemNote}/logs`, { method: "POST", body: { step: "备注", note } });
        await loadItems();
        renderItems();
      });
    };
  });
}

function itemCard(item) {
  const main = state.meta.fields
    .slice(0, 4)
    .map(([key, label]) => `<div><b>${label}</b> ${esc(item[key] ?? "")}</div>`)
    .join("");
  const logs = (item.logs || []).slice(-4).map((l) => `<div>${esc(l.step)}：${esc(l.note)}</div>`).join("");
  const id = item.id || item.code;
  return `<article class="card">
    <div class="card-head"><h3>${esc(item.code || item.id)}</h3><span class="pill">${esc(item.status)}</span></div>
    ${main}
    <label>状态</label>
    <select data-item-status="${esc(id)}">${state.meta.stages.map((s) => `<option ${s === item.status ? "selected" : ""}>${s}</option>`).join("")}</select>
    <button class="secondary" data-item-note="${esc(id)}" type="button">追加备注</button>
    <div class="logs meta">${logs || "暂无记录"}</div>
  </article>`;
}

// ---------- 身份 / 页签 / 初始化 ----------
function roleLabel() {
  return state.meta ? state.meta.roles[state.me.role] : state.me.role;
}

function bindGlobal() {
  $("#roleSelect").value = state.me.role;
  $("#nameInput").value = state.me.name;
  $("#roleSelect").onchange = (e) => {
    state.me.role = e.target.value;
    localStorage.setItem("ink.role", state.me.role);
    loadBatches().then(renderBench);
  };
  $("#nameInput").onchange = (e) => {
    state.me.name = e.target.value.trim();
    localStorage.setItem("ink.name", state.me.name);
    loadBatches().then(renderBench);
  };
  $("#reload").onclick = () => loadAll();
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
      $("#tab-bench").hidden = btn.dataset.tab !== "bench";
      $("#tab-ledger").hidden = btn.dataset.tab !== "ledger";
    };
  });
  $("#batchStatusFilter").innerHTML =
    '<option value="">全部状态</option>' + state.meta.batchStages.map((s) => `<option>${s}</option>`).join("");
  $("#batchStatusFilter").onchange = (e) => {
    state.filter.status = e.target.value;
    renderBatchCards();
  };
  $("#batchSearch").oninput = (e) => {
    state.filter.q = e.target.value.trim();
    renderBatchCards();
  };
  $("#statusFilter").onchange = (e) => {
    state.itemFilter.status = e.target.value;
    renderItems();
  };
  $("#search").oninput = (e) => {
    state.itemFilter.q = e.target.value.trim();
    renderItems();
  };
  $("#createForm").onsubmit = (event) => {
    event.preventDefault();
    const form = event.target;
    run(form.querySelector("button"), async () => {
      await api("/api/items", { method: "POST", body: Object.fromEntries(new FormData(form).entries()) });
      form.reset();
      toast("墨锭已建档");
      await loadItems();
      renderItems();
      renderCreatePanel();
    });
  };
  $("#actionForm").onsubmit = (event) => {
    event.preventDefault();
    const form = event.target;
    run(form.querySelector("button"), async () => {
      await api("/api/items/" + $("#itemSelect").value + "/action", { method: "POST", body: Object.fromEntries(new FormData(form).entries()) });
      form.reset();
      toast("试磨记录已提交");
      await loadItems();
      renderItems();
    });
  };
}

async function init() {
  state.meta = await api("/api/meta");
  const names = new Set(["王负责", "小张", "小李", "老复核"]);
  $("#nameList").innerHTML = [...names].map((n) => `<option value="${n}">`).join("");
  bindGlobal();
  await loadAll();
}

init().catch((e) => toast(e.message, true));
