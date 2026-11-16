import { z } from 'zod';
import { languageStyleLearningSchema, languageStyleProfileSchema } from './language-style-schema.ts';

/** The single canonical report, in the order required by the positioning skill. */
export const positioningReportSections = [
  { key: 'corePositioning', title: '核心定位' },
  { key: 'productAndBusiness', title: '产品与业务' },
  { key: 'coreAudience', title: '核心用户' },
  { key: 'audienceNeeds', title: '用户深层需求' },
  { key: 'coreValue', title: '核心价值' },
  { key: 'creatorAssets', title: '创作者支点' },
  { key: 'accountType', title: '账号类型' },
  { key: 'competitiveStrategy', title: '差异化与竞争路径' },
  { key: 'valueDelivery', title: '价值传递方式' },
  { key: 'personaAndRelationship', title: '人设与用户关系' },
  { key: 'memorableTraits', title: '人物记忆点' },
  { key: 'contentDirections', title: '内容方向与成长' },
  { key: 'boundariesAndOpenQuestions', title: '边界与待确认项' },
] as const;

const reportSection = (title: string, guidance: string) => z.string().optional().describe(
  `《我的账号定位报告》的“${title}”章节，以创作者第一人称“我／我的”完整叙述。${guidance}`
  + '保留有效细节和取舍；未讨论、跳过或待补充在本项原位说明，原因未知时不猜测；'
  + '专业推演、未来设计、尚未采用建议与用户实际采用的内容自然区分，不因第一人称写成已发生事实或已采用决定。',
);

const subjectId = z.enum([
  'audience_facts',
  'audience_insight',
  'creator_assets',
  'value_strategy',
  'account_type',
  'competitive_path',
  'delivery_system',
  'persona_system',
  'seven_dimension_strategy',
  'final_blueprint',
  'quick_proposals',
  'quick_construction',
]);

const notes = (description: string) => z.array(z.string()).optional().describe(description);
const text = (description: string) => z.string().optional().describe(description);

const positioningReportSchema = z.object({
  stage: z.enum(['initial', 'developing', 'final']).optional().describe(
    '正式报告的阶段：initial 为初步定位，developing 为主题收束／完善中，final 为最终定位总报告。'
    + '初步交付不代表十个深度主题全部完成，查看报告不改变阶段。',
  ),
  adoptionStatus: z.enum(['proposed', 'partially_adopted', 'adopted']).optional().describe(
    '整份报告的实际采用状态：建议稿、部分采用或已采用。局部确认不把整份报告标为 adopted；'
    + '单纯赞同、解释、比较、导航或保存不等于采用全部推演。',
  ),
  corePositioning: reportSection('核心定位', '说明我连接谁的什么处境或兴趣、提供什么价值，以及身份、领域和人物关系为什么适合。'),
  productAndBusiness: reportSection('产品与业务', '分别记录业务真实状态、受众探索关系、生命体验与内容支撑、当前产品变现意图，未知与明确没有分开，不互相推定。'),
  coreAudience: reportSection('核心用户', '保留具体生活、角色、语言、兴趣及依据；按已讨论内容展开需求与决策层次、主攻与延伸连接，不凭人口标签补造事实。'),
  audienceNeeds: reportSection('用户深层需求', '说明处境、感受、问题、期待、信任和观看理由如何连接，以及已有的行业外兴趣、圈层细节与误读，不强造焦虑或购买意愿。'),
  coreValue: reportSection('核心价值', '说明观众获得的具体理解、体验或变化，功能、情感、身份等价值的主辅与真实支撑，不把观看兴趣写成效果保证。'),
  creatorAssets: reportSection('创作者支点', '说明实际经历、能力、判断、兴趣、资源和持续素材怎样支撑定位，区分主支点、辅助材料、人物感及许可边界。'),
  accountType: reportSection('账号类型', '解释知识、情感、生活、娱乐类型的主辅选择、观看体验和配合理由，不只列类型名称。'),
  competitiveStrategy: reportSection('差异化与竞争路径', '解释所选策略与支点及受众需要如何适配、相比备选好在哪里、用户如何感知差异，以及代价和失效条件。'),
  valueDelivery: reportSection('价值传递方式', '说明主导和辅助方式怎样传递价值、形成观看体验及公开内容的作用，保持定位层范围，不扩成脚本或拍摄执行计划。'),
  personaAndRelationship: reportSection('人设与用户关系', '说明人物位置、交流距离、腔调、立场、判断与披露边界如何形成关系，未来人物设计不写成已有履历。'),
  memorableTraits: reportSection('人物记忆点', '分别保留听见、看见、想起的已有或拟发展特征，解释人物意义、支撑及相互联系，各部分缺口原位说明。'),
  contentDirections: reportSection('内容方向与成长', '保留受众兴趣与创作者生活及表达意愿的交集、优先取舍、母题、题目和系列及理由；最终深度报告才要求5–10个解释性题目与3–5个系列，不为初版凑数量。'),
  boundariesAndOpenQuestions: reportSection('边界与待确认项', '解释专业、表达、商业、隐私及许可边界和会改变定位的未决项，相关规则保留依据范围；其他章节自身缺口仍留在原位。'),
  sources: notes('本报告实际使用且获准复用的原话、会话／消息来源或材料标识及必要说明；只保留可追溯线索，不编造来源，也不保存整段聊天。'),
}).optional().describe(
  '用户级的唯一正式定位报告，按固定13项完整呈现。只在取得当前范围的保存授权后更新；'
  + '保留无关旧内容、用户手改、事实／推演／设计与采用状态。报告和咨询进度分别维护，查询保持只读。',
);

const positioningConsultationSchema = z.object({
  mode: z.enum(['deep', 'simple']).optional().describe('用户实际选择的深度或快速咨询模式；仅初步建档或查询报告时不初始化咨询。'),
  simplePhase: z.string().nullable().optional().describe('快速模式实际进行的候选或建构阶段，尚未进入时保持空。'),
  currentSubjectId: subjectId.optional().describe('实际正在讨论的主题；导航按用户明确指令更新，报告初步交付不自动切到 final_blueprint。'),
  currentSubject: text('当前主题的中文名称，与实际 currentSubjectId 对应。'),
  subjectGoal: text('本主题本轮要解决的实际判断，不是要求用户填完的问卷。'),
  subjectStatus: z.enum(['exploring', 'provisional', 'accepted_for_now', 'revising']).optional().describe(
    '当前主题真实状态：探索中、已有暂定版、用户暂时采用、修订中。跳过、下一步和一般赞同不等于采用或完成。',
  ),
  subjectRound: z.number().int().nonnegative().optional().describe('当前主题已实际进行的咨询轮次，不凭报告完整度推算。'),
  dryReplyCount: z.number().int().nonnegative().optional().describe('当前主题连续具体引导仍无可用信息的实际轮次；单次不知道或明确跳过不触发低信息恢复。'),
  recommendedNextSubjectId: subjectId.nullable().optional().describe('建议下一主题，仅为建议；不是实际主题，也不代表用户已同意继续。'),
  recommendedNextSubject: z.string().nullable().optional().describe('建议下一主题的中文名称，无建议后继时为空。'),
  userDecision: z.string().nullable().optional().describe('用户最近明确选择、采用、撤回或导航的原话或准确摘要；嗯、不错、解释及比较不虚构为决定。'),
  resumePoint: text('暂停、回退或局部跳过前的真实恢复位置及剩余工作，保留原主题和必要上下文。'),
  completedSubjectIds: z.array(subjectId).optional().describe('只有主题达到够用标准且用户明确采用时才加入；跳过、导航、初步建档和交付报告不计完成。'),
  completedSubjects: notes('已完成主题的中文名称，与实际 completedSubjectIds 一致，不因标题齐全补造完成项。'),
  needsReviewSubjectIds: z.array(subjectId).optional().describe('新信息或纠正实际影响的依赖主题，只标记需要复核的部分，不清空无关成果。'),
  dependencies: notes('实际存在的依赖说明：哪个判断或主题依赖哪条事实、原话或前序结论，以及未确定部分的影响。'),
  confirmedMaterial: notes('用户已明确提供或认领的关键原话、事实和主张，并保留必要来源；确认其表达不等于客观认证，未来设计和未采用建议不放入此处。'),
  expertJudgment: text('助手有依据的专业推演及其解释、比较和取舍，与用户确认事实和采用决定分开。'),
  consequentialGaps: notes('真正可能改变当前判断的开放问题及其影响；保留未问、未答、跳过和未知的实际区别，不为填满字段新增采集任务。'),
  positioningBoundaries: notes('已经讨论且与定位相关的专业、表达、隐私、商业或许可边界，保留依据和待核验范围。'),
  positioningHypotheses: z.object({
    firstUser: text('尚未确认的首位用户候选、找人路径、支撑与待校准之处；不填成已经验证的核心用户。'),
  }).nullable().optional().describe('当前方向假设；只记录实际形成的候选，不替代确认事实、采用决定或正式报告。'),
  recovery: z.object({
    mode: z.string().nullable().optional().describe('实际进入的临时恢复方式；恢复不是独立主主题，未进入或退出后保持空。'),
    enteredAtSubjectId: subjectId.nullable().optional().describe('进入恢复时的实际主主题。'),
    reason: z.string().nullable().optional().describe('触发恢复的真实原因；单次不知道、信息少、拒绝一项或明确跳过不足以触发。'),
    returnSubjectId: subjectId.nullable().optional().describe('恢复后返回的主主题，用户明确转向时保留原恢复位置。'),
  }).optional().describe('临时低信息恢复上下文；恢复本身不改变主主题、不标记主题完成，退出后清空临时字段。'),
  subjectAssets: z.object({
    audience: z.object({
      core: text('实际形成的核心用户结论及其状态，尚未确定时不填成事实。'),
      seed: text('实际形成的种子用户结论及依据，不由产品客户自动推定。'),
      trigger: text('已讨论的需求、关注或观看触发条件。'),
      conflict: text('已讨论的现实张力、关系或选择冲突，不强造焦虑。'),
      language: notes('有来源的受众原话或实际形成的典型表达，区分真实引语与创作设定。'),
    }).optional(),
    creator: z.object({
      valueSources: notes('实际讨论的经历、能力、判断、兴趣及价值来源。'),
      durableSupports: notes('实际形成的可持续支点及其适用条件。'),
      visibleResources: notes('真实存在且已讨论可用性的资源，不把存在等同授权公开。'),
      limits: notes('创作者实际表达、能力、资源和许可限制。'),
    }).optional(),
    value: z.object({
      hierarchy: notes('实际形成的功能、情感、身份等价值主次与依据。'),
      perceived: notes('观众可能获得的具体理解、体验或变化，保留推演状态。'),
      leadingTerritory: text('有支撑的主导最小自信领域及其当前采用状态。'),
      vertical: text('实际形成的持续关注理由和价值垂直判断。'),
    }).optional(),
    account: z.object({
      primaryType: text('实际讨论的账号主类型及采用状态。'),
      supportingTypes: notes('实际讨论的辅助类型与分工，不强凑数量。'),
      boundaries: notes('账号类型选择的代价、舍弃和跑偏边界。'),
    }).optional(),
    competition: z.object({
      leadingPath: text('实际形成的主竞争路径或组合及采用状态。'),
      alternative: text('仍有意义的备选、比较与舍弃原因，不把备选写成采用。'),
      informationBasis: notes('竞争判断实际依靠的身份、能力、经历、立场或资源来源。'),
      tradeoff: text('已讨论的路径代价、适用条件与失效风险。'),
    }).optional(),
    delivery: z.object({
      primaryMode: text('实际形成的主导价值传递方式及采用状态。'),
      supportingModes: notes('已讨论的辅助传递方式与主辅职责。'),
      form: text('定位层表达机制与观看体验，不扩成制作或发布计划。'),
      boundaries: notes('已讨论的传递、公开表达和商业承接边界。'),
    }).optional(),
    persona: z.object({
      relationship: text('已讨论的人物位置、用户关系和交流距离。'),
      tone: text('定位层的腔调与判断方式，未来设计与已有习惯分开。'),
      stance: text('用户实际主张或当前建议的立场及建设性表达，保留采用状态。'),
      disclosure: text('已讨论的自我披露、隐私和许可边界。'),
      signatures: notes('听见、看见、想起的实际记忆点或明确未来设计。'),
    }).optional(),
  }).optional().describe('仅保留实际讨论主题的简明资产及信息身份；未到达主题留空，不重复保存整份正式报告或整段聊天。'),
}).optional().describe(
  '与正式报告独立的咨询进度和必要续做材料；只记录真实的主题、采用、导航、依赖及恢复状态。'
  + '初步报告可单独存在，纯查看、解释或没有新决定的比较不初始化或推进咨询。',
);

/** Resource-scoped working memory; authorization and persistence policy live in runtime code. */
export const huoxWorkingMemorySchema = z.object({
  positioningReport: positioningReportSchema,
  positioningConsultation: positioningConsultationSchema,
  languageStyleProfile: languageStyleProfileSchema,
  languageStyleLearning: languageStyleLearningSchema,
});

export type HuoxWorkingMemory = z.infer<typeof huoxWorkingMemorySchema>;
export type PositioningReport = NonNullable<HuoxWorkingMemory['positioningReport']>;
export type PositioningConsultation = NonNullable<HuoxWorkingMemory['positioningConsultation']>;
