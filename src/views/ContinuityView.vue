<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import dayjs from "dayjs";
import { ElMessage } from "element-plus";
import { useScheduleStore } from "../stores/schedule";
import { useContinuityStore } from "../stores/continuity";
import type { LookSpec, Scene } from "../types";

const store = useScheduleStore();
const continuity = useContinuityStore();
const activeTab = ref("ledger");

/* ---------- 剧情序 ---------- */
const storyScenes = computed(() => [...store.scenes].sort((a, b) => a.storyNo - b.storyNo || a.code.localeCompare(b.code)));
function lookFor(sceneId: string, talentId: string) {
  return continuity.looks.find((l) => l.sceneId === sceneId && l.talentId === talentId);
}
function incoming(sceneId: string, talentId: string) {
  return continuity.continuityLedger.find((h) => h.toSceneId === sceneId && h.talentId === talentId);
}
function outgoing(sceneId: string, talentId: string) {
  return continuity.continuityLedger.find((h) => h.fromSceneId === sceneId && h.talentId === talentId);
}

/* ---------- 收尾回传表单（每场每角色一张，token 固定用于幂等演示） ---------- */
interface EndingForm {
  costume: string;
  makeup: string;
  propsText: string;
  by: string;
  token: string;
}
const forms = new Map<string, EndingForm>();
function formKey(sceneId: string, talentId: string) {
  return `${sceneId}:${talentId}`;
}
function endingForm(scene: Scene, talentId: string): EndingForm {
  const key = formKey(scene.id, talentId);
  let form = forms.get(key);
  if (!form) {
    const look = lookFor(scene.id, talentId);
    form = reactive({
      costume: look?.ending?.costume ?? look?.planned.costume ?? "",
      makeup: look?.ending?.makeup ?? look?.planned.makeup ?? "",
      propsText: (look?.ending?.props ?? look?.planned.props ?? []).join("、"),
      by: "场记·小苏",
      token: crypto.randomUUID()
    }) as EndingForm;
    forms.set(key, form);
  }
  return form;
}
function toSpec(form: EndingForm): LookSpec {
  return { costume: form.costume, makeup: form.makeup, props: form.propsText.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) };
}
function submitEnding(scene: Scene, talentId: string, duplicate = false) {
  const form = endingForm(scene, talentId);
  // duplicate=true 时沿用同一 token，模拟网络重发/重复回传
  const error = continuity.submitEnding({ sceneId: scene.id, talentId, ending: toSpec(form), by: form.by, token: form.token });
  if (error) ElMessage.warning(`写入失败，已进入重试队列：${error}`);
  else if (duplicate) ElMessage.success("重复回传被幂等拦截，未生成第二份交接");
  else ElMessage.success("收尾状态已入账，交接已过账到剧情下一场");
}

/* ---------- 场次确认 ---------- */
const confirmBy = ref("场记·小苏");
function doConfirm(scene: Scene, token = crypto.randomUUID()) {
  const result = continuity.confirmScene({ sceneId: scene.id, by: confirmBy.value, token });
  if (result.ok) {
    if (result.duplicate) ElMessage.info("同一令牌重复提交，幂等忽略（仍为先入账者）");
    else ElMessage.success(`${scene.code} 由 ${confirmBy.value} 先入账确认`);
  } else if (result.queued) ElMessage.warning(`写入失败，确认请求已进重试队列：${result.error}`);
  else ElMessage.error(`后到确认被拒登，冲突编号 ${result.conflictId}`);
  return result;
}
/** 两人同时提交：同一帧内先后入账，先到生效、后到拿冲突编号 */
function concurrentConfirm(scene: Scene) {
  const a = continuity.confirmScene({ sceneId: scene.id, by: "场记甲", token: crypto.randomUUID() });
  const b = continuity.confirmScene({ sceneId: scene.id, by: "场记乙", token: crypto.randomUUID() });
  if (a.ok && !b.ok && "conflictId" in b) {
    ElMessage.success(`甲先入账生效；乙拿到冲突编号 ${b.conflictId}`);
  } else if (!a.ok && "queued" in a && a.queued) {
    ElMessage.warning("通道中断，两人的请求都已进入重试队列，恢复后重放仍按令牌先后裁决");
  } else {
    ElMessage.info("本场已有入账，请改试未确认场次");
  }
}

/* ---------- 通道/重试 ---------- */
const channelOnline = computed({
  get: () => continuity.channelOnline,
  set: (v: boolean) => continuity.setChannelOnline(v)
});
const pendingRetries = computed(() => continuity.retries.filter((r) => r.status === "待重试"));
function retryOne(id: string) {
  const r = continuity.retryJob(id);
  r.ok ? ElMessage.success(r.note) : ElMessage.warning(r.note);
}
function retryAll() {
  const r = continuity.retryAll();
  ElMessage.success(`重放完成：成功 ${r.ok} 条，仍失败/冲突 ${r.failed} 条`);
}

/* ---------- 分组 ---------- */
const prepsByScene = computed(() => {
  const map = new Map<string, typeof continuity.activePreps>();
  for (const p of continuity.activePreps) {
    const list = map.get(p.sceneId) ?? [];
    list.push(p);
    map.set(p.sceneId, list);
  }
  return map;
});
const stateClass = (s: string) => s;
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article class="metric"><span>剧情交接链</span><strong>{{ continuity.continuityLedger.length }}</strong></article>
      <article class="metric"><span>待补交接（含跳拍）</span><strong>{{ continuity.pendingHandoffs.length }}</strong></article>
      <article class="metric"><span>已失效待重算单</span><strong>{{ continuity.invalidPreps.length + continuity.invalidTransfers.length }}</strong></article>
      <article class="metric"><span>重试队列</span><strong>{{ pendingRetries.length }}</strong></article>
    </div>

    <el-tabs v-model="activeTab" class="cont-tabs">
      <!-- ============ 连续性账：剧情序 × 造型 × 交接 ============ -->
      <el-tab-pane label="连续性账" name="ledger">
        <div class="ledger-flow">
          <template v-for="(scene, idx) in storyScenes" :key="scene.id">
            <article class="story-card" :class="{ frozen: scene.status === '拍摄中' || scene.status === '已完成' }">
              <header>
                <div class="story-head">
                  <span class="story-badge">#{{ scene.storyNo }}</span>
                  <div>
                    <b>{{ scene.code }} {{ scene.title }}</b>
                    <small>拍摄：{{ scene.day }} {{ scene.start }}–{{ scene.end }} · {{ store.locationName(scene.locationId) }}
                      <em v-if="scene.status === '拍摄中' || scene.status === '已完成'" class="on-set">● 已开拍，现场保留</em>
                    </small>
                  </div>
                </div>
                <span class="status" :class="scene.status">{{ scene.status }}</span>
              </header>

              <div v-for="talentId in scene.talentIds" :key="talentId" class="look-block">
                <div class="look-person">{{ continuity.talentName(talentId) }}</div>
                <div class="look-cols">
                  <div class="look-col planned">
                    <span class="col-tag">剧情设定（服化道）</span>
                    <template v-if="lookFor(scene.id, talentId)">
                      <p><b>服装</b>{{ lookFor(scene.id, talentId)!.planned.costume }}</p>
                      <p><b>化妆</b>{{ lookFor(scene.id, talentId)!.planned.makeup }}</p>
                      <p><b>道具</b>{{ lookFor(scene.id, talentId)!.planned.props.join("、") || "无" }}</p>
                    </template>
                    <p v-else class="muted">未建档</p>
                  </div>

                  <div class="look-arrow">
                    <template v-if="incoming(scene.id, talentId)">
                      <div v-if="incoming(scene.id, talentId)!.state === '已交接'" class="handoff ok">
                        <span>↩ 承接上一场收尾</span>
                        <small>服装：{{ incoming(scene.id, talentId)!.carry?.costume }}</small>
                        <small>化妆：{{ incoming(scene.id, talentId)!.carry?.makeup }}</small>
                        <small>道具：{{ incoming(scene.id, talentId)!.carry?.props?.join("、") || "无" }}</small>
                      </div>
                      <div v-else class="handoff pending">
                        <span>⚠ 待补交接</span>
                        <small>{{ incoming(scene.id, talentId)!.reason }}</small>
                        <small v-if="incoming(scene.id, talentId)!.jumpShot" class="jump">跳拍场次，先拍本场</small>
                      </div>
                    </template>
                    <div v-else class="handoff none"><span>剧情序首场</span></div>
                  </div>

                  <div class="look-col ending">
                    <span class="col-tag">现场收尾回传</span>
                    <template v-if="lookFor(scene.id, talentId)?.ending">
                      <p class="ended"><b>服装</b>{{ lookFor(scene.id, talentId)!.ending!.costume }}</p>
                      <p class="ended"><b>化妆</b>{{ lookFor(scene.id, talentId)!.ending!.makeup }}</p>
                      <p class="ended"><b>道具</b>{{ lookFor(scene.id, talentId)!.ending!.props.join("、") || "无" }}</p>
                      <small class="muted">回传于 {{ dayjs(lookFor(scene.id, talentId)!.endingAt).format("MM-DD HH:mm:ss") }}</small>
                    </template>
                    <template v-else>
                      <label class="mini"><span>服装收尾</span><input v-model="endingForm(scene, talentId).costume" /></label>
                      <label class="mini"><span>化妆收尾</span><input v-model="endingForm(scene, talentId).makeup" /></label>
                      <label class="mini"><span>道具（、分隔）</span><input v-model="endingForm(scene, talentId).propsText" /></label>
                      <label class="mini"><span>回传人</span><input v-model="endingForm(scene, talentId).by" /></label>
                      <div class="actions">
                        <button class="primary" @click="submitEnding(scene, talentId)">回传收尾</button>
                        <button class="secondary" title="同一令牌再发一次，验证不会生成第二份交接" @click="submitEnding(scene, talentId, true)">重复回传</button>
                      </div>
                    </template>
                  </div>
                </div>

                <div v-if="outgoing(scene.id, talentId)" class="out-row">
                  → 交至剧情下一场：
                  <b>{{ store.scenes.find((s) => s.id === outgoing(scene.id, talentId)!.toSceneId)?.code }}</b>
                  <span :class="['handoff-pill', outgoing(scene.id, talentId)!.state]">{{ outgoing(scene.id, talentId)!.state }}</span>
                  <small v-if="outgoing(scene.id, talentId)!.state === '待补交接'" class="muted">{{ outgoing(scene.id, talentId)!.reason }}</small>
                </div>
              </div>
            </article>

            <div v-if="idx < storyScenes.length - 1" class="story-link" :class="{ gap: true }">
              <span>剧情序相邻 ↓</span>
            </div>
          </template>
        </div>
      </el-tab-pane>

      <!-- ============ 准备单 + 转场占用（失效重算台账） ============ -->
      <el-tab-pane label="准备 / 转场台账" name="derived">
        <div class="grid-2">
          <section class="panel">
            <div class="panel-head"><h2>服化道与器材准备单</h2><small class="muted">依赖交接或通告，变更即失效重算；开拍后现场保留</small></div>
            <template v-for="scene in storyScenes" :key="scene.id">
              <div v-if="prepsByScene.get(scene.id)?.length" class="derived-group">
                <h4>{{ scene.code }} {{ scene.title }} <span class="story-badge sm">#{{ scene.storyNo }}</span></h4>
                <div v-for="p in prepsByScene.get(scene.id)" :key="p.id" class="derived-row">
                  <span class="dept-tag">{{ p.dept }}</span>
                  <div class="derived-body">
                    <b>{{ p.instruction }}</b>
                    <small v-if="p.talentId">{{ continuity.talentName(p.talentId) }} · 第 {{ p.revision }} 版</small>
                  </div>
                  <span class="state-pill" :class="stateClass(p.state)">{{ p.state }}</span>
                </div>
              </div>
            </template>
            <el-empty v-if="!continuity.activePreps.length" description="暂无准备单" />

            <el-collapse v-if="continuity.invalidPreps.length" class="invalid-collapse">
              <el-collapse-item :title="`失效留痕（${continuity.invalidPreps.length}）`" name="p">
                <div v-for="p in continuity.invalidPreps.slice().reverse()" :key="p.id" class="derived-row invalid">
                  <span class="dept-tag">{{ p.dept }}</span>
                  <div class="derived-body"><b>{{ continuity.sceneName(p.sceneId) }}</b><small>{{ p.invalidReason }} · 第 {{ p.revision }} 版</small></div>
                  <span class="state-pill 已失效">已失效</span>
                </div>
              </el-collapse-item>
            </el-collapse>
          </section>

          <section class="panel">
            <div class="panel-head"><h2>转场窗口占用</h2><small class="muted">同日相邻通告、共享演员/器材或跨场地即占用；不足30分钟告警</small></div>
            <div v-for="t in continuity.activeTransfers" :key="t.id" class="transfer-row" :class="{ tight: !t.sameLocation && t.minutes < 30 }">
              <div class="transfer-main">
                <b>{{ continuity.sceneName(t.fromSceneId) }} → {{ continuity.sceneName(t.toSceneId) }}</b>
                <small>{{ t.day }} {{ t.windowStart }}–{{ t.windowEnd }}（{{ t.note }}）</small>
                <small class="muted" v-if="t.sharedTalentIds.length">共享演员：{{ t.sharedTalentIds.map(continuity.talentName).join("、") }}</small>
                <small class="muted" v-if="t.sharedEquipmentIds.length">共享器材：{{ t.sharedEquipmentIds.map((id) => store.equipmentNames([id])[0]).join("、") }}</small>
              </div>
              <div class="transfer-side">
                <span class="minutes" :class="{ warn: !t.sameLocation && t.minutes < 30 }">{{ t.minutes }}分</span>
                <span class="state-pill" :class="stateClass(t.state)">{{ t.state }}</span>
                <small class="muted">rev.{{ t.revision }}</small>
              </div>
            </div>
            <el-empty v-if="!continuity.activeTransfers.length" description="暂无转场占用" />

            <el-collapse v-if="continuity.invalidTransfers.length" class="invalid-collapse">
              <el-collapse-item :title="`失效留痕（${continuity.invalidTransfers.length}）`" name="t">
                <div v-for="t in continuity.invalidTransfers.slice().reverse()" :key="t.id" class="transfer-row invalid">
                  <div class="transfer-main"><b>{{ continuity.sceneName(t.fromSceneId) }} → {{ continuity.sceneName(t.toSceneId) }}</b><small>{{ t.invalidReason }} · rev.{{ t.revision }}</small></div>
                  <span class="state-pill 已失效">已失效</span>
                </div>
              </el-collapse-item>
            </el-collapse>
          </section>
        </div>
      </el-tab-pane>

      <!-- ============ 场次确认：先入账生效 / 冲突编号 ============ -->
      <el-tab-pane label="确认 / 冲突" name="confirm">
        <section class="panel">
          <div class="panel-head">
            <h2>场次确认入账</h2>
            <label class="role-picker">提交人
              <input v-model="confirmBy" style="border:0;background:transparent;font-weight:700;outline:none;width:110px" />
            </label>
          </div>
          <p class="muted" style="margin:0 0 14px">两人同时提交同一场时，同一帧内先调用者先入账生效，后到者只拿到冲突编号、不改状态。</p>
          <div class="confirm-grid">
            <article v-for="scene in storyScenes" :key="scene.id" class="confirm-card">
              <div>
                <b>{{ scene.code }} {{ scene.title }}</b>
                <small class="muted">剧情 #{{ scene.storyNo }} · {{ scene.day }}</small>
              </div>
              <template v-if="continuity.winnerOf(scene.id)">
                <div class="winner-box">✓ 已入账：{{ continuity.winnerOf(scene.id)?.by }}<small>{{ dayjs(continuity.winnerOf(scene.id)?.at).format("MM-DD HH:mm:ss") }}</small></div>
              </template>
              <div class="actions">
                <button class="primary" :disabled="!!continuity.winnerOf(scene.id)" @click="doConfirm(scene)">确认场次</button>
                <button class="secondary" :disabled="!!continuity.winnerOf(scene.id)" @click="concurrentConfirm(scene)">甲乙同帧提交</button>
              </div>
            </article>
          </div>
        </section>

        <section class="panel" style="margin-top:18px">
          <div class="panel-head"><h2>冲突编号台账</h2><span class="status">{{ continuity.confirmConflicts.length }} 条</span></div>
          <el-empty v-if="!continuity.confirmConflicts.length" description="尚无同场确认冲突" />
          <div v-for="c in continuity.confirmConflicts" :key="c.id" class="conflict">
            <span class="seal">{{ c.id }}</span>
            <div>
              <b>{{ continuity.sceneName(c.sceneId) }}</b>
              <p>{{ c.message }}</p>
              <small>{{ dayjs(c.at).format("MM-DD HH:mm:ss") }} · 胜方令牌 {{ c.winnerToken.slice(0, 8) }}… / 负方令牌 {{ c.loserToken.slice(0, 8) }}…<em v-if="c.fromRetry">（迟到重试）</em></small>
            </div>
          </div>
        </section>
      </el-tab-pane>

      <!-- ============ 写入失败重试队列 ============ -->
      <el-tab-pane :label="`重试队列${pendingRetries.length ? `（${pendingRetries.length}）` : ''}`" name="retry">
        <section class="panel">
          <div class="panel-head">
            <h2>写入通道与重试</h2>
            <div class="actions">
              <label class="role-picker">通道
                <el-switch v-model="channelOnline" active-text="在线" inactive-text="中断" />
              </label>
              <button class="secondary" @click="continuity.armWriteFailure(); ElMessage.info('下一次写入将失败并入队')">模拟下一次写入失败</button>
              <button class="primary" :disabled="!pendingRetries.length" @click="retryAll">全部重放</button>
            </div>
          </div>
          <p class="muted" style="margin:0 0 14px">通道中断时，收尾回传/场次确认写入失败会带原始幂等令牌进入队列；恢复后重放，重复回传不生成第二份交接，迟到的同场确认转为冲突编号。</p>
          <el-empty v-if="!continuity.retries.length" description="队列为空：先断开通道或模拟失败，再提交回传/确认" />
          <div v-for="job in continuity.retries" :key="job.id" class="retry-row" :class="job.status">
            <span class="dept-tag">{{ job.kind }}</span>
            <div class="derived-body">
              <b>{{ continuity.sceneName(job.sceneId) }}<template v-if="job.talentId"> · {{ continuity.talentName(job.talentId) }}</template> · {{ job.by }}</b>
              <small>{{ job.lastError }} · 已尝试 {{ job.attempts }} 次 · 令牌 {{ job.token.slice(0, 8) }}… · {{ dayjs(job.queuedAt).format("MM-DD HH:mm:ss") }}</small>
            </div>
            <span class="state-pill" :class="job.status === '待重试' ? '已失效' : job.status === '重试冲突' ? '已失效' : '已交接'">{{ job.status }}</span>
            <div class="actions">
              <button v-if="job.status === '待重试'" class="primary" @click="retryOne(job.id)">重试</button>
              <button v-if="job.status === '待重试'" class="secondary" @click="continuity.discardRetry(job.id)">丢弃</button>
            </div>
          </div>
        </section>

        <section class="panel" style="margin-top:18px">
          <div class="panel-head"><h2>幂等处理记录</h2><small class="muted">同一令牌只产生一次效果</small></div>
          <div class="history">
            <el-empty v-if="!continuity.processed.length" description="暂无入账记录" />
            <div v-for="p in continuity.processed.slice(0, 30)" :key="p.token" class="history-row">
              <span class="muted">{{ dayjs(p.at).format("MM-DD HH:mm:ss") }}</span>
              <b>{{ p.kind }}</b>
              <span>{{ p.outcome }} · {{ p.refId.slice(0, 14) }} · {{ p.token.slice(0, 8) }}…</span>
            </div>
          </div>
        </section>
      </el-tab-pane>
    </el-tabs>
  </section>
</template>
