import { z } from 'zod';

const nonEmpty = z.string().refine(value => value.trim().length > 0, 'Must contain non-whitespace text');
const sourceIds = z.array(nonEmpty).min(1).describe(
  '当前用户 languageStyleLearning.sources 中实际存在的来源逻辑编号；不编造消息 ID、外部文件路径或内容哈希。',
);
const optionalNotes = (description: string) => z.array(nonEmpty).optional().describe(description);

export const languageStyleSourceKinds = [
  'author', 'oral', 'correction', 'external', 'preference', 'unknown', 'adopted-ai',
] as const;

/** Full source entries are validated even when the enclosing memory update is partial. */
export const languageStyleSourceSchema = z.object({
  sourceId: nonEmpty.describe('当前用户内部沿用的稳定来源编号，不冒充脚本生成的 SHA256 或服务器分配的消息 ID。'),
  kind: z.enum(languageStyleSourceKinds).describe(
    '本人样文、自然口述、本人改稿、外部参考、明确长期要求、来源未知或明确认领的 AI 表达；材料入库不等于习惯生效。',
  ),
  scope: nonEmpty.describe('用户实际授权保存和学习的文体、交流对象、场景及材料范围。'),
  sourceNote: nonEmpty.describe('来源身份、用途和实际授权依据；背景材料说明已知／推演／目标，不能将报告措辞当本人习惯。'),
  lineage: nonEmpty.describe('同一原稿及其连续修改沿用同源组，不将同稿变体算作独立样本；未实现自动证据计数。'),
  originalText: nonEmpty.describe('本次实际获准的完整原文或明确获准的原文片段，逐字保留，不以摘要、助手重写或伪造内容代替。'),
  beforeText: nonEmpty.optional().describe('仅 correction 保存对应修改前的完整原文；其他来源类型不填写。'),
  adoptionNote: nonEmpty.optional().describe('仅 adopted-ai 保存用户明确认领这一范围 AI 表达的依据；一般赞同不等于认领整篇。'),
}).strict().superRefine((source, context) => {
  if ((source.kind === 'correction') !== (source.beforeText !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['beforeText'], message: 'Only correction sources require and accept beforeText' });
  }
  if ((source.kind === 'adopted-ai') !== (source.adoptionNote !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['adoptionNote'], message: 'Only adopted-ai sources require and accept adoptionNote' });
  }
});

const backgroundNote = z.object({
  content: nonEmpty.describe('仅记录会影响用语选择且有依据的经验、概念熟悉度或交流环境；不推断阶层、学历或永久口吻。'),
  sourceIds,
  scope: nonEmpty.optional().describe('该背景理解的真实适用范围，未知不补造。'),
});

const preferenceFields = {
  id: nonEmpty.describe('当前用户稳定的表达偏好逻辑编号；修改和停用沿用编号，不制造历史版本。'),
  basis: z.enum(['observed_habit', 'target_preference']).describe('实际观察的本人习惯与明确采用的目标偏好分开；外部和 AI 参考不冒充本人历史习惯。'),
  type: z.enum(['wording', 'avoidance', 'local_syntax']).describe('仅措辞选择、明确避用和局部句法，不设定主题、观点、案例、结构、归因或结论。'),
  expression: nonEmpty.describe('保持同一意思的具体表达选择，可保留必要词／短语／选择对，不放整句样文、故事或证据分析。'),
  scope: nonEmpty.describe('实际支持的文体、交流对象和情境；本篇要求不擅自推广为永久规则。'),
  sourceIds,
  exceptions: optionalNotes('仅实际存在的范围差异和例外；必要术语、直接引文及本轮明确要求优先，不机械替换词。'),
};

const activePreference = z.object({
  ...preferenceFields,
  status: z.literal('active').describe('当前可用的表达依据；有效性与采用判断仍依赖实际材料和用户授权，不由模型凭空认定。'),
});

export const languageStyleProfileSchema = z.object({
  authorAndScope: nonEmpty.optional().describe('当前认证用户的作者、账号和适用范围说明；不改变 Resource 身份，同一用户当前只有一份风格。'),
  languageWorld: z.object({
    knownBackground: z.array(backgroundNote).optional().describe('用户明确提供或有来源的背景；知道、理解、引用过一个词不代表主动使用。'),
    tentativeUnderstanding: z.array(backgroundNote).optional().describe('有依据但仍暂定的理解，仅柔性辅助准确表达，不能升级为事实或强制规则。'),
    goals: z.array(backgroundNote).optional().describe('用户的未来表达目标和愿望，不当作已发生事实或已观察习惯。'),
  }).optional().describe('简短语言世界，已知／暂定／目标分开；缺少维度不凑人物画像。'),
  activePreferences: z.array(activePreference).optional().describe(
    '仅保存当前有效的本人习惯和目标偏好。候选、停用、替代分析另放学习记录；数组整体替换，保留无关有效条目。',
  ),
  scenarioDifferences: z.array(z.object({
    scope: nonEmpty,
    instruction: nonEmpty.describe('实际存在且会影响文字选择的场景差异，不为每种身份虚构一种模式。'),
    sourceIds,
  })).optional(),
  sourceIndex: z.array(z.object({
    sourceId: nonEmpty,
    lineage: nonEmpty,
    kind: z.enum(languageStyleSourceKinds),
    purpose: nonEmpty.describe('来源在当前档案中的实际用途和授权范围；对应 Learning.sources 的真实条目。'),
  })).optional().describe('真实来源索引，不假称有未接入的文件检索、不可变版本库或学习工具。'),
}).optional().describe(
  '当前用户的唯一有效语言风格档案。普通应用只使用相关背景与有效表达偏好；不从样文带入主题或观点，不默认更新记忆。'
  + '独立开头、道具和内容升华不使用本档案；情境仅在其允许的台词范围应用。',
);

const evidenceComparison = z.object({
  before: nonEmpty,
  after: nonEmpty,
  analysis: nonEmpty.describe('说明是否保持原意、真正改变的表达及适用范围；事实或观点修正不能伪装为风格。'),
});

const observation = z.object({
  ...preferenceFields,
  status: z.enum(['candidate', 'inactive', 'superseded']),
  reason: nonEmpty.describe('候选、停用或被替代的实际原因及用户决定，保留原依据。'),
  supersededBy: z.array(nonEmpty).min(1).optional().describe('实际替代条目的稳定编号，未形成替代不编造。'),
  evidenceComparisons: z.array(evidenceComparison).optional(),
  supports: optionalNotes('实际支持该观察的独立证据及范围，不把同一 lineage 的多稿当独立样本。'),
  counterExamples: optionalNotes('真实反例、例外与尚未解决的冲突，不能因最新样文清空旧有效判断。'),
}).superRefine((entry, context) => {
  if (entry.status === 'superseded' && !entry.supersededBy?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['supersededBy'], message: 'Superseded observations require the replacement rule IDs' });
  }
});

export const languageStyleLearningSchema = z.object({
  sources: z.array(languageStyleSourceSchema).optional().describe(
    '获准保存的完整原文、来源类型与同源关系；来源入库不自动生效。数组整体替换，逐项保留仍需的原文与修改前文，不只提交新增项。',
  ),
  observations: z.array(observation).optional().describe('候选、停用及被替代的偏好和证据分析，不进入普通写作的有效规则。'),
  learningRecords: z.array(z.object({
    id: nonEmpty.describe('当前用户内的稳定学习记录编号，不是系统生成的版本号或时间。'),
    authorizationBasis: nonEmpty.describe('本次学习或维护实际获得的授权、明确要求或具体确认范围。'),
    sourceIds,
    affectedRuleIds: z.array(nonEmpty),
    summary: nonEmpty.describe('本次确实新增或修订的内容、观察与状态，不假称已学会完整风格。'),
    before: nonEmpty.optional(),
    after: nonEmpty.optional(),
    retainedNotes: optionalNotes('保留不变内容、仍需延续的候选及已获准整理条目的原意和来源。'),
    openQuestions: optionalNotes('实际未决问题和冲突，不为填满字段制造采集任务。'),
    evidenceComparisons: z.array(evidenceComparison).optional(),
    currentDraftChanges: nonEmpty.optional().describe('仅本篇局部修改的说明，不因此推广为长期规则或认领整篇。'),
  })).optional().describe('普通学习记录，保留未决项；不是不可变历史快照，不提供按版本自动恢复。'),
  unresolvedConflicts: z.array(z.object({
    id: nonEmpty,
    description: nonEmpty,
    sourceIds,
    ruleIds: z.array(nonEmpty).optional(),
    scope: nonEmpty.optional(),
  })).optional(),
}).optional().describe(
  '与有效档案逻辑分开的学习原料及依据，只有学习或具体校准才按需使用；候选、停用及主题主张不约束普通写作。'
  + '本项目沿用原生 Working Memory 整体注入，完整样文会占用每轮上下文；未提供物理字段隔离、自动 SHA 去重、证据计数、历史快照或 CAS。',
);

export type LanguageStyleProfile = NonNullable<z.infer<typeof languageStyleProfileSchema>>;
export type LanguageStyleLearning = NonNullable<z.infer<typeof languageStyleLearningSchema>>;
export type LanguageStyleSource = z.infer<typeof languageStyleSourceSchema>;
