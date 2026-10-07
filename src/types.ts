export type Role = "制片" | "导演" | "演员统筹" | "场记";
export type SceneStatus = "草稿" | "已确认" | "拍摄中" | "已完成";
export type ConflictType = "演员档期" | "场地占用" | "器材借用" | "转场时间";

export interface Talent {
  id: string;
  name: string;
  role: string;
}

export interface Location {
  id: string;
  name: string;
}

export interface Equipment {
  id: string;
  name: string;
}

export interface Scene {
  id: string;
  code: string;
  title: string;
  /** 剧情序（剧本场次顺序），与拍摄日顺序可能不一致（跳拍） */
  storyNo: number;
  day: string;
  start: string;
  end: string;
  talentIds: string[];
  locationId: string;
  equipmentIds: string[];
  status: SceneStatus;
  locked: boolean;
}

export interface Conflict {
  id: string;
  type: ConflictType;
  sceneIds: string[];
  message: string;
  severity: "高" | "中";
}

export interface HistoryEntry {
  id: string;
  action: string;
  detail: string;
  time: string;
}

export interface Version {
  id: string;
  name: string;
  time: string;
  scenes: Scene[];
}

export interface OfflineDraft {
  scenes: Scene[];
  savedAt: string;
}

/* ============ 连续性账 ============ */

export type Dept = "服装" | "化妆" | "道具" | "器材";

/** 造型规格：服装、化妆、道具（一个角色在场内的完整造型描述） */
export interface LookSpec {
  costume: string;
  makeup: string;
  props: string[];
}

/** 某角色在某场的造型账：左栏是剧情设定，右栏是现场收尾实际状态 */
export interface SceneLook {
  sceneId: string;
  talentId: string;
  planned: LookSpec;
  ending?: LookSpec;
  endingAt?: string;
  /** 最近一次成功入账的回传幂等键 */
  endingToken?: string;
}

export type HandoffState = "待补交接" | "已交接";

/**
 * 素材交接：同一角色在剧情相邻两场之间，
 * 下一场开场必须承接上一场收尾状态；上一场未回传则列为待补交接。
 */
export interface Handoff {
  id: string;
  fromSceneId: string;
  toSceneId: string;
  talentId: string;
  /** 承接的收尾状态；待补时为 null */
  carry: LookSpec | null;
  state: HandoffState;
  reason?: string;
  revision: number;
}

export type DerivedState = "有效" | "已失效" | "现场保留";

/** 准备单：由剧情序、交接和通告派生 */
export interface PrepTask {
  id: string;
  /** 逻辑键：同一张准备单跨版本的稳定身份 */
  key: string;
  sceneId: string;
  talentId?: string;
  equipmentId?: string;
  dept: Dept;
  instruction: string;
  /** 依赖的交接/场次，依赖源一变即失效重算 */
  dependsOn: string[];
  state: DerivedState;
  revision: number;
  invalidReason?: string;
  /** 场次已开拍后冻结，留着现场，不再重算 */
  frozen: boolean;
  createdAt: string;
  /** 依赖指纹：指纹变化即失效重算 */
  fingerprint?: string;
}

/** 转场占用：同一拍摄日相邻通告、共享演员或器材时占用的转场窗口 */
export interface TransferOccupation {
  id: string;
  key: string;
  fromSceneId: string;
  toSceneId: string;
  day: string;
  windowStart: string;
  windowEnd: string;
  minutes: number;
  sharedTalentIds: string[];
  sharedEquipmentIds: string[];
  sameLocation: boolean;
  note: string;
  state: DerivedState;
  revision: number;
  invalidReason?: string;
  frozen: boolean;
  createdAt: string;
  fingerprint?: string;
}

/** 场次确认入账记录（先入账者生效） */
export interface Confirmation {
  id: string;
  sceneId: string;
  by: string;
  at: string;
  token: string;
}

/** 同场确认冲突：后到者拿到冲突编号 */
export interface ConfirmationConflict {
  id: string;
  sceneId: string;
  winnerBy: string;
  winnerToken: string;
  loserBy: string;
  loserToken: string;
  at: string;
  message: string;
  /** 来自失败重试后的迟到入账 */
  fromRetry: boolean;
}

export type RetryKind = "造型回传" | "场次确认";
export type RetryStatus = "待重试" | "重试成功" | "重试冲突";

/** 写入失败后的重试队列 */
export interface RetryJob {
  id: string;
  kind: RetryKind;
  sceneId: string;
  talentId?: string;
  by?: string;
  /** 幂等键：重复回传/重试不会生成第二份交接或第二份入账 */
  token: string;
  payload?: LookSpec;
  attempts: number;
  lastError: string;
  queuedAt: string;
  status: RetryStatus;
  finishedAt?: string;
}

/** 已处理幂等键账本 */
export interface ProcessedToken {
  token: string;
  kind: RetryKind;
  outcome: "已入账" | "重复忽略" | "冲突拒登";
  refId: string;
  at: string;
}
