import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import dayjs from "dayjs";
import { useScheduleStore } from "./schedule";
import type { ConfirmationConflict, Handover, Look, RetryItem, Scene } from "../types";

const STORAGE_KEY = "pair-wise-yf-45/continuity-v1";

interface Persisted {
  looks: Look[];
  handovers: Handover[];
  conflicts: ConfirmationConflict[];
  retryQueue: RetryItem[];
  conflictSeq: number;
}

function readState(): Persisted {
  const fallback: Persisted = { looks: [], handovers: [], conflicts: [], retryQueue: [], conflictSeq: 0 };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      looks: parsed.looks ?? [],
      handovers: parsed.handovers ?? [],
      conflicts: parsed.conflicts ?? [],
      retryQueue: parsed.retryQueue ?? [],
      conflictSeq: parsed.conflictSeq ?? 0
    };
  } catch {
    return fallback;
  }
}

function shootDateTime(scene: Scene) {
  return dayjs(`${scene.day} ${scene.start}`);
}

function isShot(scene: Scene | undefined | null) {
  return !!scene && (scene.status === "拍摄中" || scene.status === "已完成");
}

/** 场次依赖签名：拍摄日/场地/演员/器材任一变化即失效 */
function sceneSignature(scene: Scene) {
  return `${scene.day}|${scene.locationId}|${[...scene.talentIds].sort().join(",")}|${[...scene.equipmentIds].sort().join(",")}`;
}

function handoverKey(fromSceneId: string, toSceneId: string, talentId: string) {
  return `${fromSceneId}:${toSceneId}:${talentId}`;
}

export const useContinuityStore = defineStore("continuity", () => {
  const schedule = useScheduleStore();
  const persisted = readState();

  const looks = ref<Look[]>(persisted.looks);
  const handovers = ref<Handover[]>(persisted.handovers);
  const conflicts = ref<ConfirmationConflict[]>(persisted.conflicts);
  const retryQueue = ref<RetryItem[]>(persisted.retryQueue);
  const conflictSeq = ref(persisted.conflictSeq);
  const forceFail = ref(false);

  const pendingHandovers = computed(() => handovers.value.filter((h) => h.status === "待补"));
  const completedHandovers = computed(() => handovers.value.filter((h) => h.status === "已完成"));

  function lookKey(sceneId: string, talentId: string) {
    return `${sceneId}:${talentId}`;
  }

  function findLook(sceneId: string, talentId: string): Look | undefined {
    return looks.value.find((l) => l.sceneId === sceneId && l.talentId === talentId);
  }

  function materialsFor(sceneId: string, talentId: string) {
    const look = findLook(sceneId, talentId);
    return {
      costume: look?.costume?.trim() || "待定",
      makeup: look?.makeup?.trim() || "待定",
      props: look?.props ?? []
    };
  }

  /** 剧情相邻：同一角色在剧情序中前后相邻的两场 */
  function storyAdjacency(): { from: Scene; to: Scene; talentId: string }[] {
    const byStory = [...schedule.scenes].sort((a, b) => a.storyOrder - b.storyOrder);
    const talentIds = new Set<string>();
    for (const s of schedule.scenes) for (const t of s.talentIds) talentIds.add(t);
    const adj: { from: Scene; to: Scene; talentId: string }[] = [];
    for (const tid of talentIds) {
      const theirs = byStory.filter((s) => s.talentIds.includes(tid));
      for (let i = 0; i < theirs.length - 1; i += 1) {
        adj.push({ from: theirs[i], to: theirs[i + 1], talentId: tid });
      }
    }
    return adj;
  }

  function handoverStatusOf(from: Scene, to: Scene): { status: Handover["status"]; reason: string } {
    const fromShot = isShot(from);
    const fromBeforeTo = shootDateTime(from).isBefore(shootDateTime(to)) || shootDateTime(from).isSame(shootDateTime(to));
    if (fromShot && fromBeforeTo) {
      return { status: "已完成", reason: "上一场已拍且按序拍摄，收尾状态可直接交接" };
    }
    if (!fromShot) {
      return { status: "待补", reason: `上一场《${schedule.sceneCode(from.id)}》尚未开拍，收尾状态未定` };
    }
    return { status: "待补", reason: `跳拍：《${schedule.sceneCode(to.id)}》先于上一场拍摄，收尾状态未产生` };
  }

  /** 重算交接账：按当前剧情序与拍摄序重建；已开拍的已完成交接留着现场 */
  function recomputeHandovers() {
    const adj = storyAdjacency();
    const seen = new Set<string>();
    const next: Handover[] = [];
    for (const { from, to, talentId } of adj) {
      const key = handoverKey(from.id, to.id, talentId);
      seen.add(key);
      const mat = materialsFor(from.id, talentId);
      const st = handoverStatusOf(from, to);
      const existing = handovers.value.find((h) => h.key === key);
      if (existing) {
        if (existing.status === "已完成" && isShot(from)) {
          next.push({ ...existing, materials: mat, invalid: false });
        } else {
          next.push({ ...existing, materials: mat, status: st.status, reason: st.reason, invalid: false });
        }
      } else {
        next.push({
          id: crypto.randomUUID(),
          key,
          fromSceneId: from.id,
          toSceneId: to.id,
          talentId,
          materials: mat,
          status: st.status,
          reason: st.reason,
          invalid: false,
          version: 0,
          completedAt: null,
          createdAt: new Date().toISOString()
        });
      }
    }
    for (const h of handovers.value) {
      const from = schedule.scenes.find((s) => s.id === h.fromSceneId);
      if (!seen.has(h.key) && h.status === "已完成" && isShot(from)) {
        next.push({ ...h, invalid: false });
      }
    }
    handovers.value = next;
  }

  /** 为所有场次×角色建立造型；清理孤儿造型（已开拍已确认的留着现场） */
  function ensureLooks() {
    const keep = new Set<string>();
    for (const s of schedule.scenes) {
      for (const tid of s.talentIds) {
        keep.add(lookKey(s.id, tid));
        if (!findLook(s.id, tid)) {
          looks.value.push({
            id: crypto.randomUUID(),
            sceneId: s.id,
            talentId: tid,
            costume: "",
            makeup: "",
            props: [],
            endingState: "",
            status: "待定",
            version: 0,
            confirmedBy: null,
            confirmedAt: null,
            invalid: false,
            updatedAt: new Date().toISOString()
          });
        }
      }
    }
    for (let i = looks.value.length - 1; i >= 0; i -= 1) {
      const l = looks.value[i];
      if (keep.has(lookKey(l.sceneId, l.talentId))) continue;
      const sc = schedule.scenes.find((s) => s.id === l.sceneId);
      if (l.status === "已确认" && isShot(sc)) continue;
      looks.value.splice(i, 1);
    }
  }

  /** 场次拍摄日/演员/器材一改，依赖它的未开拍造型失效重算；已开拍留着现场 */
  function invalidateForScene(sceneId: string) {
    const scene = schedule.scenes.find((s) => s.id === sceneId);
    if (!scene || isShot(scene)) return;
    for (const l of looks.value) {
      if (l.sceneId === sceneId) {
        l.invalid = true;
        l.status = "待定";
        l.updatedAt = new Date().toISOString();
      }
    }
  }

  const prevSignatures = ref<Map<string, string>>(new Map());
  function syncSignatures() {
    const m = new Map<string, string>();
    for (const s of schedule.scenes) m.set(s.id, sceneSignature(s));
    prevSignatures.value = m;
  }

  watch(
    () => schedule.scenes,
    () => {
      const next = new Map<string, string>();
      for (const s of schedule.scenes) next.set(s.id, sceneSignature(s));
      for (const [id, sig] of next) {
        if (prevSignatures.value.get(id) !== sig) {
          invalidateForScene(id);
          for (const h of handovers.value) {
            const from = schedule.scenes.find((s) => s.id === h.fromSceneId);
            const involved = h.fromSceneId === id || h.toSceneId === id;
            const preserve = h.status === "已完成" && isShot(from);
            if (involved && !preserve) h.invalid = true;
          }
        }
      }
      prevSignatures.value = next;
      ensureLooks();
      recomputeHandovers();
    },
    { deep: true }
  );

  watch(looks, () => { recomputeHandovers(); }, { deep: true });

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      looks: looks.value,
      handovers: handovers.value,
      conflicts: conflicts.value,
      retryQueue: retryQueue.value,
      conflictSeq: conflictSeq.value
    }));
  }
  watch([looks, handovers, conflicts, retryQueue, conflictSeq], persist, { deep: true });

  function log(action: string, detail: string) {
    schedule.history.unshift({ id: crypto.randomUUID(), action, detail, time: new Date().toISOString() });
    if (schedule.history.length > 80) schedule.history.splice(80);
  }

  function issueConflict(
    targetType: ConfirmationConflict["targetType"],
    targetKey: string,
    sceneId: string,
    talentId: string,
    winner: string,
    loser: string,
    reason: string
  ): ConfirmationConflict {
    conflictSeq.value += 1;
    const id = `LX-${dayjs().format("YYYYMMDD")}-${String(conflictSeq.value).padStart(3, "0")}`;
    const conflict: ConfirmationConflict = { id, targetType, targetKey, sceneId, talentId, winner, loser, reason, time: new Date().toISOString() };
    conflicts.value.unshift(conflict);
    log("并发确认冲突", `${id}：${loser} 提交被 ${winner} 抢先入账`);
    return conflict;
  }

  function pushRetry(targetType: RetryItem["targetType"], targetKey: string, payload: Record<string, unknown>, error: string): RetryItem {
    const item: RetryItem = {
      id: crypto.randomUUID(),
      targetType,
      targetKey,
      payload,
      error,
      attempts: 1,
      status: "待重试",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    retryQueue.value.unshift(item);
    log("写入失败入重试队列", `${targetType}:${targetKey} — ${error}`);
    return item;
  }

  /** 确认造型：乐观并发，先入账生效，后到拿冲突编号 */
  function confirmLook(
    sceneId: string,
    talentId: string,
    actor: string,
    expectedVersion?: number
  ): { ok: boolean; conflict?: ConfirmationConflict; retry?: RetryItem; look?: Look } {
    let look = findLook(sceneId, talentId);
    if (!look) {
      look = {
        id: crypto.randomUUID(),
        sceneId,
        talentId,
        costume: "",
        makeup: "",
        props: [],
        endingState: "",
        status: "待定",
        version: 0,
        confirmedBy: null,
        confirmedAt: null,
        invalid: false,
        updatedAt: new Date().toISOString()
      };
      looks.value.push(look);
    }
    if (expectedVersion !== undefined && look.version !== expectedVersion) {
      const conflict = issueConflict("look", lookKey(sceneId, talentId), sceneId, talentId, look.confirmedBy ?? "未知", actor, "版本不一致：确认期间造型已被他人修改");
      return { ok: false, conflict };
    }
    if (look.status === "已确认" && look.confirmedBy && look.confirmedBy !== actor) {
      const conflict = issueConflict("look", lookKey(sceneId, talentId), sceneId, talentId, look.confirmedBy, actor, "该场造型已由他人确认，先入账生效");
      return { ok: false, conflict };
    }
    if (forceFail.value) {
      forceFail.value = false;
      const retry = pushRetry("look", lookKey(sceneId, talentId), { sceneId, talentId, actor, expectedVersion: look.version }, "模拟写入失败：造型入账网络中断");
      return { ok: false, retry };
    }
    look.status = "已确认";
    look.confirmedBy = actor;
    look.confirmedAt = new Date().toISOString();
    look.version += 1;
    look.invalid = false;
    look.updatedAt = new Date().toISOString();
    log("确认造型", `${schedule.sceneCode(sceneId)} / ${schedule.talentName(talentId)} 由 ${actor} 确认`);
    recomputeHandovers();
    return { ok: true, look };
  }

  /** 完成交接：幂等键去重，重复回传不生成第二份；失败入重试队列 */
  function completeHandover(
    key: string,
    actor: string,
    opts: { force?: boolean } = {}
  ): { ok: boolean; duplicate?: boolean; retry?: RetryItem; handover?: Handover } {
    const h = handovers.value.find((x) => x.key === key);
    if (!h) return { ok: false };
    if (h.status === "已完成") {
      return { ok: true, duplicate: true, handover: h };
    }
    if (forceFail.value && !opts.force) {
      forceFail.value = false;
      const retry = pushRetry("handover", key, { key, actor }, "模拟写入失败：交接入账超时");
      return { ok: false, retry };
    }
    h.status = "已完成";
    h.completedAt = new Date().toISOString();
    h.version += 1;
    h.invalid = false;
    const item = retryQueue.value.find((r) => r.targetKey === key && r.targetType === "handover" && r.status === "待重试");
    if (item) {
      item.status = "已重试";
      item.updatedAt = new Date().toISOString();
    }
    log("完成交接", `${schedule.sceneCode(h.fromSceneId)} → ${schedule.sceneCode(h.toSceneId)} / ${schedule.talentName(h.talentId)} 由 ${actor} 交接`);
    return { ok: true, handover: h };
  }

  /** 重试队列：按幂等键重放，成功则标记已重试 */
  function retryItem(id: string, actor: string) {
    const item = retryQueue.value.find((r) => r.id === id);
    if (!item || item.status !== "待重试") return;
    if (item.targetType === "handover") {
      const res = completeHandover(item.targetKey, actor, { force: true });
      if (res.ok) {
        item.status = "已重试";
        item.updatedAt = new Date().toISOString();
      } else {
        item.attempts += 1;
        item.updatedAt = new Date().toISOString();
      }
    } else {
      const p = item.payload as { sceneId: string; talentId: string; expectedVersion?: number };
      const res = confirmLook(p.sceneId, p.talentId, actor, p.expectedVersion);
      if (res.ok) {
        item.status = "已重试";
        item.updatedAt = new Date().toISOString();
      } else {
        item.attempts += 1;
        item.updatedAt = new Date().toISOString();
      }
    }
  }

  /** 模拟重复回传：同一幂等键回调两次，不生成第二份交接 */
  function duplicateCallback(key: string, actor: string) {
    const first = completeHandover(key, actor);
    const second = completeHandover(key, actor);
    return { first, second };
  }

  // 初始化：先同步签名再建造型、重算交接
  syncSignatures();
  ensureLooks();
  recomputeHandovers();

  return {
    looks,
    handovers,
    conflicts,
    retryQueue,
    conflictSeq,
    forceFail,
    pendingHandovers,
    completedHandovers,
    lookKey,
    findLook,
    materialsFor,
    ensureLooks,
    recomputeHandovers,
    invalidateForScene,
    confirmLook,
    completeHandover,
    retryItem,
    duplicateCallback
  };
});
