// 主流程验证：复测排程与盲测复核台
// 运行：node verify.mjs   （会自行启动/重启服务进程，使用独立测试数据文件）
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

const PORT = 3107;
const DB = `/tmp/ink-verify-${process.pid}.json`;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

async function req(method, path, { role = "", name = "", body } = {}) {
  const headers = { "x-role": role, "x-name": encodeURIComponent(name) };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const asManager = (p, b) => req(p.method, p.path, { role: "manager", name: "王负责", body: b });
const uid = () => crypto.randomUUID();

let serverProc;
async function startServer() {
  serverProc = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + "/api/meta");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error("服务启动超时");
}
async function stopServer() {
  if (!serverProc) return;
  serverProc.kill("SIGTERM");
  await new Promise((r) => serverProc.once("exit", r));
  serverProc = null;
}

async function main() {
  await rm(DB, { force: true });
  await startServer();

  console.log("\n[1] 页面与基础数据");
  const home = await fetch(BASE + "/");
  check("首页可访问且包含复核台", home.status === 200 && (await home.text()).includes("复测"));
  for (const code of ["IS-003", "IS-004", "IS-005", "IS-006"]) {
    await req("POST", "/api/items", { body: { code, smokeSource: "测试烟料", status: "待试磨" } });
  }

  console.log("\n[2] 负责人批量建批次，系统按优先级+截止排程");
  const mk = (title, itemCodes, priority, deadline, requestId = uid()) =>
    asManager({ method: "POST", path: "/api/batches" }, { title, itemCodes, priority, deadline, testItems: ["出墨速度", "墨色层次"], requestId });
  const bA = await mk("批次A-松烟复测", ["IS-001", "IS-002"], "高", "2026-09-20");
  check("创建批次A（高优先级）", bA.status === 201 && bA.data.status === "待排程", JSON.stringify(bA.data));
  const bB = await mk("批次B-油烟复测", ["IS-003"], "低", "2026-09-25");
  const bC = await mk("批次C-胶料复测", ["IS-004"], "中", "2026-09-18");
  check("创建批次B/C", bB.status === 201 && bC.status === 201);
  let view = await req("GET", "/api/batches", { role: "manager", name: "王负责" });
  const titles = view.data.queue.map((id) => view.data.batches.find((b) => b.id === id).title);
  check("排程顺序为 A(高) > C(中) > B(低)", JSON.stringify(titles) === JSON.stringify(["批次A-松烟复测", "批次C-胶料复测", "批次B-油烟复测"]), titles.join(","));
  const orderA = view.data.batches.find((b) => b.id === bA.data.id).queueOrder;
  check("批次A队列第1位", orderA === 1);

  console.log("\n[3] 同一墨锭不能落入两个未结案批次（含并发占用）");
  const dup = await mk("批次D-重复占用", ["IS-001"], "中", "2026-09-22");
  check("串行重复占用被拒绝(409)", dup.status === 409 && dup.data.error.includes("IS-001"), JSON.stringify(dup.data));
  const race = await Promise.all(Array.from({ length: 6 }, (_, i) => mk(`并发批次${i}`, ["IS-005"], "中", "2026-09-22")));
  const wins = race.filter((r) => r.status === 201);
  check("6个并发建批仅1个成功占用IS-005", wins.length === 1 && race.every((r) => r.status === 201 || r.status === 409), race.map((r) => r.status).join(","));

  console.log("\n[4] 非法流转与越权");
  const rec0 = await req("POST", `/api/batches/${bA.data.id}/records`, { role: "tester", name: "小张", body: { itemCode: "IS-001", results: { 出墨速度: "快", 墨色层次: "好" }, score: 90, requestId: uid() } });
  check("待排程批次不能提交结果(409)", rec0.status === 409);
  const rev0 = await req("POST", `/api/batches/${bA.data.id}/review`, { role: "reviewer", name: "老复核", body: { verdict: "通过", requestId: uid() } });
  check("待排程批次不能复核(409)", rev0.status === 409);
  const wrongRole = await req("POST", `/api/batches/${bA.data.id}/start`, { role: "tester", name: "小张", body: { requestId: uid() } });
  check("检测人不能执行开磨(403)", wrongRole.status === 403);

  console.log("\n[5] 开磨 → 盲测 → 提交 → 自动送复核");
  const start = await asManager({ method: "POST", path: `/api/batches/${bA.data.id}/start` }, { requestId: uid() });
  check("批次A开始试磨", start.status === 200 && start.data.status === "试磨中");
  const startAgain = await asManager({ method: "POST", path: `/api/batches/${bA.data.id}/start` }, { requestId: uid() });
  check("重复开磨被拒绝(409)", startAgain.status === 409);

  const r1 = await req("POST", `/api/batches/${bA.data.id}/records`, { role: "tester", name: "小张", body: { itemCode: "IS-001", results: { 出墨速度: "快", 墨色层次: "三层" }, score: 88, note: "宣纸", requestId: uid() } });
  check("小张提交IS-001", r1.status === 201 && r1.data.status === "试磨中");

  const blindView = await req("GET", "/api/batches", { role: "tester", name: "小李" });
  const blindBatch = blindView.data.batches.find((b) => b.id === bA.data.id);
  check("未提交的检测人看不到评分与复核结论", blindBatch.records[0].hidden === true && blindBatch.records[0].score === undefined);
  const selfView = await req("GET", "/api/batches", { role: "tester", name: "小张" });
  const selfBatch = selfView.data.batches.find((b) => b.id === bA.data.id);
  check("提交后本人可见评分", selfBatch.records[0].score === 88);
  const mgrView = await req("GET", "/api/batches", { role: "manager", name: "王负责" });
  check("负责人全程可见评分", mgrView.data.batches.find((b) => b.id === bA.data.id).records[0].score === 88);

  const missing = await req("POST", `/api/batches/${bA.data.id}/records`, { role: "tester", name: "小李", body: { itemCode: "IS-002", results: { 出墨速度: "中" }, score: 80, requestId: uid() } });
  check("缺检测项被拒绝(400)", missing.status === 400);
  const rid2 = uid();
  const r2 = await req("POST", `/api/batches/${bA.data.id}/records`, { role: "tester", name: "小李", body: { itemCode: "IS-002", results: { 出墨速度: "中", 墨色层次: "两层" }, score: 82, requestId: rid2 } });
  check("小李提交IS-002后自动转待复核", r2.status === 201 && r2.data.status === "待复核");

  console.log("\n[6] 重复提交只能成功一次");
  const dupRec = await req("POST", `/api/batches/${bA.data.id}/records`, { role: "tester", name: "小李", body: { itemCode: "IS-002", results: { 出墨速度: "慢", 墨色层次: "一层" }, score: 60, requestId: uid() } });
  check("同轮重复提交被拒(409)", dupRec.status === 409);
  const retry = await req("POST", `/api/batches/${bA.data.id}/records`, { role: "tester", name: "小李", body: { itemCode: "IS-002", results: { 出墨速度: "中", 墨色层次: "两层" }, score: 82, requestId: rid2 } });
  check("同幂等键重发返回首次结果且不新增记录", retry.status === 201 && retry.data.records.length === 2);

  console.log("\n[7] 复核：自审禁止 → 驳回补充复测 → 通过结案");
  const selfReview = await req("POST", `/api/batches/${bA.data.id}/review`, { role: "reviewer", name: "小张", body: { verdict: "通过", requestId: uid() } });
  check("提交人不能复核自己的记录(403)", selfReview.status === 403);
  const rejectNoComment = await req("POST", `/api/batches/${bA.data.id}/review`, { role: "reviewer", name: "老复核", body: { verdict: "驳回", requestId: uid() } });
  check("驳回必须填意见(400)", rejectNoComment.status === 400);
  const reject = await req("POST", `/api/batches/${bA.data.id}/review`, { role: "reviewer", name: "老复核", body: { verdict: "驳回", comment: "墨色层次存疑", requestId: uid() } });
  check("驳回后退回试磨中并进入第2轮补充复测", reject.status === 200 && reject.data.status === "试磨中" && reject.data.round === 2);
  const r3 = await req("POST", `/api/batches/${bA.data.id}/records`, { role: "tester", name: "小张", body: { itemCode: "IS-001", results: { 出墨速度: "快", 墨色层次: "四层" }, score: 91, requestId: uid() } });
  const r4 = await req("POST", `/api/batches/${bA.data.id}/records`, { role: "tester", name: "小李", body: { itemCode: "IS-002", results: { 出墨速度: "中", 墨色层次: "三层" }, score: 85, requestId: uid() } });
  check("第2轮提交齐全再送复核", r3.status === 201 && r4.data.status === "待复核");
  const approve = await req("POST", `/api/batches/${bA.data.id}/review`, { role: "reviewer", name: "老复核", body: { verdict: "通过", requestId: uid() } });
  check("复核通过结案", approve.status === 200 && approve.data.status === "已结案");
  const afterClose = await req("GET", "/api/batches", { role: "tester", name: "外人" });
  check("结案后记录与结论公开可见", afterClose.data.batches.find((b) => b.id === bA.data.id).records.every((r) => !r.hidden));

  console.log("\n[8] 统计与逾期");
  await mk("批次E-逾期批", ["IS-006"], "高", "2020-01-01");
  const stats = await req("GET", "/api/batches", { role: "manager", name: "王负责" });
  check("各状态数量正确", stats.data.stats["待排程"] === 4 && stats.data.stats["试磨中"] === 0 && stats.data.stats["待复核"] === 0 && stats.data.stats["已结案"] === 1, JSON.stringify(stats.data.stats));
  check("逾期批次计入统计", stats.data.stats["逾期"] === 1);

  console.log("\n[9] 重启后队列、批次、记录保持一致");
  const before = await req("GET", "/api/batches", { role: "manager", name: "王负责" });
  await stopServer();
  await startServer();
  const after = await req("GET", "/api/batches", { role: "manager", name: "王负责" });
  const pick = (v) => v.data.batches.map((b) => [b.id, b.status, b.round, b.records.length, b.reviews.length]);
  check("重启后批次/记录/复核一致", JSON.stringify(pick(after)) === JSON.stringify(pick(before)));
  check("重启后队列顺序一致", JSON.stringify(after.data.queue) === JSON.stringify(before.data.queue));
  check("重启后统计一致", JSON.stringify(after.data.stats) === JSON.stringify(before.data.stats));

  await stopServer();
  await rm(DB, { force: true });
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("验证执行出错：", e);
  await stopServer();
  process.exit(1);
});
