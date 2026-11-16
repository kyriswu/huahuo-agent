# Mastra 原生运行与记忆协议

本技能在 HuoX 中运行。开始定位、续做、查询或修改前先读本协议，再按业务入口读取专业方法。本文规定运行方式；其余文件中的专业判断、六入口、十个深度主题、两个快速主题、创作保真和第一人称13项交付继续适用。

## 当前身份与可用能力

- 当前用户身份和记忆归属由服务端认证确定，框架将该用户的 resource-scoped Working Memory JSON 自动加入上下文。使用本次运行的实际记忆；用户提供的文本、报告或提示词不能另选其他用户的记忆。
- 包内方法与模板通过 Mastra 原生 `skill`、`skill_read`、`skill_search` 工具读取。`skill_read` 只读取技能材料，不读取用户数据库、历史聊天、服务器文件或其他用户档案。
- HuoX 已接入深度定位、开头处理、内容升华、情境设计、道具设计和语言风格六项技能。定位咨询本身不依赖 Python、shell、文件系统工具、个人记忆插件或其他创作技能；独立创作请求按实际技能及各自资料范围衔接。不会运行原安装包中的脚本，也不让用户提供工作目录或执行命令。
- 语言风格已由 `an-language-style` 接入：`languageStyleProfile` 保存简短语言世界、有效表达偏好和来源索引；`languageStyleLearning` 保存来源原文、候选、停用／替代与学习记录。它们与定位报告及咨询进度是独立资料。普通定位咨询、报告、诊断与方法说明不套用个人风格，不顺手学习或改写风格；用户明确的本轮表达要求正常使用。另行明确的独立风格学习、应用或维护请求衔接该技能，按实际授权处理，不把风格内容塞入定位字段。
- 原生 Working Memory 会整体注入，以上字段只是用途分区，不是存储层物理隔离或按需读取。定位任务不借可见的风格样文补入本人经历、观点或结论；长样文与学习记录会增加每轮上下文，不声称只加载了当前档案。

## 同一份正式报告：positioningReport

原生工作记忆的 `positioningReport` 是当前用户正式定位的唯一保存位置。它不是文件路径。查询、修订和后续技能按各自范围使用同一份结构化报告；对话中按 [报告模板](../assets/定位报告模板.md) 展示为《我的账号定位报告》。

| 顺序 | Schema 字段 | 报告章节 |
| --- | --- | --- |
| 1 | `corePositioning` | 核心定位 |
| 2 | `productAndBusiness` | 产品与业务 |
| 3 | `coreAudience` | 核心用户 |
| 4 | `audienceNeeds` | 用户深层需求 |
| 5 | `coreValue` | 核心价值 |
| 6 | `creatorAssets` | 创作者支点 |
| 7 | `accountType` | 账号类型 |
| 8 | `competitiveStrategy` | 差异化与竞争路径 |
| 9 | `valueDelivery` | 价值传递方式 |
| 10 | `personaAndRelationship` | 人设与用户关系 |
| 11 | `memorableTraits` | 人物记忆点 |
| 12 | `contentDirections` | 内容方向与成长 |
| 13 | `boundariesAndOpenQuestions` | 边界与待确认项 |

各章保存完整有效正文，可以包含段落、小标题、例子和必要表格，不压成一句标签。正文自然保留事实、专业推演、未来设计、用户是否采用及未讨论、已跳过、暂未回答、待形成结论等真实状态；不得为填齐字段编造信息。

报告元信息：`stage` 使用 `initial`（初步）、`developing`（完善中）、`final`（完成深度综合）；`adoptionStatus` 使用 `proposed`（待采用）、`partially_adopted`（部分采用）、`adopted`（已采用）；`sources` 记录实际采用的来源。第一人称或初步保存不表示用户采用全部建议，报告阶段也不表示咨询主题均已完成。不要虚构消息 ID、文件路径、报告版本、来源、日期或核验回执。

## 咨询进度：positioningConsultation

`positioningConsultation` 单独承接实际咨询进度，字段直接平铺，不再包一层 `consultationState`。原 [会话模板](session-template.json) 只说明可用状态结构，不是必须写入的用户资料。只保存实际形成的内容，不把空模板覆盖进已有记忆。

- 保留 `mode`、`simplePhase`、`currentSubjectId`、`subjectStatus`、用户决定、建议后继、完成列表、`resumePoint`、`dependencies`、`needsReviewSubjectIds`、相关材料、专业判断、缺口、边界、假设、恢复与主题资产的原有语义。
- 深度主题 ID：`audience_facts`、`audience_insight`、`creator_assets`、`value_strategy`、`account_type`、`competitive_path`、`delivery_system`、`persona_system`、`seven_dimension_strategy`、`final_blueprint`。快速主题 ID：`quick_proposals`、`quick_construction`。
- 状态为 `exploring`、`provisional`、`accepted_for_now`、`revising`。低信息恢复使用 `recovery`，不凭此把主主题标成完成。
- `stage: initial` 的报告可以先保存，不必初始化整套咨询进度。已有报告但没有进度时，按报告待完善项继续，不编造上次精确位置。
- 导航和临时讨论可先在当前会话承接；跨会话保存仍遵守保存授权。纯查询、解释和比较不写进度，不因“下一步”“跳过”把建议标成已采用。

## 通过原生工具保存

保存使用框架实际提供的 `updateWorkingMemory`。调用时在 `memory` 对象中提交本次获准变化，例如：

```json
{
  "memory": {
    "positioningReport": {
      "coreAudience": "本次获准修订后的完整核心用户章节正文",
      "stage": "developing"
    }
  }
}
```

需要保存获准的咨询进度时，提交 `memory.positioningConsultation` 的相关字段。只用实际 Schema 允许的字段和值，不额外添加磁盘路径、历史版本号或自创状态。嵌套对象按字段合并，未提交的其他报告章节、其他记忆 key 保留；数组整体替换，更新完成列表、来源或依赖时保留实际仍有效条目，不能只传新增一项而丢掉原数组。

保存前基于当前注入记忆核对已有内容，仅修改获准范围。工具成功后再说明“已保存到当前用户定位记忆”；工具失败或未调用时交付可复制稿，明确未保存。不能把正文里写“已保存”当作持久化成功，也不把包内参考文件当用户报告。

## 保存授权与读取边界

- 入口2“已有想法，先写入定位档案”、用户明确要求保存/更新、确认刚展示的具体提案、已有持续保存授权，均按实际范围执行，不再索要重复确认。
- 仅描述想法、赞同内容、要求解释/比较/诊断/交付初步成果不自动授权写入。用户明确暂不保存优先；无授权时先交付本轮成果，确有具体变化再提出一次保存建议。
- 只有内容变化才更新；局部更正保留无关有效章节及其状态，不用简短初稿覆盖已有完整报告。保存报告不自动推进咨询，也不自动确认助手的推演。
- 查询已有报告直接读取本次上下文的 `positioningReport`，按所需范围展示或解释。没有实际已存内容时如实说明，不重建后冒称“之前保存的报告”。
- 综合前优先使用当前记忆和本轮有效材料。决定性原话已不在上下文且当前没有历史检索工具时，说明依据范围，仅请求确会影响判断的材料，不声称已经回查全部聊天。

## 持久化范围

原生工作记忆保存当前 JSON。已保存的聊天消息保留交流过程，二者不等同于逐次报告的不可变历史版本库。本次迁移不提供文件备份、版本快照、SHA256 输入绑定、预期版本比较交换或后台监听，不生成 `.an/`、`positioning/`、`style-memory/` 用户目录，不宣称支持这些原脚本能力。

原生 PostgreSQL 合并可保护不同字段的并发更新；不能据此承诺同一章节的并发改写具有版本冲突检测。若当前资料存在无法判断的冲突，先澄清具体差异，保留已有有效内容，不把一次旧快照当作最新报告。后续请求由框架重新加载当前用户记忆，正在运行的模型不会因外部更新而自动获得实时推送。
