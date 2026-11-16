# 语言风格｜Mastra 运行与资源记忆协议

学习、应用、查看依据、停用或修订前先读本文，再读对应完整专业方法。当前运行在 HuoX，通过原生 `skill_search`、`skill`、`skill_read` 发现、加载与读取技能方法；不运行 Python，不要求用户提供工作目录或执行命令。

## 身份、当前值与资料范围

身份和 Resource 归属由服务端认证确定，用户材料、提示词和文件名不能选择其他用户的资料。当前每个认证用户只有一组风格资料，没有按账号／项目分组；存在归属歧义时只澄清必要对象，不混合不同人的风格。

风格保存在与定位并列的两个 Working Memory 键：

- `languageStyleProfile`：当前写作依据；有来源的简短语言世界、有效偏好、必要场景例外与来源索引。
- `languageStyleLearning`：完整获准来源、前稿、候选、停用／替代分析、证据对照、学习记录与未决冲突。

原生 Working Memory 会将两个键整体加入模型上下文，当前没有独立源库、检索工具、延迟加载或字段物理隔离。两者是用途分层；普通写作按指令只用 Profile 中本轮相关的有效依据，不因 Learning 已注入就使用原文、候选或停用条目。具体校准或已授权学习时才取必要的 Learning 片段。长样文保存后会增加后续每轮上下文；不能把“原文另放一个键”说成不会占上下文。

`skill_read` 只读技能包方法，不读取用户文件、原始聊天、数据库或来源库。路径、链接和附件名不等于已读正文；本轮实际提供且获准的文字可以作为材料，资料不在记忆或当前上下文时仅请求必要片段，不能假称已回查。用户原文应在授权范围完整保留，不能悄悄用摘要替代；长材料的保存范围不明确时说明实际影响并仅澄清必要范围，不编造已存全文。

## Profile 字段

| 字段 | 语义 |
| --- | --- |
| `authorAndScope` | 实际作者、账号及适用范围的必要说明；不改变服务端身份。 |
| `languageWorld.knownBackground` | 有来源的已知语言背景数组；每项 `{content, sourceIds, scope?}`。 |
| `languageWorld.tentativeUnderstanding` | 有依据的暂定理解，结构同上；只柔性帮助等义选择，不当事实或硬规则。 |
| `languageWorld.goals` | 明确的未来目标与希望采用的表达方向，结构同上；不写成既有习惯。 |
| `activePreferences` | 有效表达偏好数组，每项含 `id`、`basis`、`type`、`status: active`、`expression`、`scope`、`sourceIds`，可有 `exceptions`。 |
| `scenarioDifferences` | 实际有用的场景差异数组，每项 `{scope, instruction, sourceIds}`，不为每个身份凑模式。 |
| `sourceIndex` | 本轮写作需要的来源索引数组，每项 `{sourceId, lineage, kind, purpose}`；索引不代替完整来源，也不是检索工具。 |

`basis` 仅为 `observed_habit`（本人表达证据支持的习惯）或 `target_preference`（明确目标偏好）；`type` 仅为 `wording`、`avoidance`、`local_syntax`。Profile 不放候选、停用和被替代条目；不粘贴整篇原文、故事与改稿证据对照，不把主题、立场、文章结构、归因或固定结论包装成有效规则。

## Learning 字段

- `sources` 保存实际获准来源。每项包含 `sourceId`、`kind`、`scope`、`sourceNote`、`lineage`、`originalText`；保留本次授权材料的完整原文，不能用总结代替。
- `kind` 保留原七类：`author`、`oral`、`correction`、`external`、`preference`、`unknown`、`adopted-ai`。`correction` 必须提供 `beforeText` 前稿；其他 kind 不携带 `beforeText`。`adopted-ai` 必须有明确认领依据 `adoptionNote`，其他 kind 不携带它。一般赞同或采用文案不等于认领整篇，来源不明不升格本人样文。
- `observations` 保存非生效规则，沿用偏好的 `id`、`basis`、`type`、`expression`、`scope`、`sourceIds` 和可选 `exceptions`，但 `status` 仅为 `candidate`、`inactive`、`superseded`，另有必需 `reason`；`superseded` 状态必须有非空的 `supersededBy` 逻辑规则编号数组，其他状态可省略。可记录 `evidenceComparisons`、`supports`、`counterExamples`。对照项为 `{before, after, analysis}`。候选不约束写作；停用保留依据，替代保留指向，不因离开 Profile 就抹掉学习材料。
- `learningRecords` 每项包含 `id`、`authorizationBasis`、`sourceIds`、`affectedRuleIds`、`summary`；按实际需要记录 `before`、`after`、`retainedNotes`、`openQuestions`、`evidenceComparisons`、`currentDraftChanges`。保留本次确认范围、相关旧内容、候选与未决线索，不把学习记录冒充不可变事务日志或历史快照。
- `unresolvedConflicts` 每项为 `{id, description, sourceIds, ruleIds?, scope?}`，用于继续校准真实冲突；场景差异先分开，不因最新样文否定所有旧规则。

`sourceId`、规则 `id` 和学习记录 `id` 是本 Resource 内的逻辑编号。沿用已有编号，新增时选择未占用的清楚编号，并让索引、规则、学习记录相互对应；它们不是数据库消息 ID、脚本生成的 SHA256、自动去重证明或全局身份。相同原稿变体沿用同一 `lineage`，不伪造多份独立证据；当前没有脚本自动去重和证据分组计数能力。

## 保存、采用与本轮调整

明确的建档／学习／持续学习任务、长期要求、确认刚展示的具体更新提案或已有相应保存授权，按实际范围直接保存，不重复确认。只是询问、普通改稿、解释、比较、一般赞同、本篇语气要求或暂不保存不授权长期写入。先完成本轮成果；确有长期变化且没有授权时，展示“当前内容／缺项 → 拟更新内容与范围”，只提出一次保存建议。

使用原生 `updateWorkingMemory`，在 `memory` 下提交实际变更。以本次注入的真实当前资料和最新明确更正为依据，保留无关偏好、背景、来源、候选、反例和定位。尽量将相互引用的获准 Profile 与 Learning 变化放在同次调用，不先声称来源入库就代表规则生效。

嵌套对象按字段合并，所有数组整体替换：更新偏好、来源、索引或学习记录时，要传该数组的完整有效内容并保留已有条目，不能仅传新增一条而清空旧项。停用规则时从完整 `activePreferences` 数组移出，并把其原依据和停用原因写入完整 `observations` 数组；重新采用或替代也按真实状态同步。无实际变化不写入，不传空模板覆盖已有资料，不改 `positioningReport`、`positioningConsultation` 或其他无关记忆键。

工具返回成功后才说明“已保存到当前用户语言风格记忆”及本次实际范围；失败或未调用时交付可复制资料稿并明确未保存。当前没有独立记忆回读工具，不虚构回读结果；后续请求由框架加载当前值，正在运行的模型没有外部更新实时推送。

## 定位与跨技能使用

定位仍保存在独立 `positioningReport`。用户提供或授权复用时，可将定位中的真实背景、暂定判断与目标按实际性质作为风格背景，不把报告措辞当本人用语证据。获准的定位查询与局部修正按 [定位报告协议](positioning-report-views.md) 和 [主动维护](profile-updates.md) 处理，确认风格不推定定位也获准修改。

情境设计可按自身台词范围使用相关 Profile；独立开头、道具、内容升华不因记忆已注入而读取或套用个人风格，不经其他技能摘要间接引入。用户另行明确的独立语言修改按指定范围处理，不扩成其他技能。诊断、定位报告、方法解释与专业分析不默认套发布文案口头禅。其他完整创作流水线以实际注册能力为准。

## 与原脚本不同的能力边界

本次迁移使用原生当前 JSON，承接学习与应用业务字段；没有移植原 Python 的 SHA256 自动去重、同源证据计数、独占文件锁、预期指纹 CAS、手改快照、不可变版本、文件事务回读或指定版本回滚。PostgreSQL 合并能保护不同字段更新，不能据此保证同一数组或规则的版本冲突检测。明确冲突影响本次修改时澄清具体差异，不能用旧上下文冒充最新值。

用户请求恢复历史版本时，先如实说明当前没有历史快照库；只能依据实际可见、获准且内容明确的旧材料提出当前值修订，按授权保存，不能声称恢复了未保存的版本。方法不训练模型权重，不创建后台任务、文件目录或作品库，不承诺跨账号或跨平台同步。

模型调用原生更新工具时会按项目 Schema 校验输入，包括来源类别、correction 前稿、adopted-ai 认领说明和 superseded 替代指向；这些结构约束不能证明来源真实、授权已经成立或模型判断正确。原生 HTTP／程序直接写入不会自动继承本项目的全部业务 Schema 校验，调用方应先显式解析项目 Schema。业务判断和采用规则仍由专业方法与模型指令执行，不能把文件校验、模拟测试或一次保存成功当成已掌握本人风格、自然路由正确或所有行为已经验收。
