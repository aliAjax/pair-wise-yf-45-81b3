import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import dayjs from "dayjs";
import type {
  Confirmation,
  ConfirmationConflict,
  Dept,
  Handoff,
  LookSpec,
  PrepTask,
  ProcessedToken,
  RetryJob,
  Scene,
  SceneLook,
  TransferOccupation
} from "../types";
import { useScheduleStore } from "./schedule";

const CONT_KEY = "pair-wise-yf-45/continuity-v1";

const TRANSFER_MIN = 30;

/** 剧情序排序（与拍摄顺序无关） */
function storyOrder(scenes: Scene[]) {
  return [...scenes].sort((a, b) => a.storyNo - b.storyNo || a.code.localeCompare(b.code));
}

/** 拍摄顺序排序 */
function shootOrder(scenes: Scene[]) {
  return [...scenes].sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`));
}

function minutes(value: string) {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function cloneSpec(spec?: LookSpec | null): LookSpec | null {
  if (!spec) return null;
  return { costume: spec.costume, makeup: spec.makeup, props: [...spec.props] };
}

function specDigest(spec: LookSpec | null) {
  return spec ? `${spec.costume}|${spec.makeup}|${spec.props.join(",")}` : "∅";
}

interface PersistShape {
  looks: SceneLook[];
  handoffs: Handoff[];
  preps: PrepTask[];
  transfers: TransferOccupation[];
  confirmations: Confirmation[];
  confirmConflicts: ConfirmationConflict[];
  retries: RetryJob[];
  processed: ProcessedToken[];
}

function readState(): Partial<PersistShape> {
  try {
    const raw = localStorage.getItem(CONT_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const saved = readState();

export const useContinuityStore = defineStore("continuity", () => {
  const schedule = useScheduleStore();

  /* ---------------- 原始账本（用户写入） ---------------- */
  const looks = ref<SceneLook[]>(saved.looks ?? []);
  const handoffs = ref<Handoff[]>(saved.handoffs ?? []);
  const preps = ref<PrepTask[]>(saved.preps ?? []);
  const transfers = ref<TransferOccupation[]>(saved.transfers ?? []);
  const confirmations = ref<Confirmation[]>(saved.confirmations ?? []);
  const confirmConflicts = ref<ConfirmationConflict[]>(saved.confirmConflicts ?? []);
  const retries = ref<RetryJob[]>(saved.retries ?? []);
  const processed = ref<ProcessedToken[]>(saved.processed ?? []);

  /** 模拟写入通道：置为离线时新写入会失败并进重试队列 */
  const channelOnline = ref(true);
  /** 下一次写入强制失败一次（演示写失败/重试） */
  let failNextWrite = false;
  function setChannelOnline(value: boolean) {
    channelOnline.value = value;
  }
  function armWriteFailure() {
    failNextWrite = true;
  }

  const sceneById = (id: string) => schedule.scenes.find((s) => s.id === id);
  const talentName = (id: string) => schedule.talents.find((t) => t.id === id)?.name ?? id;
  const sceneName = (id: string) => {
    const s = sceneById(id);
    return s ? `${s.code} ${s.title}` : id;
  };

  const isFrozen = (scene?: Scene) => !!scene && (scene.status === "拍摄中" || scene.status === "已完成");

  /* ================= 一、角色造型 + 剧情序 + 交接 ================= */

  /**
   * 剧情相邻关系：按 storyNo 排序，相邻两场共享同一演员即产生一条交接链。
   * key: fromScene:toScene:talent —— 稳定逻辑身份。
   */
  const handoffChains = computed(() => {
    const chains: { key: string; from: Scene; to: Scene; talentId: string }[] = [];
    const ordered = storyOrder(schedule.scenes);
    for (let i = 0; i + 1 < ordered.length; i += 1) {
      const from = ordered[i];
      const to = ordered[i + 1];
      for (const talentId of from.talentIds) {
        if (to.talentIds.includes(talentId)) {
          chains.push({ key: `${from.id}->${to.id}:${talentId}`, from, to, talentId });
        }
      }
    }
    return chains;
  });

  /**
   * 连续性账视图：每条剧情相邻链的最新交接状态。
   * 上一场已有收尾回传 → 已交接并带出承接内容；
   * 上一场未回传或两场拍摄顺序倒置（跳拍）→ 待补交接。
   */
  const continuityLedger = computed(() =>
    handoffChains.value.map((chain) => {
      const existing = handoffs.value.find((h) => h.id === chain.key);
      const ending = looks.value.find(
        (l) => l.sceneId === chain.from.id && l.talentId === chain.talentId && l.ending
      )?.ending;

      const shootFrom = shootOrder(schedule.scenes).findIndex((s) => s.id === chain.from.id);
      const shootTo = shootOrder(schedule.scenes).findIndex((s) => s.id === chain.to.id);
      const jumpShot = shootTo < shootFrom; // 剧情后一场先拍 = 跳拍

      let state: Handoff["state"] = existing?.state ?? "待补交接";
      let carry = existing?.carry ?? null;
      let reason = existing?.reason;

      if (ending) {
        carry = cloneSpec(ending);
        state = "已交接";
        reason = undefined;
      } else {
        state = "待补交接";
        carry = null;
        reason = jumpShot
          ? `跳拍：${chain.to.code} 排在 ${chain.from.code} 之前拍摄，上一场收尾尚未回传`
          : `等待 ${chain.from.code} 现场收尾回传`;
      }

      return {
        key: chain.key,
        fromSceneId: chain.from.id,
        toSceneId: chain.to.id,
        talentId: chain.talentId,
        carry,
        state,
        reason,
        jumpShot,
        revision: existing?.revision ?? 0
      };
    })
  );

  const pendingHandoffs = computed(() => continuityLedger.value.filter((h) => h.state === "待补交接"));

  /* ================= 二、派生：准备单与转场占用（失效重算） ================= */

  function deptOf(spec: LookSpec): { dept: Dept; text: string }[] {
    return [
      { dept: "服装", text: spec.costume },
      { dept: "化妆", text: spec.makeup },
      { dept: "道具", text: spec.props.length ? spec.props.join("、") : "无随身道具" }
    ];
  }

  /**
   * 期望的准备单：每场、每个出场角色的服化道，
   * 指令优先承接剧情上一场的收尾状态（连续性），否则按本场造型设定。
   */
  const expectedPreps = computed(() => {
    const items: { key: string; sceneId: string; talentId?: string; equipmentId?: string; dept: Dept; instruction: string; dependsOn: string[] }[] = [];
    for (const scene of schedule.scenes) {
      for (const talentId of scene.talentIds) {
        const look = looks.value.find((l) => l.sceneId === scene.id && l.talentId === talentId);
        const incoming = continuityLedger.value.find(
          (h) => h.toSceneId === scene.id && h.talentId === talentId
        );
        const base = look?.planned;
        for (const { dept, text } of deptOf(base ?? { costume: "未设定", makeup: "未设定", props: [] })) {
          const carryText = incoming?.carry
            ? dept === "服装"
              ? incoming.carry.costume
              : dept === "化妆"
                ? incoming.carry.makeup
                : incoming.carry.props.join("、") || "无随身道具"
            : null;
          const instruction = carryText
            ? `承接上一场收尾：${carryText}`
            : incoming?.state === "待补交接"
              ? `待补交接后核对；暂定本场设定：${text}`
              : `本场设定：${text}`;
          items.push({
            key: `prep:${scene.id}:${talentId}:${dept}`,
            sceneId: scene.id,
            talentId,
            dept,
            instruction,
            dependsOn: incoming ? [incoming.key] : [`scene:${scene.id}`]
          });
        }
      }
      // 器材准备
      for (const equipmentId of scene.equipmentIds) {
        items.push({
          key: `prep:${scene.id}:eq:${equipmentId}`,
          sceneId: scene.id,
          equipmentId,
          dept: "器材",
          instruction: `布置器材：${schedule.equipmentNames([equipmentId])[0]}`,
          dependsOn: [`scene:${scene.id}`]
        });
      }
    }
    return items;
  });

  /**
   * 期望的转场占用：同一拍摄日、拍摄顺序相邻的两场之间，
   * 共享演员/器材或更换场地时，占用 [上一场结束, 下一场开始] 作为转场窗口。
   */
  const expectedTransfers = computed(() => {
    const result: { key: string; fromSceneId: string; toSceneId: string; day: string; windowStart: string; windowEnd: string; minutes: number; sharedTalentIds: string[]; sharedEquipmentIds: string[]; sameLocation: boolean; note: string; dependsOn: string[] }[] = [];
    const byDay = new Map<string, Scene[]>();
    for (const scene of shootOrder(schedule.scenes)) {
      const list = byDay.get(scene.day) ?? [];
      list.push(scene);
      byDay.set(scene.day, list);
    }
    for (const [day, list] of byDay) {
      for (let i = 0; i + 1 < list.length; i += 1) {
        const a = list[i];
        const b = list[i + 1];
        const sharedTalentIds = a.talentIds.filter((id) => b.talentIds.includes(id));
        const sharedEquipmentIds = a.equipmentIds.filter((id) => b.equipmentIds.includes(id));
        const sameLocation = a.locationId === b.locationId;
        if (!sharedTalentIds.length && !sharedEquipmentIds.length && sameLocation) continue;
        const gap = minutes(b.start) - minutes(a.end);
        const note = sameLocation
          ? `同场地区间占用（共享${sharedTalentIds.length ? "演员" : "器材"}）`
          : gap < TRANSFER_MIN
            ? `跨场地转场仅 ${gap} 分钟，不足 ${TRANSFER_MIN} 分钟`
            : `跨场地转场 ${gap} 分钟`;
        result.push({
          key: `transfer:${a.id}->${b.id}`,
          fromSceneId: a.id,
          toSceneId: b.id,
          day,
          windowStart: a.end,
          windowEnd: b.start,
          minutes: gap,
          sharedTalentIds,
          sharedEquipmentIds,
          sameLocation,
          note,
          dependsOn: [`scene:${a.id}`, `scene:${b.id}`]
        });
      }
    }
    return result;
  });

  /**
   * 派生账对帐：以 key 对齐旧账与新期望。
   * - 新出现：建账（有效，rev 1）
   * - 已存在且依赖指纹未变：保留，不升版
   * - 指纹变化（拍摄日/演员/器材/交接承接一变）：旧版留失效痕，立即重算新版 revision+1
   * - 场次已开拍（拍摄中/已完成）：冻结为"现场保留"，通告再改也不重算
   * - 期望中消失（删场/相邻关系解除）：留失效痕
   */
  function reconcile() {
    const fingerprintOf = (dependsOn: string[]) =>
      dependsOn
        .map((dep) => {
          if (dep.startsWith("scene:")) {
            const s = sceneById(dep.slice(6));
            return s ? `${dep}=${s.day}|${s.start}|${s.end}|${s.locationId}|${s.talentIds.join(",")}|${s.equipmentIds.join(",")}` : `${dep}=缺失`;
          }
          const h = continuityLedger.value.find((item) => item.key === dep);
          return h ? `${dep}=${h.state}:${specDigest(h.carry)}` : `${dep}=缺失`;
        })
        .sort()
        .join(";");

    // ---- 准备单：每个 key 只保留一张当前单，旧版进失效历史 ----
    const nextPreps: PrepTask[] = [];
    const livePrepKeys = new Set<string>();
    for (const exp of expectedPreps.value) {
      livePrepKeys.add(exp.key);
      const fp = fingerprintOf(exp.dependsOn);
      const scene = sceneById(exp.sceneId);
      // 该 key 最近一张非失效单（可能处于"现场保留"）
      const current = [...preps.value].reverse().find((p) => p.key === exp.key && p.state !== "已失效");
      // 该 key 已归档的失效历史
      for (const dead of preps.value.filter((p) => p.key === exp.key && p.state === "已失效")) nextPreps.push(dead);

      if (current && isFrozen(scene)) {
        // 已开拍：现场单原样留着，任何通告变更都不再重算
        nextPreps.push({ ...current, state: "现场保留", frozen: true });
        continue;
      }
      if (current && current.fingerprint === fp && !current.frozen) {
        nextPreps.push(current);
        continue;
      }
      if (current) {
        // 指纹变化或冻结解除 → 旧单失效留痕，立即重算
        nextPreps.push({ ...current, state: "已失效", frozen: false, invalidReason: "通告或交接依赖变更，原准备单失效，已重算替换" });
      }
      nextPreps.push({
        id: crypto.randomUUID(),
        key: exp.key,
        sceneId: exp.sceneId,
        talentId: exp.talentId,
        equipmentId: exp.equipmentId,
        dept: exp.dept,
        instruction: exp.instruction,
        dependsOn: exp.dependsOn,
        state: "有效",
        revision: (current?.revision ?? 0) + 1,
        frozen: false,
        createdAt: new Date().toISOString(),
        fingerprint: fp
      });
    }
    // 期望中消失的 key（场次删除/角色改派）：当前单留失效痕
    for (const old of preps.value) {
      if (livePrepKeys.has(old.key) || old.state === "已失效") continue;
      nextPreps.push({ ...old, state: "已失效", frozen: isFrozen(sceneById(old.sceneId)), invalidReason: "场次删除或角色/器材改派" });
    }
    // 每个 key 最多留 3 条失效历史，总量封顶
    const byKey = new Map<string, PrepTask[]>();
    for (const p of nextPreps) {
      const list = byKey.get(p.key) ?? [];
      list.push(p);
      byKey.set(p.key, list);
    }
    const trimmed: PrepTask[] = [];
    for (const list of byKey.values()) {
      const dead = list.filter((p) => p.state === "已失效").slice(-3);
      trimmed.push(...list.filter((p) => p.state !== "已失效"), ...dead);
    }
    preps.value = trimmed.slice(-300);

    // ---- 转场占用 ----
    const nextTransfers: TransferOccupation[] = [];
    const liveKeys = new Set<string>();
    for (const exp of expectedTransfers.value) {
      liveKeys.add(exp.key);
      const fp = fingerprintOf(exp.dependsOn);
      const frozen = isFrozen(sceneById(exp.fromSceneId)) || isFrozen(sceneById(exp.toSceneId));
      const current = [...transfers.value].reverse().find((t) => t.key === exp.key && t.state !== "已失效");
      for (const dead of transfers.value.filter((t) => t.key === exp.key && t.state === "已失效")) nextTransfers.push(dead);

      if (current && frozen) {
        nextTransfers.push({ ...current, state: "现场保留", frozen: true });
        continue;
      }
      if (current && current.fingerprint === fp && !current.frozen) {
        nextTransfers.push(current);
        continue;
      }
      if (current) {
        nextTransfers.push({ ...current, state: "已失效", frozen: false, invalidReason: "拍摄日/时间/演员/器材变更，占用窗口失效，已重算替换" });
      }
      nextTransfers.push({
        id: crypto.randomUUID(),
        key: exp.key,
        fromSceneId: exp.fromSceneId,
        toSceneId: exp.toSceneId,
        day: exp.day,
        windowStart: exp.windowStart,
        windowEnd: exp.windowEnd,
        minutes: exp.minutes,
        sharedTalentIds: exp.sharedTalentIds,
        sharedEquipmentIds: exp.sharedEquipmentIds,
        sameLocation: exp.sameLocation,
        note: exp.note,
        state: "有效",
        revision: (current?.revision ?? 0) + 1,
        frozen: false,
        createdAt: new Date().toISOString(),
        fingerprint: fp
      });
    }
    for (const old of transfers.value) {
      if (liveKeys.has(old.key) || old.state === "已失效") continue;
      nextTransfers.push({ ...old, state: "已失效", frozen: isFrozen(sceneById(old.fromSceneId)), invalidReason: "相邻场次关系解除或场次删除" });
    }
    transfers.value = nextTransfers.slice(-300);
  }

  // 场次、造型、交接任一变化 → 派生账立即重算
  watch(
    () => [schedule.scenes, looks.value, handoffs.value] as const,
    () => reconcile(),
    { deep: true, immediate: true }
  );

  /* ================= 三、造型设定与现场收尾回传（幂等 + 重试） ================= */

  function upsertPlanned(sceneId: string, talentId: string, planned: LookSpec) {
    const idx = looks.value.findIndex((l) => l.sceneId === sceneId && l.talentId === talentId);
    if (idx >= 0) looks.value[idx] = { ...looks.value[idx], planned };
    else looks.value.push({ sceneId, talentId, planned });
  }

  function seedLooksIfEmpty() {
    if (looks.value.length) return;
    const presets: Record<string, LookSpec> = {
      t1: { costume: "藏青风衣+灰围巾", makeup: "胡茬、左额擦伤", props: ["牛皮信封", "旧手表"] },
      t2: { costume: "米色风衣+牛仔裙", makeup: "淡妆、发尾微湿", props: ["录音笔"] },
      t3: { costume: "黑色夹克", makeup: "右眉贴创可贴", props: ["摩托车钥匙"] }
    };
    for (const scene of schedule.scenes) {
      for (const talentId of scene.talentIds) {
        const preset = presets[talentId];
        if (preset) upsertPlanned(scene.id, talentId, cloneSpec(preset)!);
      }
    }
  }
  seedLooksIfEmpty();

  const defaultPresets: Record<string, LookSpec> = {
    t1: { costume: "藏青风衣+灰围巾", makeup: "胡茬、左额擦伤", props: ["牛皮信封", "旧手表"] },
    t2: { costume: "米色风衣+牛仔裙", makeup: "淡妆、发尾微湿", props: ["录音笔"] },
    t3: { costume: "黑色夹克", makeup: "右眉贴创可贴", props: ["摩托车钥匙"] }
  };

  /** 新增场次或给场次加演员时，自动补一张造型设定档 */
  watch(
    () => schedule.scenes.map((s) => `${s.id}:${s.talentIds.join(",")}`).join("|"),
    () => {
      for (const scene of schedule.scenes) {
        for (const talentId of scene.talentIds) {
          const exists = looks.value.some((l) => l.sceneId === scene.id && l.talentId === talentId);
          if (!exists) {
            upsertPlanned(scene.id, talentId, cloneSpec(defaultPresets[talentId] ?? { costume: "待服装组设定", makeup: "待化妆组设定", props: [] })!);
          }
        }
      }
    }
  );

  function tokenSeen(token: string) {
    return processed.value.find((p) => p.token === token);
  }

  /**
   * 现场收尾回传。返回 null 表示成功入账；返回字符串表示失败原因（已进重试队列）。
   * 幂等：同一 token 重复回传不生成第二份交接。
   */
  function submitEnding(input: { sceneId: string; talentId: string; ending: LookSpec; by: string; token: string }): string | null {
    const seen = tokenSeen(input.token);
    if (seen) {
      // 重复回传：原结果是什么就还什么，不产生新交接
      return seen.outcome === "已入账" ? null : "重复回传，已忽略";
    }

    if (!channelOnline.value || failNextWrite) {
      failNextWrite = false;
      const error = !channelOnline.value ? "写入通道离线" : "写入失败（模拟）";
      enqueueRetry({
        kind: "造型回传",
        sceneId: input.sceneId,
        talentId: input.talentId,
        by: input.by,
        token: input.token,
        payload: cloneSpec(input.ending)!,
        error
      });
      return error;
    }

    applyEnding(input.sceneId, input.talentId, input.ending, input.token);
    processed.value.unshift({ token: input.token, kind: "造型回传", outcome: "已入账", refId: input.sceneId, at: new Date().toISOString() });
    return null;
  }

  function applyEnding(sceneId: string, talentId: string, ending: LookSpec, token: string) {
    const idx = looks.value.findIndex((l) => l.sceneId === sceneId && l.talentId === talentId);
    const endingAt = new Date().toISOString();
    if (idx >= 0) {
      looks.value[idx] = { ...looks.value[idx], ending: cloneSpec(ending)!, endingAt, endingToken: token };
    } else {
      looks.value.push({ sceneId, talentId, planned: { costume: "未设定", makeup: "未设定", props: [] }, ending: cloneSpec(ending)!, endingAt, endingToken: token });
    }
    // 将收尾状态过账到所有以该场为剧情上一场的交接链
    for (const chain of handoffChains.value) {
      if (chain.from.id !== sceneId || chain.talentId !== talentId) continue;
      const hIdx = handoffs.value.findIndex((h) => h.id === chain.key);
      const record: Handoff = {
        id: chain.key,
        fromSceneId: chain.from.id,
        toSceneId: chain.to.id,
        talentId,
        carry: cloneSpec(ending),
        state: "已交接",
        revision: (handoffs.value[hIdx]?.revision ?? 0) + 1
      };
      if (hIdx >= 0) handoffs.value[hIdx] = record;
      else handoffs.value.push(record);
    }
  }

  /* ================= 四、场次确认：先入账者生效，后到拿冲突编号 ================= */

  /**
   * @returns 成功 → { ok:true }；重复 token → { ok:true, duplicate:true }；
   *          冲突 → { ok:false, conflictId }；写入失败 → { ok:false, queued:true }
   */
  function confirmScene(input: { sceneId: string; by: string; token: string }):
    | { ok: true; duplicate?: boolean }
    | { ok: false; conflictId?: string; queued?: boolean; error?: string } {
    const seen = tokenSeen(input.token);
    if (seen) {
      if (seen.outcome === "冲突拒登") return { ok: false, conflictId: seen.refId };
      return { ok: true, duplicate: true };
    }

    if (!channelOnline.value || failNextWrite) {
      failNextWrite = false;
      const error = !channelOnline.value ? "写入通道离线" : "写入失败（模拟）";
      enqueueRetry({ kind: "场次确认", sceneId: input.sceneId, by: input.by, token: input.token, error });
      return { ok: false, queued: true, error };
    }

    return applyConfirmation(input.sceneId, input.by, input.token, false);
  }

  function applyConfirmation(sceneId: string, by: string, token: string, fromRetry: boolean):
    | { ok: true; duplicate?: boolean }
    | { ok: false; conflictId: string } {
    const winner = confirmations.value.find((c) => c.sceneId === sceneId);
    if (winner) {
      // 同场第二份确认：后到者拿到冲突编号
      const conflict: ConfirmationConflict = {
        id: `CF-${dayjs().format("MMDDHHmmss")}-${confirmConflicts.value.length + 1}`,
        sceneId,
        winnerBy: winner.by,
        winnerToken: winner.token,
        loserBy: by,
        loserToken: token,
        at: new Date().toISOString(),
        message: `${sceneName(sceneId)} 已由 ${winner.by} 先入账确认，${by} 的后到确认被拒登`,
        fromRetry
      };
      confirmConflicts.value.unshift(conflict);
      processed.value.unshift({ token, kind: "场次确认", outcome: "冲突拒登", refId: conflict.id, at: new Date().toISOString() });
      return { ok: false, conflictId: conflict.id };
    }
    confirmations.value.push({ id: crypto.randomUUID(), sceneId, by, at: new Date().toISOString(), token });
    schedule.updateStatus(sceneId, "已确认");
    processed.value.unshift({ token, kind: "场次确认", outcome: "已入账", refId: sceneId, at: new Date().toISOString() });
    return { ok: true };
  }

  function winnerOf(sceneId: string) {
    return confirmations.value.find((c) => c.sceneId === sceneId);
  }

  /* ================= 五、写入失败重试队列（幂等重放） ================= */

  function enqueueRetry(input: { kind: RetryJob["kind"]; sceneId: string; talentId?: string; by?: string; token: string; payload?: LookSpec; error: string }) {
    // 同 token 已在队列中：只增 attempts，不重复入队
    const existing = retries.value.find((r) => r.token === input.token && r.status === "待重试");
    if (existing) {
      existing.attempts += 1;
      existing.lastError = input.error;
      return;
    }
    retries.value.unshift({
      id: crypto.randomUUID(),
      kind: input.kind,
      sceneId: input.sceneId,
      talentId: input.talentId,
      by: input.by,
      token: input.token,
      payload: input.payload ? cloneSpec(input.payload)! : undefined,
      attempts: 1,
      lastError: input.error,
      queuedAt: new Date().toISOString(),
      status: "待重试"
    });
  }

  /** 重放单条：成功按原 token 入账，保证不产生第二份交接/确认；仍失败则留在队列 */
  function retryJob(id: string): { ok: boolean; note: string } {
    const job = retries.value.find((r) => r.id === id);
    if (!job || job.status !== "待重试") return { ok: false, note: "任务不在队列" };
    if (!channelOnline.value) {
      job.attempts += 1;
      job.lastError = "写入通道仍离线";
      return { ok: false, note: job.lastError };
    }
    // 重放前先查幂等账：可能已由别的通道入账
    const seen = tokenSeen(job.token);
    if (seen) {
      job.status = seen.outcome === "冲突拒登" ? "重试冲突" : "重试成功";
      job.finishedAt = new Date().toISOString();
      return { ok: seen.outcome !== "冲突拒登", note: `幂等命中：${seen.outcome}` };
    }

    if (job.kind === "造型回传" && job.payload) {
      applyEnding(job.sceneId, job.talentId!, job.payload, job.token);
      processed.value.unshift({ token: job.token, kind: "造型回传", outcome: "已入账", refId: job.sceneId, at: new Date().toISOString() });
      job.status = "重试成功";
      job.finishedAt = new Date().toISOString();
      return { ok: true, note: "补传成功，交接已过账" };
    }
    const result = applyConfirmation(job.sceneId, job.by ?? "迟到提交", job.token, true);
    job.finishedAt = new Date().toISOString();
    if (result.ok) {
      job.status = "重试成功";
      return { ok: true, note: "迟到确认已入账" };
    }
    job.status = "重试冲突";
    return { ok: false, note: `该场已被先入账，冲突编号 ${result.conflictId}` };
  }

  /** 一键重放全部待重试任务 */
  function retryAll() {
    const results = retries.value.filter((r) => r.status === "待重试").map((r) => retryJob(r.id));
    const ok = results.filter((r) => r.ok).length;
    return { ok, failed: results.length - ok };
  }

  function discardRetry(id: string) {
    const job = retries.value.find((r) => r.id === id);
    if (job) retries.value = retries.value.filter((r) => r.id !== id);
  }

  /* ---------------- 持久化 ---------------- */
  watch(
    [looks, handoffs, preps, transfers, confirmations, confirmConflicts, retries, processed],
    () => {
      const data: PersistShape = {
        looks: looks.value,
        handoffs: handoffs.value,
        preps: preps.value,
        transfers: transfers.value,
        confirmations: confirmations.value,
        confirmConflicts: confirmConflicts.value,
        retries: retries.value,
        processed: processed.value
      };
      localStorage.setItem(CONT_KEY, JSON.stringify(data));
    },
    { deep: true }
  );

  const activePreps = computed(() => preps.value.filter((p) => p.state !== "已失效"));
  const invalidPreps = computed(() => preps.value.filter((p) => p.state === "已失效"));
  const activeTransfers = computed(() => transfers.value.filter((t) => t.state !== "已失效"));
  const invalidTransfers = computed(() => transfers.value.filter((t) => t.state === "已失效"));

  return {
    // state
    looks,
    handoffs,
    preps,
    transfers,
    confirmations,
    confirmConflicts,
    retries,
    processed,
    channelOnline,
    // derived
    continuityLedger,
    pendingHandoffs,
    activePreps,
    invalidPreps,
    activeTransfers,
    invalidTransfers,
    // helpers
    sceneName,
    talentName,
    winnerOf,
    // actions
    setChannelOnline,
    armWriteFailure,
    upsertPlanned,
    submitEnding,
    confirmScene,
    retryJob,
    retryAll,
    discardRetry
  };
});
