<script setup lang="ts">
import { computed } from "vue";
import dayjs from "dayjs";
import { ElMessage } from "element-plus";
import { useScheduleStore } from "../stores/schedule";
import { useContinuityStore } from "../stores/continuity";
import type { Handover, Look, RetryItem, Scene } from "../types";

const store = useScheduleStore();
const ledger = useContinuityStore();

const storyScenes = computed(() => [...store.scenes].sort((a, b) => a.storyOrder - b.storyOrder));
const shootScenes = computed(() => store.sortedScenes);

const otherRole = computed(() => (store.role === "场记" ? "导演" : "场记"));

function sceneById(id: string): Scene | undefined {
  return store.scenes.find((s) => s.id === id);
}

function lookOf(sceneId: string, talentId: string): Look | undefined {
  return ledger.findLook(sceneId, talentId);
}

function propsText(look: Look): string {
  return look.props.join("、");
}

function onPropsInput(look: Look, event: Event) {
  const value = (event.target as HTMLInputElement).value;
  look.props = value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
}

function onConfirm(look: Look, actor: string) {
  const res = ledger.confirmLook(look.sceneId, look.talentId, actor, look.version);
  if (res.ok) {
    ElMessage.success(`${actor} 已确认造型（${store.sceneCode(look.sceneId)} / ${store.talentName(look.talentId)}）`);
  } else if (res.conflict) {
    ElMessage.warning(`冲突编号 ${res.conflict.id}：${res.conflict.reason}`);
  } else if (res.retry) {
    ElMessage.info(`写入失败已入重试队列：${res.retry.error}`);
  }
}

function onComplete(h: Handover) {
  const res = ledger.completeHandover(h.key, store.role);
  if (res.ok && res.duplicate) {
    ElMessage.info(`重复回传：交接已存在，未生成第二份（幂等键 ${h.key}）`);
  } else if (res.ok) {
    ElMessage.success(`交接已完成：${store.sceneCode(h.fromSceneId)} → ${store.sceneCode(h.toSceneId)}`);
  } else if (res.retry) {
    ElMessage.info(`写入失败已入重试队列：${res.retry.error}`);
  }
}

function onDuplicate(h: Handover) {
  const res = ledger.duplicateCallback(h.key, store.role);
  if (res.first.ok && res.second.ok && res.second.duplicate) {
    ElMessage.success(`重复回传未生成第二份交接（幂等键 ${h.key}）`);
  } else {
    ElMessage.info(`第一次：${res.first.ok ? "成功" : "失败入队"}；第二次：${res.second.ok ? (res.second.duplicate ? "成功(去重)" : "成功") : "失败入队"}`);
  }
}

function onRetry(item: RetryItem) {
  ledger.retryItem(item.id, store.role);
  ElMessage.success(`已按幂等键重放：${item.targetKey}`);
}

function fmt(iso: string | null): string {
  return iso ? dayjs(iso).format("MM-DD HH:mm:ss") : "—";
}
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article class="metric"><span>造型记录</span><strong>{{ ledger.looks.length }}</strong></article>
      <article class="metric"><span>待补交接（跳拍）</span><strong>{{ ledger.pendingHandovers.length }}</strong></article>
      <article class="metric"><span>已完成交接</span><strong>{{ ledger.completedHandovers.length }}</strong></article>
      <article class="metric"><span>冲突编号 / 重试队列</span><strong>{{ ledger.conflicts.length }} / {{ ledger.retryQueue.filter((r) => r.status === "待重试").length }}</strong></article>
    </div>

    <div class="panel ledger-note">
      <p>剧组按<strong>剧情序</strong>备服装、化妆、道具，实际通告常<strong>跳拍</strong>。同一角色在剧情相邻场之间保留上一场收尾状态；跳拍时列出<strong>待补交接</strong>。场次拍摄日、演员或器材一改，依赖它的准备与转场占用立即失效重算，<strong>已开拍场次留着现场</strong>。</p>
      <div class="ledger-actions">
        <label class="fail-switch"><el-switch v-model="ledger.forceFail" /> 模拟下次写入失败（验证重试队列）</label>
      </div>
    </div>

    <section class="panel">
      <div class="panel-head">
        <div><h2>造型连续性账</h2><small class="muted">按剧情序排列，每场每角色记录服装/化妆/道具与收尾状态；确认走乐观并发，先入账生效</small></div>
      </div>
      <div v-for="scene in storyScenes" :key="scene.id" class="look-scene">
        <div class="look-scene-head">
          <b class="seq">{{ scene.storyOrder }}</b>
          <strong>{{ scene.code }}</strong>
          <span>{{ scene.title }}</span>
          <small class="muted">拍摄 {{ scene.day }} {{ scene.start }} · {{ store.locationName(scene.locationId) }}</small>
          <span v-if="scene.status === '拍摄中' || scene.status === '已完成'" class="status 已完成">已开拍·留现场</span>
        </div>
        <div class="look-grid">
          <article v-for="tid in scene.talentIds" :key="tid" class="look-card" :class="{ invalid: lookOf(scene.id, tid)?.invalid }">
            <header>
              <b>{{ store.talentName(tid) }}</b>
              <span class="muted">{{ store.talents.find((t) => t.id === tid)?.role }}</span>
              <span v-if="lookOf(scene.id, tid)?.invalid" class="badge invalid">已失效·待重算</span>
              <span v-else-if="lookOf(scene.id, tid)?.status === '已确认'" class="badge ok">已确认</span>
              <span v-else class="badge">待定</span>
            </header>
            <label class="field"><span>服装</span><input v-model="lookOf(scene.id, tid)!.costume" placeholder="如：灰色风衣" /></label>
            <label class="field"><span>化妆</span><input v-model="lookOf(scene.id, tid)!.makeup" placeholder="如：右颊擦伤妆" /></label>
            <label class="field"><span>道具</span><input :value="propsText(lookOf(scene.id, tid)!)" @input="onPropsInput(lookOf(scene.id, tid)!, $event)" placeholder="如：旧行李箱、信封" /></label>
            <label class="field"><span>收尾状态（传下一场）</span><input v-model="lookOf(scene.id, tid)!.endingState" placeholder="如：风衣淋雨湿透" /></label>
            <footer>
              <small class="muted">{{ lookOf(scene.id, tid)?.confirmedBy ? `${lookOf(scene.id, tid)?.confirmedBy} · ${fmt(lookOf(scene.id, tid)?.confirmedAt ?? null)}` : "未确认" }} · v{{ lookOf(scene.id, tid)?.version }}</small>
              <div class="actions">
                <button class="primary" @click="onConfirm(lookOf(scene.id, tid)!, store.role)">确认造型</button>
                <button class="secondary" @click="onConfirm(lookOf(scene.id, tid)!, otherRole)">模拟{{ otherRole }}同时确认</button>
              </div>
            </footer>
          </article>
        </div>
      </div>
      <el-empty v-if="!storyScenes.length" description="暂无场次" />
    </section>

    <section class="panel">
      <div class="panel-head">
        <div><h2>交接账</h2><small class="muted">剧情相邻同角色场次之间的素材交接；幂等键去重，重复回传不生成第二份</small></div>
        <span class="status">{{ ledger.handovers.length }} 笔</span>
      </div>
      <div class="handover-list">
        <article v-for="h in ledger.handovers" :key="h.key" class="handover" :class="{ invalid: h.invalid, done: h.status === '已完成' }">
          <div class="handover-flow">
            <b>{{ store.sceneCode(h.fromSceneId) }}</b>
            <span class="arrow">→</span>
            <b>{{ store.sceneCode(h.toSceneId) }}</b>
            <span class="talent">{{ store.talentName(h.talentId) }}</span>
          </div>
          <div class="handover-mat">
            <small>服装：{{ h.materials.costume }} · 化妆：{{ h.materials.makeup }} · 道具：{{ h.materials.props.join("、") || "无" }}</small>
          </div>
          <p class="handover-reason">{{ h.reason }}</p>
          <div class="handover-foot">
            <span v-if="h.invalid" class="badge invalid">已失效·重算中</span>
            <span v-else-if="h.status === '已完成'" class="badge ok">已完成 · {{ fmt(h.completedAt) }}</span>
            <span v-else class="badge pending">待补</span>
            <code class="key">{{ h.key }}</code>
          </div>
          <div class="actions">
            <button v-if="h.status === '待补'" class="primary" @click="onComplete(h)">完成交接</button>
            <button v-if="h.status === '待补'" class="secondary" @click="onDuplicate(h)">重复回传回调</button>
          </div>
        </article>
      </div>
      <el-empty v-if="!ledger.handovers.length" description="暂无交接记录" />
    </section>

    <section class="panel">
      <div class="panel-head"><div><h2>待补交接（跳拍）</h2><small class="muted">上一场未开拍或拍摄顺序颠倒，收尾状态无法在现场直接交接</small></div></div>
      <el-empty v-if="!ledger.pendingHandovers.length" description="没有待补交接" />
      <article v-for="h in ledger.pendingHandovers" :key="h.key" class="conflict">
        <span class="seal">待补</span>
        <div>
          <b>{{ store.sceneCode(h.fromSceneId) }} → {{ store.sceneCode(h.toSceneId) }} · {{ store.talentName(h.talentId) }}</b>
          <p>{{ h.reason }}</p>
          <small>服装：{{ h.materials.costume }} · 化妆：{{ h.materials.makeup }} · 道具：{{ h.materials.props.join("、") || "无" }}</small>
        </div>
      </article>
    </section>

    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><div><h2>冲突编号</h2><small class="muted">两人同时确认同一场，先入账生效，后到拿到冲突编号</small></div></div>
        <el-empty v-if="!ledger.conflicts.length" description="暂无并发冲突" />
        <article v-for="c in ledger.conflicts" :key="c.id" class="conflict">
          <span class="seal">{{ c.id }}</span>
          <div>
            <b>{{ c.winner }} 先入账 · {{ c.loser }} 后到</b>
            <p>{{ c.reason }}</p>
            <small>{{ store.sceneCode(c.sceneId) }} / {{ store.talentName(c.talentId) }} · {{ fmt(c.time) }}</small>
          </div>
        </article>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>重试队列</h2><small class="muted">写入失败后留待重试，按幂等键重放不生成第二份</small></div></div>
        <el-empty v-if="!ledger.retryQueue.length" description="重试队列为空" />
        <article v-for="item in ledger.retryQueue" :key="item.id" class="conflict">
          <span class="seal">{{ item.status }}</span>
          <div>
            <b>{{ item.targetType }} · {{ item.targetKey }}</b>
            <p>{{ item.error }}</p>
            <small>已尝试 {{ item.attempts }} 次 · {{ fmt(item.updatedAt) }}</small>
          </div>
          <button v-if="item.status === '待重试'" class="secondary" @click="onRetry(item)">重试</button>
        </article>
      </section>
    </div>

    <section class="panel">
      <div class="panel-head"><div><h2>剧情序 vs 拍摄序</h2><small class="muted">剧情序决定造型交接，拍摄序决定是否跳拍与转场占用</small></div></div>
      <div class="order-grid">
        <div>
          <h3>剧情序</h3>
          <ol>
            <li v-for="s in storyScenes" :key="s.id"><b>{{ s.code }}</b> {{ s.title }} <small class="muted">第 {{ s.storyOrder }} 场</small></li>
          </ol>
        </div>
        <div>
          <h3>拍摄序</h3>
          <ol>
            <li v-for="s in shootScenes" :key="s.id"><b>{{ s.code }}</b> {{ s.title }} <small class="muted">{{ s.day }} {{ s.start }}</small></li>
          </ol>
        </div>
      </div>
    </section>
  </section>
</template>

<style scoped>
.ledger-note p { margin: 0 0 12px; line-height: 1.7; color: var(--ink); }
.ledger-actions { display: flex; gap: 16px; align-items: center; }
.fail-switch { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink); }
.look-scene { border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-bottom: 14px; background: #fbfcfe; }
.look-scene-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.look-scene-head .seq { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 8px; background: var(--navy); color: #fff; }
.look-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
.look-card { border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: #fff; display: grid; gap: 8px; }
.look-card.invalid { border-color: #e8a0a0; background: #fff8f8; }
.look-card header { display: flex; align-items: center; gap: 8px; }
.look-card header .muted { font-size: 12px; }
.look-card footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.badge { font-size: 11px; padding: 2px 7px; border-radius: 99px; background: #e8edf4; color: var(--muted); }
.badge.ok { background: #dff3e8; color: #19704b; }
.badge.pending { background: #fff0d4; color: #96600d; }
.badge.invalid { background: #fbdada; color: #a02626; }
.handover-list { display: grid; gap: 10px; }
.handover { border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: #fbfcfe; display: grid; gap: 6px; }
.handover.done { border-color: #bfe3cf; background: #f4fbf7; }
.handover.invalid { border-color: #e8a0a0; background: #fff8f8; }
.handover-flow { display: flex; align-items: center; gap: 8px; }
.handover-flow .arrow { color: var(--accent); font-weight: 800; }
.handover-flow .talent { margin-left: auto; font-size: 13px; color: var(--muted); }
.handover-mat small { color: var(--muted); }
.handover-reason { margin: 0; font-size: 13px; color: var(--ink); }
.handover-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.handover-foot .key { font-size: 11px; color: var(--muted); background: #eef1f6; padding: 2px 6px; border-radius: 6px; }
.order-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.order-grid h3 { margin: 0 0 8px; font-size: 15px; }
.order-grid ol { margin: 0; padding-left: 20px; display: grid; gap: 6px; }
@media (max-width: 680px) { .order-grid { grid-template-columns: 1fr; } }
</style>
