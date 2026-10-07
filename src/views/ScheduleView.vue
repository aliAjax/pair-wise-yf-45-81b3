<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import dayjs from "dayjs";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useScheduleStore } from "../stores/schedule";
import { useContinuityStore } from "../stores/continuity";
import type { Scene, SceneStatus } from "../types";

const store = useScheduleStore();
const continuity = useContinuityStore();
const saving = ref(false);
const dragging = ref<number | null>(null);
const editing = ref<Scene | null>(null);
const editVisible = ref(false);
const form = reactive({ code: "", title: "", storyNo: 1, day: "2026-10-08", start: "08:00", end: "10:00", locationId: "l1", talentIds: [] as string[], equipmentIds: [] as string[] });
const editForm = reactive({ code: "", title: "", storyNo: 1, day: "", start: "", end: "", locationId: "", talentIds: [] as string[], equipmentIds: [] as string[] });
const schema = toTypedSchema(z.object({
  code: z.string().min(2, "请输入场次编号"),
  title: z.string().min(2, "请输入场次名称"),
  storyNo: z.coerce.number().int().positive("剧情序需为正整数"),
  day: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  locationId: z.string().min(1)
}));
const { errors, validate } = useForm({ validationSchema: schema });
const editable = computed(() => store.role === "制片" || store.role === "导演");
const currentStatus = (status: string) => status as SceneStatus;

onMounted(() => store.loadDraft());

async function submit() {
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  saving.value = true;
  store.addScene({ code: form.code, title: form.title, storyNo: Number(form.storyNo), day: form.day, start: form.start, end: form.end, locationId: form.locationId, talentIds: [...form.talentIds], equipmentIds: [...form.equipmentIds] });
  Object.assign(form, { code: "", title: "", storyNo: (store.scenes.length + 1), day: "2026-10-08", start: "08:00", end: "10:00", locationId: "l1", talentIds: [], equipmentIds: [] });
  setTimeout(() => { saving.value = false; }, 240);
}

function drop(index: number) {
  if (dragging.value !== null && editable.value) store.moveScene(dragging.value, index);
  dragging.value = null;
}

function openEdit(scene: Scene) {
  editing.value = scene;
  editVisible.value = true;
  Object.assign(editForm, { code: scene.code, title: scene.title, storyNo: scene.storyNo, day: scene.day, start: scene.start, end: scene.end, locationId: scene.locationId, talentIds: [...scene.talentIds], equipmentIds: [...scene.equipmentIds] });
}

function saveEdit() {
  if (!editing.value) return;
  store.editScene(editing.value.id, {
    code: editForm.code,
    title: editForm.title,
    storyNo: Number(editForm.storyNo),
    day: editForm.day,
    start: editForm.start,
    end: editForm.end,
    locationId: editForm.locationId,
    talentIds: [...editForm.talentIds],
    equipmentIds: [...editForm.equipmentIds]
  });
  editing.value = null;
  editVisible.value = false;
}

function winner(sceneId: string) {
  return continuity.winnerOf(sceneId);
}
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article class="metric"><span>通告场次</span><strong>{{ store.scenes.length }}</strong></article>
      <article class="metric"><span>待补交接</span><strong>{{ continuity.pendingHandoffs.length }}</strong></article>
      <article class="metric"><span>已确认</span><strong>{{ store.scenes.filter((item: Scene) => item.status === '已确认').length }}</strong></article>
      <article class="metric"><span>重试队列</span><strong>{{ continuity.retries.filter((r) => r.status === '待重试').length }}</strong></article>
    </div>
    <div v-if="store.draft" class="draft-banner">
      <span>发现 {{ dayjs(store.draft.savedAt).format("MM-DD HH:mm") }} 的离线草稿，共 {{ store.draft.scenes.length }} 个场次。</span>
      <div class="actions"><button class="secondary" @click="store.syncDraft">同步到正式通告</button></div>
    </div>
    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2>新增场次</h2><button class="secondary" @click="store.saveDraft">保存离线草稿</button></div>
        <form class="form-grid" @submit.prevent="submit">
          <label class="field"><span>场次编号</span><input v-model="form.code" placeholder="C-018" /><small>{{ errors.code }}</small></label>
          <label class="field"><span>场次名称</span><input v-model="form.title" placeholder="例如：雨夜追踪" /><small>{{ errors.title }}</small></label>
          <label class="field"><span>剧情序（剧本顺序）</span><input v-model.number="form.storyNo" type="number" min="1" /><small>{{ errors.storyNo }}</small></label>
          <label class="field"><span>拍摄日</span><input v-model="form.day" type="date" /></label>
          <label class="field"><span>场地</span><select v-model="form.locationId"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <label class="field"><span>开始 / 结束</span><div class="time-range"><input v-model="form.start" type="time" /><input v-model="form.end" type="time" /></div></label>
          <label class="field wide"><span>演员档期</span><select v-model="form.talentIds" multiple><option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }} · {{ item.role }}</option></select></label>
          <label class="field wide"><span>器材借用</span><select v-model="form.equipmentIds" multiple><option v-for="item in store.equipment" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <div class="actions wide"><button class="primary" :disabled="saving || !editable">保存为草稿</button><RouterLink class="secondary" to="/continuity">连续性账</RouterLink><RouterLink class="secondary" to="/conflicts">检查冲突</RouterLink></div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>拍摄通告顺序</h2><small class="muted">按拍摄日排列；括号内为剧情序，跳拍时连续性账会列出待补交接</small></div><button class="primary" :disabled="!editable" @click="store.snapshot()">保存版本</button></div>
        <div class="scene-list">
          <article v-for="(scene,index) in store.sortedScenes" :key="scene.id" class="scene" :class="{ locked: scene.locked, dragging: dragging === index, shooting: scene.status === '拍摄中' || scene.status === '已完成' }" draggable="true" @dragstart="dragging=index" @dragover.prevent @drop="drop(index)">
            <b>{{ index + 1 }}</b>
            <div class="scene-code">{{ scene.code }}<small class="story-no">剧情 #{{ scene.storyNo }}</small></div>
            <div class="scene-title"><b>{{ scene.title }}</b><small>{{ scene.day }} {{ scene.start }}–{{ scene.end }} · {{ store.locationName(scene.locationId) }}</small></div>
            <span class="status" :class="scene.status">{{ scene.status }}</span>
            <div class="actions">
              <button class="secondary" :disabled="!editable || scene.locked" @click="store.updateStatus(scene.id, currentStatus(scene.status === '草稿' ? '已确认' : scene.status === '已确认' ? '拍摄中' : scene.status === '拍摄中' ? '已完成' : '已完成'))">推进</button>
              <button class="secondary" :disabled="!editable" @click="openEdit(scene)">改通告</button>
              <button class="secondary" :disabled="!editable" @click="store.toggleLock(scene.id)">{{ scene.locked ? "解锁" : "锁定" }}</button>
            </div>
            <div class="scene-meta wide">
              <small>演员：{{ store.talentNames(scene.talentIds).join("、") || "待定" }} · 器材：{{ store.equipmentNames(scene.equipmentIds).join("、") || "无" }}</small>
              <small v-if="winner(scene.id)" class="winner">✓ {{ winner(scene.id)?.by }} 已确认入账（{{ dayjs(winner(scene.id)?.at).format("HH:mm:ss") }}）</small>
            </div>
          </article>
        </div>
      </section>
    </div>

    <el-dialog v-model="editVisible" :title="`改通告：${editForm.code}`" width="560px" @closed="editing = null">
      <div class="form-grid">
        <label class="field"><span>场次编号</span><input v-model="editForm.code" /></label>
        <label class="field"><span>场次名称</span><input v-model="editForm.title" /></label>
        <label class="field"><span>剧情序</span><input v-model.number="editForm.storyNo" type="number" min="1" /></label>
        <label class="field"><span>拍摄日</span><input v-model="editForm.day" type="date" /></label>
        <label class="field"><span>场地</span><select v-model="editForm.locationId"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
        <label class="field"><span>开始 / 结束</span><div class="time-range"><input v-model="editForm.start" type="time" /><input v-model="editForm.end" type="time" /></div></label>
        <label class="field wide"><span>演员档期（改派会使准备单失效重算）</span><select v-model="editForm.talentIds" multiple><option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }} · {{ item.role }}</option></select></label>
        <label class="field wide"><span>器材借用</span><select v-model="editForm.equipmentIds" multiple><option v-for="item in store.equipment" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      </div>
      <template #footer>
        <div class="actions">
          <button class="secondary" @click="editing = null">取消</button>
          <button class="primary" @click="saveEdit">保存并重算依赖</button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>
