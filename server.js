import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data", "ink-stick-testing.json");
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 3037);

// ---------- 领域常量 ----------
const TEST_ITEMS = ["出墨速度", "墨色层次", "沉淀情况", "胶性稳定", "香气", "磨口光洁"];
const PRIORITIES = ["高", "中", "低"];
const PRIORITY_WEIGHT = { 高: 3, 中: 2, 低: 1 };
const BATCH_STAGES = ["待排程", "试磨中", "待复核", "已结案"];
const ROLES = { manager: "负责人", tester: "检测人", reviewer: "复核人" };

const fields = [["code", "墨锭编号", "text"], ["smokeSource", "烟料来源", "text"], ["glueRatio", "胶料比例", "text"], ["ageYears", "存放年限", "number"], ["storage", "存放位置", "text"]];
const stages = ["待试磨", "已试磨", "重点观察"];
const extraFields = [["paper", "试磨纸张"], ["water", "加水量"], ["speed", "出墨速度"], ["colorLayer", "墨色层次"], ["sediment", "沉淀情况"], ["score", "评分"]];

const seed = {
  items: [
    {
      code: "IS-001",
      smokeSource: "黄山松烟",
      glueRatio: "7.5%",
      ageYears: 8,
      storage: "恒湿柜B",
      status: "已试磨",
      logs: [{ at: "2026-06-11", step: "试磨", note: "宣纸20滴水，出墨快，评分86", score: 86 }]
    },
    { code: "IS-002", smokeSource: "桐油烟", glueRatio: "8%", ageYears: 3, storage: "试样盒C", status: "待试磨", logs: [] }
  ],
  batches: [],
  idempotency: {}
};

// ---------- 基础设施 ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.items ||= [];
  db.batches ||= [];
  db.idempotency ||= {};
  return db;
}

// 原子落盘：先写临时文件再改名，重启/断电不会留下半截文件
async function saveDb(db) {
  const tmp = dbPath + ".tmp";
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}

// 所有写操作串行执行：读库→改→原子落盘，构成“检查再写”天然互斥，并发占用只能成功一次
let writeChain = Promise.resolve();
function mutate(fn) {
  const task = writeChain.then(async () => {
    const db = await loadDb();
    const out = await fn(db);
    await saveDb(db);
    return out;
  });
  writeChain = task.catch(() => {});
  return task;
}

// 幂等键：同一 requestId 只真正执行一次，重试/双击/断线重发返回首次结果
function idempotent(db, requestId, produce) {
  if (requestId && db.idempotency[requestId]) return db.idempotency[requestId];
  const result = produce();
  if (requestId && result.status < 300) {
    db.idempotency[requestId] = result;
    const keys = Object.keys(db.idempotency);
    if (keys.length > 500) delete db.idempotency[keys[0]];
  }
  return result;
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求体不是有效 JSON");
  }
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function identity(req) {
  let name = String(req.headers["x-name"] || "");
  try {
    name = decodeURIComponent(name);
  } catch {}
  return { role: req.headers["x-role"] || "", name: name.trim() };
}
function requireRole(me, role) {
  if (me.role !== role) throw new HttpError(403, `此操作需要以「${ROLES[role]}」身份进行`);
  if (!me.name) throw new HttpError(400, `请先在页面右上角填写${ROLES[role]}姓名`);
}
function whoami(me) {
  return `${ROLES[me.role] || "访客"}·${me.name || "匿名"}`;
}

// ---------- 批次领域逻辑 ----------
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function isOverdue(batch) {
  return batch.status !== "已结案" && batch.deadline < todayStr();
}
// 未结案（待排程/试磨中/待复核）批次视为占用中，同一墨锭不能同时落入两个这样的批次
function stickOccupation(db, exceptId) {
  const map = new Map();
  for (const b of db.batches) {
    if (b.status === "已结案" || b.id === exceptId) continue;
    for (const code of b.itemCodes) if (!map.has(code)) map.set(code, b);
  }
  return map;
}
function assertSticksFree(db, codes, exceptId) {
  const occ = stickOccupation(db, exceptId);
  for (const code of codes) {
    const holder = occ.get(code);
    if (holder) throw new HttpError(409, `墨锭 ${code} 已在未结案批次「${holder.title}」(${holder.status})中，不能重复占用`);
  }
}
// 排程：优先级高者优先，同级按截止早者优先，再按创建先后
function sortQueue(batches) {
  return batches
    .filter(b => b.status === "待排程")
    .slice()
    .sort((a, b) =>
      (PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]) ||
      a.deadline.localeCompare(b.deadline) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
    );
}
function batchStats(batches) {
  const stats = Object.fromEntries(BATCH_STAGES.map(s => [s, 0]));
  let overdue = 0;
  for (const b of batches) {
    if (stats[b.status] !== undefined) stats[b.status] += 1;
    if (isOverdue(b)) overdue += 1;
  }
  return { ...stats, 逾期: overdue };
}
function findBatch(db, id) {
  const batch = db.batches.find(b => b.id === id);
  if (!batch) throw new HttpError(404, "批次不存在");
  return batch;
}
function transition(batch, to, me, note) {
  batch.history.push({ at: new Date().toISOString(), from: batch.status, to, by: whoami(me), note });
  batch.status = to;
}
function roundRecords(batch) {
  return batch.records.filter(r => r.round === batch.round);
}
// 盲测视图：检测人在自己提交本轮结果之前，看不到任何评分与复核结论
function viewBatch(batch, role, name, queueOrder) {
  const b = JSON.parse(JSON.stringify(batch));
  b.overdue = isOverdue(batch);
  b.queueOrder = queueOrder;
  const recs = roundRecords(batch);
  b.stickStatus = batch.itemCodes.map(code => {
    const rec = recs.find(r => r.itemCode === code);
    return { code, submitted: Boolean(rec), tester: rec ? rec.tester : null };
  });
  const submittedThisRound = role === "tester" && recs.some(r => r.tester === name);
  const blind = role === "tester" && !submittedThisRound && batch.status !== "已结案";
  if (blind) {
    b.records = b.records.map(r => ({ id: r.id, round: r.round, itemCode: r.itemCode, tester: r.tester, at: r.at, hidden: true }));
    b.reviews = b.reviews.map(rv => ({ round: rv.round, reviewer: rv.reviewer, at: rv.at, hidden: true }));
  }
  return b;
}
function batchesPayload(db, role, name) {
  const queue = sortQueue(db.batches);
  const orderMap = new Map(queue.map((b, i) => [b.id, i + 1]));
  return {
    today: todayStr(),
    stats: batchStats(db.batches),
    queue: queue.map(b => b.id),
    batches: db.batches.map(b => viewBatch(b, role, name, orderMap.get(b.id) || null))
  };
}

// ---------- 墨锭台账（原有功能） ----------
function computeStats(items) {
  const stats = Object.fromEntries(stages.map(label => [label, 0]));
  for (const item of items) if (stats[item.status] !== undefined) stats[item.status] += 1;
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}
function newItemId() {
  return "IS-" + Date.now();
}
let batchSeq = 0;
function newBatchId(db) {
  batchSeq += 1;
  return `B${String(db.batches.length + 1).padStart(3, "0")}-${Date.now().toString(36).toUpperCase()}${batchSeq}`;
}

// ---------- 静态页面 ----------
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
async function serveStatic(res, rel) {
  const file = normalize(join(publicDir, rel));
  if (!file.startsWith(publicDir) || !existsSync(file)) return send(res, 404, { error: "not_found" });
  const data = await readFile(file);
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
  res.end(data);
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") return serveStatic(res, "index.html");
    if (req.method === "GET" && path.startsWith("/static/")) return serveStatic(res, path.slice("/static/".length));

    if (req.method === "GET" && path === "/api/meta") {
      return send(res, 200, { testItems: TEST_ITEMS, priorities: PRIORITIES, batchStages: BATCH_STAGES, roles: ROLES, fields, stages, extraFields });
    }

    // ===== 复测批次 =====
    if (req.method === "GET" && path === "/api/batches") {
      const db = await loadDb();
      const me = identity(req);
      const role = me.role || url.searchParams.get("role") || "";
      const name = me.name || url.searchParams.get("name") || "";
      return send(res, 200, batchesPayload(db, role, name));
    }

    if (req.method === "POST" && path === "/api/batches") {
      const me = identity(req);
      requireRole(me, "manager");
      const input = await body(req);
      const out = await mutate(db => idempotent(db, input.requestId, () => {
        const title = String(input.title || "").trim();
        if (!title) throw new HttpError(400, "请填写批次名称");
        const codes = [...new Set(Array.isArray(input.itemCodes) ? input.itemCodes.map(String) : [])];
        if (!codes.length) throw new HttpError(400, "请至少选择一锭墨");
        for (const code of codes) {
          if (!db.items.some(it => it.code === code || it.id === code)) throw new HttpError(404, `墨锭 ${code} 不存在`);
        }
        const priority = PRIORITIES.includes(input.priority) ? input.priority : "中";
        const deadline = String(input.deadline || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) throw new HttpError(400, "请选择截止时间");
        const testItems = [...new Set((Array.isArray(input.testItems) ? input.testItems : []).map(s => String(s).trim()).filter(Boolean))];
        if (!testItems.length) throw new HttpError(400, "请至少选择一项检测项");
        assertSticksFree(db, codes, null);
        const batch = {
          id: newBatchId(db),
          title,
          itemCodes: codes,
          priority,
          deadline,
          testItems,
          status: "待排程",
          round: 1,
          records: [],
          reviews: [],
          history: [],
          createdBy: me.name,
          createdAt: new Date().toISOString()
        };
        transition(batch, "待排程", me, "创建复测批次");
        db.batches.unshift(batch);
        return { status: 201, body: viewBatch(batch, me.role, me.name, null) };
      }));
      return send(res, out.status, out.body);
    }

    const mStart = path.match(/^\/api\/batches\/([^/]+)\/start$/);
    if (mStart && req.method === "POST") {
      const me = identity(req);
      requireRole(me, "manager");
      const input = await body(req);
      const out = await mutate(db => idempotent(db, input.requestId, () => {
        const batch = findBatch(db, mStart[1]);
        if (batch.status !== "待排程") throw new HttpError(409, `非法流转：批次当前为「${batch.status}」，不能开始试磨`);
        assertSticksFree(db, batch.itemCodes, batch.id);
        transition(batch, "试磨中", me, "按排程开始试磨");
        return { status: 200, body: viewBatch(batch, me.role, me.name, null) };
      }));
      return send(res, out.status, out.body);
    }

    const mRecord = path.match(/^\/api\/batches\/([^/]+)\/records$/);
    if (mRecord && req.method === "POST") {
      const me = identity(req);
      requireRole(me, "tester");
      const input = await body(req);
      const out = await mutate(db => idempotent(db, input.requestId, () => {
        const batch = findBatch(db, mRecord[1]);
        if (batch.status !== "试磨中") throw new HttpError(409, `非法提交：批次当前为「${batch.status}」，不能提交检测结果`);
        const itemCode = String(input.itemCode || "");
        if (!batch.itemCodes.includes(itemCode)) throw new HttpError(404, `墨锭 ${itemCode} 不在本批次中`);
        if (roundRecords(batch).some(r => r.itemCode === itemCode)) {
          throw new HttpError(409, `墨锭 ${itemCode} 本轮已有检测记录，重复提交无效`);
        }
        const results = {};
        for (const item of batch.testItems) {
          const v = String(input.results?.[item] ?? "").trim();
          if (!v) throw new HttpError(400, `缺少检测项「${item}」的结果`);
          results[item] = v;
        }
        const score = Number(input.score);
        if (!Number.isFinite(score) || score < 0 || score > 100) throw new HttpError(400, "评分需为 0-100 的数字");
        const record = {
          id: "R" + Date.now().toString(36).toUpperCase(),
          round: batch.round,
          itemCode,
          tester: me.name,
          results,
          score,
          note: String(input.note || "").trim(),
          at: new Date().toISOString()
        };
        batch.records.push(record);
        if (batch.itemCodes.every(code => roundRecords(batch).some(r => r.itemCode === code))) {
          transition(batch, "待复核", me, `第 ${batch.round} 轮检测齐全，送复核`);
        }
        return { status: 201, body: viewBatch(batch, me.role, me.name, null) };
      }));
      return send(res, out.status, out.body);
    }

    const mReview = path.match(/^\/api\/batches\/([^/]+)\/review$/);
    if (mReview && req.method === "POST") {
      const me = identity(req);
      requireRole(me, "reviewer");
      const input = await body(req);
      const out = await mutate(db => idempotent(db, input.requestId, () => {
        const batch = findBatch(db, mReview[1]);
        if (batch.status !== "待复核") throw new HttpError(409, `非法复核：批次当前为「${batch.status}」，不在待复核状态`);
        const testers = new Set(roundRecords(batch).map(r => r.tester));
        if (testers.has(me.name)) throw new HttpError(403, "提交人不能复核自己的记录，请换其他复核人");
        const verdict = String(input.verdict || "");
        const comment = String(input.comment || "").trim();
        if (!["通过", "驳回"].includes(verdict)) throw new HttpError(400, "复核结论只能是「通过」或「驳回」");
        if (verdict === "驳回" && !comment) throw new HttpError(400, "驳回必须填写复核意见");
        batch.reviews.push({ round: batch.round, reviewer: me.name, verdict, comment, at: new Date().toISOString() });
        if (verdict === "通过") {
          transition(batch, "已结案", me, "复核通过，结案");
        } else {
          batch.round += 1;
          transition(batch, "试磨中", me, `复核驳回：${comment}；安排第 ${batch.round} 轮补充复测`);
        }
        return { status: 200, body: viewBatch(batch, me.role, me.name, null) };
      }));
      return send(res, out.status, out.body);
    }

    // ===== 墨锭台账（原有接口保留） =====
    if (req.method === "GET" && path === "/api/items") {
      const db = await loadDb();
      return send(res, 200, db.items.map(summarize));
    }
    if (req.method === "POST" && path === "/api/items") {
      const input = await body(req);
      const out = await mutate(db => {
        const item = { id: newItemId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建墨锭" }] };
        db.items.unshift(item);
        return { status: 201, body: item };
      });
      return send(res, out.status, out.body);
    }
    const mPatch = path.match(/^\/api\/items\/([^/]+)$/);
    if (mPatch && req.method === "PATCH") {
      const input = await body(req);
      const out = await mutate(db => {
        const item = db.items.find(x => x.id === mPatch[1] || x.code === mPatch[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        Object.assign(item, input);
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
        return { status: 200, body: item };
      });
      return send(res, out.status, out.body);
    }
    const mLog = path.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (mLog && req.method === "POST") {
      const input = await body(req);
      const out = await mutate(db => {
        const item = db.items.find(x => x.id === mLog[1] || x.code === mLog[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
        return { status: 201, body: item };
      });
      return send(res, out.status, out.body);
    }
    const mAction = path.match(/^\/api\/items\/([^/]+)\/action$/);
    if (mAction && req.method === "POST") {
      const input = await body(req);
      const out = await mutate(db => {
        const item = db.items.find(x => x.id === mAction[1] || x.code === mAction[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        item.logs ||= [];
        const score = Number(input.score || 0);
        item.tests ||= [];
        item.tests.push({ at: new Date().toISOString(), ...input, score });
        item.status = score >= 85 ? "已试磨" : "重点观察";
        item.logs.push({ at: new Date().toISOString(), step: "试磨", note: (input.paper || "试纸") + "，评分" + score, score });
        return { status: 201, body: item };
      });
      return send(res, out.status, out.body);
    }
    if (req.method === "GET" && path === "/api/stats") {
      const db = await loadDb();
      return send(res, 200, { items: computeStats(db.items), batches: batchStats(db.batches) });
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    send(res, status, { error: error.message });
  }
});

server.listen(port, () => console.log("墨锭试磨室 · 复测排程与盲测复核台 listening on http://localhost:" + port));
