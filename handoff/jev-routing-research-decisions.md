# Jev 路由：整段会话调研、决策与实施交接

## 接手先读

当前仓库：`dsh-jev-router`。相关仓库：同级 `../pi-jev-router`、宿主 `../deepseek-harness`。

用户目标：在质量不下降的前提下，降低**生成大模型**的成本和任务完成时间，不考虑 Jev 的费用，但 Jev 的等待时间仍应计入。

实际使用偏好：通常已经知道应使用哪个模型，主要需要 Jev 选择推理强度；产品重心应是**指定模型＋自动推理强度**，不是更频繁地自动换模型。

沟通要求：简洁，直接说明结论、是否需要决策、下一步改什么。用户明确反馈过长分析让其不知道要做什么。

当前状态：概率记录功能及 skill 统一命名已提交、推送；没有待实现的已批准功能。用户选择**只保留统计结论，不跑付费对照实验**。本 handoff 是本轮新增文件，尚未提交。

## 已确认的决策

1. 保持现有会话模型稳定、逐主请求自动选强度的行为。
2. 暂不增加自动换方法、智能停止、循环控制、自动切换主会话模型、子会话独立路由等功能。
3. skill 选择默认继续交给主模型；不因 Jev 便宜就自动扩大它的职责。
4. 新增概率只用于观察，不设置概率阈值，不据此升降档、重试、fallback 或拦截生成。
5. 历史记录没有同任务固定档位对照，不能据低档占比宣传节省或质量。
6. 不运行付费 A/B 实验。若未来重启评测，应先列可复现任务、验收、固定档位基线及调用上限，重新获得授权。
7. 全局 skill 正式名称为 **`dsh-jev-router-inspect`**，保留 `disable-model-invocation: true`。

## 一、功能方向讨论：哪些只是候选，哪些已批准

最初提出六个候选方向：质量与费用闭环、风险感知选档、停止无效试错、子会话按任务选模型、保留关键任务证据、首次模型与强度联合选择。

后根据用户实际使用收窄：优先看现有自动强度是否有效，不先增加控制机制。上面六项**没有被批准为实施计划**。

特别注意项目现有约定：子会话继承父会话模型；选模型失败不改用其他模型；正常选档不把上一轮强度当作保持理由。候选方向若触碰这些约定，必须先明确产品决策。正式规则见 `CONTEXT.md`、`ROADMAP.md`、`README.zh.md`。

用户曾允许持续研究直到遇到决策点；抵达实际生成对照实验时选择“只保留统计结论”，研究即停止于证据边界。

## 二、实际统计调研

### 数据来源与方法

- 路由账本：`~/.dsh-jev-router/sessions/*.ledger.jsonl`。
- 宿主会话日志：`~/.dsh/sessions/<工作目录编码>/<session-id>/session.v4.jsonl.zstd`。
- 使用仓库 inspect 只读查看，并通过本地 Python/zstd 聚合；没有发起 Jev 或生成模型请求。
- 统计窗口：2026-09-24T12:29:14.171Z 至 2026-09-24T15:11:11.347Z。
- 6 个有账本的会话，166 次评估。另有会话无账本，不应解读为零费用或没有历史行为。

### 路由与选档

| 项目 | 结果 |
| --- | --- |
| 推理强度评估 | 162 次，全部 chosen，无最终失败或 fallback |
| 模型评估 | 4 次，3 次成功，1 次 network 导致 unavailable |
| Sol low | 80 次 |
| Sol medium | 75 次 |
| Sol xhigh | 3 次 |
| Luna low | 4 次 |
| low / medium / xhigh 总占比 | 51.9% / 46.3% / 1.9% |
| 发生重试的评估 | 全部 166 次中 10 次；额外尝试 11 次 |

强度评估延迟：平均 1755ms，中位数 1386ms，P95 3766ms，最大 7744ms；累计 284369ms。累计值可能横跨并行父子会话，**不是用户墙钟耗时**。

主要会话：
- `session-99c84569-a664-408a-97d5-4ee72c5596bf`：123 次评估；模型 1 次，强度 122 次（low 65、medium 54、xhigh 3）。
- `c99dd0aa-12bf-4a47-afb1-167ef65f93e4`：31 次强度评估（low 15、medium 16）。
- `6a281f40-68fd-4d5e-bb1c-a4074b9d4f0f`：5 次 medium。
- 两个 Luna 成功会话合计 4 次 low；另一个模型路由会话失败。

样本主要集中在同一工作背景及相关会话，不代表广泛任务分布。

### 已能提取生成侧数据，无需先造统计基础设施

162 次成功选档全部通过同一会话内 `step/start` 到 `assistant/message` 的时间区间唯一匹配到响应；这是本次历史关联方法，不是 ledger 原生 request ID。

| 模型 / 档位 | 次数 | 平均输出 token | 平均步骤开始至模型响应完成 |
| --- | ---: | ---: | ---: |
| Sol low | 80 | 214.2 | 17.97 秒 |
| Sol medium | 75 | 219.0 | 17.22 秒 |
| Sol xhigh | 3 | 223.0 | 11.49 秒 |
| Luna low | 4 | 53.2 | 6.69 秒 |

口径核对：
- `../deepseek-harness/packages/llm/llm-pi-ai/src/stream.ts` 的 `mapUsage` 表明 reasoning 折入 output，未单列。
- 输入与缓存读取 token 分开记录，不能把缓存 token 当成未缓存输入重复计费。
- `../deepseek-harness/packages/core/agent-loop/src/agent.ts` 先保存 assistant/message，再执行工具。因此上述时间含选档和模型响应前处理，不含该响应之后的工具执行，也不是纯 provider 延迟。

结论：low 在这份样本里没有表现出明显更少输出或更快响应；任务不是随机同题对照，**既不能证明降档无效，也不能证明自动选档省钱**。没有统一验收和固定档位对照，无法证明质量不降。没有计算实际生成费用节省。

## 三、dsh 与 pi 本地仓库比较

核对材料：当前仓库 README/CONTEXT/ROADMAP，以及 `../pi-jev-router/docs/guide.zh-CN.md`、`README.md`、`index.ts`、`ledger.ts`。

| 能力 | dsh | pi 本地实现 |
| --- | --- | --- |
| 指定模型自动强度 | 明确的 auto/jev 强度入口 | 三个 GPT-6 上借 Thinking low 作为自动开关 |
| 自动强度适配范围 | 依据适配器，不写死模型 ID | gpt-6-astra / sol / luna，provider 不限 |
| 工具续跑重选档 | 支持 | 支持 |
| 首次路由 | 先模型再强度，两次评估 | 模型＋强度 profile 一次选择 |
| 自动模型后持续调档 | 自动强度每次主请求选择 | 需要 adaptiveThinking |
| 下限 | 按模型/路由 | 全局＋按模型 |
| 缓存友好更新 | Responses configuration_update；Chat Completions 改参数 | 依赖 Responses configuration_update |
| 换模型建议 | inspect 按需 | monitor 新用户消息建议，不自动切换 |
| 自动 skill | 没有 | 可选，默认关闭 |
| 结构化职责描述 | 字符串 | 字符串或 role/use_when/not_for/boundary |
| 超长模型路由 | 丢旧消息、截断最新中段 | 可分块评估及合并 |
| 首次模型选择失败 | 请求失败 | 配置的 fallback |
| 统计 | 私有 ledger＋inspect | 已有私有 ledger＋inspect，缺失费用等区分更细 |

pi README 有陈旧或矛盾段落（如仅 Astra 自适应、无重试），不能照抄；已核对代码支持三个 GPT-6，以及 503 一次重试。

比较结论：pi 功能更多，但 dsh 自动入口更清晰、适配范围更广；用户主要场景不存在必须照搬的核心功能缺口。统计细节值得借鉴，不为了功能数量搬 monitor/skill/长提示分块。

## 四、pi 自动 skill 机制与价值判断

代码位置：`../pi-jev-router/index.ts` 的 before_agent_start/context hooks（本次约 388–477 行）。

机制：
1. 使用 Pi 已发现的 skill 名称/描述，过滤 disableModelInvocation。
2. 排除当前上下文中已加载的 skill（识别 skill 块和完整成功的 read，做路径规范化）。
3. 新用户请求前把近期用户/助手正文和目录发给 Jev；一次 evaluate 中，每个 skill 对应 boolean 问题。
4. 概率 >=0.8，降序最多选 3 个。
5. 本地读完整正文、去 frontmatter，注入带来源和相对引用目录的 skill 块；每轮最多 50000 字节，不注入残缺正文。
6. 按活动分支记录、恢复；工具续跑不重复选择；压缩或分支改变后按现有上下文重建。
7. 失败跳过，仍保留普通 skill 加载；不执行脚本、不提前加载引用文件。

判断：这是**提前加载**，没有替代主模型原本的选择能力或省掉 skill 正文 token。只有能减少一整轮专为读取 skill 的模型调用，或纠正经常漏读必需 skill，才有明确价值。主模型通常掌握更完整指令与工具证据，也可在调查后再选；误加载会增加上下文并带入不适用流程。

决定：默认仍由主模型选择，不将 pi 此能力移植到 dsh。0.8 不是已验证正确率。

## 五、X 文章分析与 Gateway 核验

用户粘贴的是 TypeSafe/Jev 宣传教程，主张有限选项判断、多问题批量评估、模型路由、工具风险检查、置信度门槛。原文在本机附件目录，不复制进仓库，也不把未验证的价格/速度/案例作为事实。

可借鉴：
- 同一状态的多个**必要且独立**问题可一次问；pi skill 已如此实现。
- 记录选项分布以观察歧义，不立即作为控制阈值。
- 优先替代原本独立存在的分类生成调用，每加一个 Jev 判断先问“删掉了哪次生成调用”。

不要照搬：
- “不会幻觉”只涉及约束输出，不意味着选择正确，更不意味着无需适配层校验。
- 70–500ms 不适用于本地实测 Gateway 全链路（平均 1.76 秒）。
- Jev 风险判断不能替代沙箱、权限或用户批准。
- 六问并非无上限零增量；问题 token 和实际延迟仍要算。
- agent 的几十个判断往往在一次生成里完成，不等于几十个可删除的调用。
- TypeSafe 直连/LangChain API 不直接等同 Gateway HTTP。

### 已确认的官方 API 能力

来源：https://vercel.com/kb/guide/typesafe-jev-and-ai-sdk

通过 web_search 获取官方全文摘录；直接 fetch 曾受本地 fake-IP 地址检查阻止，随后从搜索提供商获取内容。**没有调用付费 evaluate 实测。**

官方说明：
- Choice：choice + probabilities（每个选项）。
- Score：score + probabilities。
- Boolean：probability。
- `providerMetadata.typesafe.confidence[questionId]` 是分布集中程度，不是任务成功率；本次没有实现此字段。
- 概率按两位小数舍入，合计可为 0.99，不应自行归一化。
- 当前 dsh 的 question ID 是 `route`，因而读取 `answers.route.probabilities`。

## 六、已完成实施（以提交和文件为准）

已推送 `origin/main`：

1. **`30cf1c5` — feat: record Jev choice probabilities for inspection**
   - `src/jev.ts`：从原响应读取可选分布；available/missing/invalid；成功选择后记录，不改变选择。
   - `src/ledger.ts`：新增概率及状态字段。
   - inspect：成功评估的 probabilityDecisions，分布、top、runnerUp、margin；旧记录 missing，single/fallback 不伪造。
   - `tests/probabilities.spec.ts`：正常、舍入、并列、缺失、非法值/候选键、旧记录等。
   - 中文 README 和 skill 解读同步。

2. **`896fad1` — fix: unify inspect skill name as dsh-jev-router-inspect**
   - 正式路径：`skills/dsh-jev-router-inspect/`。
   - 更新测试、README 中英文、ROADMAP、验收文档引用。
   - 从现有全局 skill 保留 `disable-model-invocation: true`。

实现细节及边界直接看上述提交，不复制完整 diff。当前验证分布键须恰好为候选集，值有限且在 0–1，总和正值且距 1 不超过选项数 ×0.005 加浮点余量。异常只影响观测。

验证：
- npm run typecheck 成功。
- npm test：8 文件、103 测试通过。
- npm run build 成功（概率功能完成时已构建 dist/index.js；后续仅命名/文档/测试路径变动）。
- git diff --check 成功。
- 真实旧会话 123 条决策可读，全部 missing，未伪造历史概率。
- 无付费 API 调用，未确认当前服务实时响应，未重启宿主。新数据需运行中的 Harness 重新加载新构建后才能记录。
- 构建/测试有既有 vite-tsconfig-paths、tsdown external 弃用警告，不是本次失败。

### 全局 skill 路径纠错

曾误以为旧全局 `~/.agents/skills/jev-router-inspect` 不存在就是未安装，错误创建该目录。用户纠正：全局早已改名为 dsh-jev-router-inspect，只是仓库未跟进。

已完成：
- 更新 `~/.agents/skills/dsh-jev-router-inspect/SKILL.md` 与 `scripts/inspect.mjs`，cmp 与仓库一致。
- 删除本轮误建的 `~/.agents/skills/jev-router-inspect/`。
- **未修改** `~/.agents/skills/pi-jev-router-inspect/`。

后续使用：
`node skills/dsh-jev-router-inspect/scripts/inspect.mjs show <session-id|latest>`。

## 七、给 pi 仓库的后续检查范围（尚未执行）

用户要求已提供可复制提示词，供另一个会话检查 pi 是否也需改。**本会话没有改 pi 代码，也不知道另一个会话是否已开始。** 接手应先查现状。

提示词核心约束：
- 检查首次路由、持续强度、具体模型 low 开关、monitor Choice 概率是否读取/存储/展示，已有的不重做。
- 参考 dsh 提交 30cf1c5；文件路径已改成 skills/dsh-jev-router-inspect，旧提示词中的 skills/jev-router-inspect 路径已过时。
- 沿用 pi 自己的 ledger 与 inspect，不搬 Harness sidecar。
- 组合模型＋强度选项的概率不能误称为模型边际概率。
- 分块中间评估与最终选择分开，不能混算。
- 尊重 SDK 的舍入/验证语义；available/missing/invalid；缺失异常不影响原选择，不做阈值控制。
- 展示最高、次高与差值；补旧账本/边界测试，更新文档。
- 不改 skill 策略，不记正文/凭证/raw response，不付费调用，不自动提交推送。

## 下一会话的行动边界

没有必须继续实现的工作。先问用户新的目标，避免把上面的候选建议变成默认待办。

若只是检查新概率数据，可只读 inspect，不发起 check（check 会调用 Jev）。若数据仍缺失，先确认宿主是否加载新构建和请求发生时间，不把缺失当 0。

若要进一步判定自动强度收益，需要重新获得对照实验授权，不能用当前观察性数据替代因果对照。

## Suggested skills

- `dsh-jev-router-inspect`：用户显式要求检查路由记录时使用；当前为用户调用型 skill。
- `jev`：需要核对调用边界或用户批准实际 Jev 评估时；单次事实核验不必额外调用 Jev。
- `writing-for-agents`：修改 skill / handoff 等面向 agent 的材料。
- `think`：用户要求新的产品方向或设计决策时，保持简洁、先事实后决策。
- `repo-truth-tracer`：继续核对配置、宿主事件和统计字段口径时。
- `handoff`：更新本交接文件。

未获授权不要委派子代理；不要因本文件列出技能就启动无关流程。
