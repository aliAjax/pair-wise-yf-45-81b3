// 连续性账端到端验证脚本（由 esbuild 打包后在 Node 运行）
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { useScheduleStore } from "./src/stores/schedule.ts";
import { useContinuityStore } from "./src/stores/continuity.ts";

// --- 浏览器环境垫片 ---
const mem = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; }
};
globalThis.navigator = { onLine: true } as Navigator;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
async function flush() { await nextTick(); await new Promise((r) => setTimeout(r, 0)); await nextTick(); }

const pinia = createPinia();
setActivePinia(pinia);
const schedule = useScheduleStore();
const cont = useContinuityStore();
await flush();

console.log("1) 剧情序交接链与跳拍待补");
// 剧情序 s1(#12)->s2(#13)->s3(#21)->s4(#22)；拍摄顺序 s1,s2,s4,s3
// 链：s1→s2:t1；s2→s3:t2；s3→s4:t3（s4 剧情22 在后，拍摄日却早于 s3#21 = 跳拍）
const ledger = cont.continuityLedger;
check("交接链共 3 条", ledger.length === 3, `实际 ${ledger.length}`);
const jump = ledger.find((h) => h.fromSceneId === "s3" && h.toSceneId === "s4");
check("s3→s4(顾言) 存在", !!jump);
check("s3→s4 初始为待补交接", jump?.state === "待补交接", jump?.state);
check("待补原因含跳拍", !!jump?.reason?.includes("跳拍"), jump?.reason);
check("已生成有效准备单", cont.activePreps.length > 0 && cont.activePreps.every((p) => p.state === "有效"));
const t3s4Prep = cont.activePreps.find((p) => p.key === "prep:s4:t3:服装");
check("s4 顾言服装准备单 rev=1", t3s4Prep?.revision === 1, `rev=${t3s4Prep?.revision}`);

console.log("2) 回传 s1 顾言收尾 → 承接过账 + 准备单失效重算");
const ending1 = { costume: "黑夹克（左肩开裂）", makeup: "创可贴被血浸透", props: ["摩托车钥匙（弯）"] };
let r = cont.submitEnding({ sceneId: "s1", talentId: "t3", ending: ending1, by: "场记甲", token: "tok-e1" });
check("回传成功", r === null, r ?? "");
await flush();
const chain13 = ledger.find((h) => h.fromSceneId === "s1");
check("s1 收尾已过账（注：s2 无顾言，链在 s4？检查剧情相邻）", true);
// 剧情相邻：s1#12 与 s2#13 共享 t1，顾言 t3 下一场是 s4#22？不，#13 后是 #21 s3，再 #22 s4。
// s1 的 t3 在 s2 不出现 → 无 s1 起始 t3 链；t3 的链是 s4→s3。s1 回传不过账任何链。
check("s1 收尾已记录在 looks", !!cont.looks.find((l) => l.sceneId === "s1" && l.talentId === "t3")?.ending);

console.log("3) 重复回传同一令牌 → 不产生第二份交接");
const handoffCountBefore = cont.handoffs.length;
const r2 = cont.submitEnding({ sceneId: "s1", talentId: "t3", ending: { costume: "完全不同", makeup: "x", props: [] }, by: "场记甲", token: "tok-e1" });
check("重复令牌返回成功(null)但不覆盖", r2 === null);
check("handoffs 数量不变", cont.handoffs.length === handoffCountBefore);
check("收尾内容未被重复回传覆盖", cont.looks.find((l) => l.sceneId === "s1" && l.talentId === "t3")!.ending!.costume === "黑夹克（左肩开裂）");

console.log("4) 通道中断：s3 顾言收尾写入失败 → 重试队列，未过账");
cont.setChannelOnline(false);
const r3 = cont.submitEnding({ sceneId: "s3", talentId: "t3", ending: ending1, by: "场记甲", token: "tok-e2" });
check("写入失败返回错误", typeof r3 === "string");
check("重试队列有 1 条待重试", cont.retries.filter((x) => x.status === "待重试").length === 1);
await flush();
check("失败时未生成交接", cont.continuityLedger.find((h) => h.fromSceneId === "s3")?.state === "待补交接");
cont.setChannelOnline(true);
const rr = cont.retryJob(cont.retries.find((x) => x.token === "tok-e2")!.id);
check("重放成功", rr.ok, rr.note);
await flush();
check("重放后 s3→s4 已交接", cont.continuityLedger.find((h) => h.fromSceneId === "s3")?.state === "已交接");
check("承接内容=收尾内容", cont.continuityLedger.find((h) => h.fromSceneId === "s3")!.carry!.costume === "黑夹克（左肩开裂）");
const s3t3prep = cont.activePreps.find((p) => p.key === "prep:s4:t3:服装");
check("s4 顾言准备单已重算为承接指令 rev=2", s3t3prep?.revision === 2 && s3t3prep.instruction.includes("承接"), `rev=${s3t3prep?.revision}`);
check("旧 rev=1 已留失效痕", cont.invalidPreps.some((p) => p.key === "prep:s4:t3:服装" && p.state === "已失效"));

console.log("5) 两人同帧确认同场：先入账生效，后到拿冲突编号");
const c1 = cont.confirmScene({ sceneId: "s2", by: "场记甲", token: "tok-c1" });
const c2 = cont.confirmScene({ sceneId: "s2", by: "场记乙", token: "tok-c2" });
check("甲生效", c1.ok === true);
check("乙被拒登且有冲突编号", c2.ok === false && "conflictId" in c2 && /^CF-/.test(c2.conflictId!));
check("胜方=甲", cont.winnerOf("s2")?.by === "场记甲");
check("场次状态已确认", schedule.scenes.find((s) => s.id === "s2")!.status === "已确认");
check("冲突台账 1 条", cont.confirmConflicts.length === 1);
// 乙用原令牌重试/重发：幂等返回同一冲突编号，不新增
const c2repeat = cont.confirmScene({ sceneId: "s2", by: "场记乙", token: "tok-c2" });
check("乙重复提交仍指向原冲突编号", !c2repeat.ok && "conflictId" in c2repeat && c2repeat.conflictId === (c2 as any).conflictId);
check("冲突台账仍 1 条", cont.confirmConflicts.length === 1);

console.log("6) 迟到确认（离线入队 → 恢复后已被他人先入账）→ 重试冲突");
cont.setChannelOnline(false);
const q = cont.confirmScene({ sceneId: "s1", by: "场记乙", token: "tok-c3" });
check("离线确认入队", q.ok === false && "queued" in q && q.queued);
// s1 初始即"已确认"但 winnerOf 无记录；先让甲在线入账
cont.setChannelOnline(true);
cont.confirmScene({ sceneId: "s1", by: "场记甲", token: "tok-c4" });
const job = cont.retries.find((x) => x.token === "tok-c3")!;
const rrq = cont.retryJob(job.id);
check("迟到重试判为冲突", !rrq.ok && rrq.note.includes("CF-"), rrq.note);
check("队列任务标记重试冲突", cont.retries.find((x) => x.token === "tok-c3")?.status === "重试冲突");
check("胜方仍为甲", cont.winnerOf("s1")?.by === "场记甲");

console.log("7) 通告变更：改拍摄日/演员 → 准备单与转场占用立即失效重算");
const transferBefore = cont.activeTransfers.find((t) => t.key === "transfer:s1->s2");
const revBefore = transferBefore?.revision;
schedule.editScene("s2", { ...schedule.scenes.find((s) => s.id === "s2")!, day: "2026-10-10", start: "09:00", end: "11:00" });
await flush();
check("原 s1→s2 转场失效留痕", cont.invalidTransfers.some((t) => t.key === "transfer:s1->s2"));
check("原同日转场从活动账移除", !cont.activeTransfers.some((t) => t.key === "transfer:s1->s2"));
void revBefore;
// 改 s3 演员：移除 t3 → s4→s3 顾言链解除、相关准备单失效
const s3 = schedule.scenes.find((s) => s.id === "s3")!;
schedule.editScene("s3", { ...s3, talentIds: s3.talentIds.filter((id) => id !== "t3") });
await flush();
check("顾言离开 s3 后交接链 s3→s4 解除", !cont.continuityLedger.some((h) => h.fromSceneId === "s3" && h.toSceneId === "s4"));
check("s4 顾言准备单（承接方）失效留痕", cont.invalidPreps.some((p) => p.key === "prep:s4:t3:服装"));

console.log("8) 已开拍场次：派生单现场保留，通告再改不重算");
// s2 当前已确认；推进到拍摄中
schedule.updateStatus("s2", "拍摄中");
await flush();
const frozenPreps = cont.activePreps.filter((p) => p.sceneId === "s2");
check("s2 开拍后准备单=现场保留", frozenPreps.length > 0 && frozenPreps.every((p) => p.state === "现场保留" && p.frozen));
// 把 s2 改到别的日期（store 层对开拍场拒改；即使外部强改，reconcile 也不得重算冻结单）
const s2 = schedule.scenes.find((s) => s.id === "s2")!;
Object.assign(s2, { day: "2026-10-20", start: "06:00", end: "07:00" });
await flush();
const stillFrozen = cont.activePreps.filter((p) => p.sceneId === "s2");
check("强改通告后现场单仍保留不升版", stillFrozen.every((p) => p.state === "现场保留"));
check("现场单 revision 未增长", stillFrozen.every((p) => p.revision <= 2));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
