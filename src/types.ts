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
  storyOrder: number;
  day: string;
  start: string;
  end: string;
  talentIds: string[];
  locationId: string;
  equipmentIds: string[];
  status: SceneStatus;
  locked: boolean;
}

/** 造型：某场次某角色的服装/化妆/道具与收尾状态 */
export interface Look {
  id: string;
  sceneId: string;
  talentId: string;
  costume: string;
  makeup: string;
  props: string[];
  /** 收尾状态：上一场收尾 → 下一场开场 */
  endingState: string;
  status: "待定" | "已确认";
  /** 乐观并发版本号：先入账生效，后到凭版本号发冲突编号 */
  version: number;
  confirmedBy: string | null;
  confirmedAt: string | null;
  /** 依赖失效标记：场次拍摄日/演员/器材一改，未开拍场次的造型需重算 */
  invalid: boolean;
  updatedAt: string;
}

/** 交接：剧情相邻同角色场次之间的素材交接，key 为幂等键，重复回传不生成第二份 */
export interface Handover {
  id: string;
  /** 幂等键：`${fromSceneId}:${toSceneId}:${talentId}` */
  key: string;
  fromSceneId: string;
  toSceneId: string;
  talentId: string;
  materials: { costume: string; makeup: string; props: string[] };
  /** 待补=跳拍或上一场未拍；已完成=按序拍摄可交接 */
  status: "待补" | "已完成";
  reason: string;
  invalid: boolean;
  version: number;
  completedAt: string | null;
  createdAt: string;
}

/** 并发确认冲突：两人同时确认同一场，先入账生效，后到拿到冲突编号 */
export interface ConfirmationConflict {
  id: string;
  targetType: "look" | "handover";
  targetKey: string;
  sceneId: string;
  talentId: string;
  winner: string;
  loser: string;
  reason: string;
  time: string;
}

/** 重试队列：写入失败后留待重试，重复回传不生成第二份交接 */
export interface RetryItem {
  id: string;
  targetType: "look" | "handover";
  targetKey: string;
  payload: Record<string, unknown>;
  error: string;
  attempts: number;
  status: "待重试" | "已重试" | "已放弃";
  createdAt: string;
  updatedAt: string;
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
