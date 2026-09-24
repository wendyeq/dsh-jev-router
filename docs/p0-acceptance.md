# P0 安装与验收（维护者操作清单）

本清单区分**本地自动测试**和**真实 Harness + Gateway 验收**；后者需要维护者自己的凭证，不能以单元测试通过代替。插件不会自动切换到备用模型。

## 前提与安装

- Node >=22.19；宿主必须是 `wendyeq/deepseek-harness` 的 `local/jev-host` 分支、提交 `737a4c131e` 或包含同等选择器事件和 `configuration-update` 支持的后续版本。上游默认分支不受支持。
- 在插件仓库运行 `npm ci`（若无 lockfile，则使用 `npm install`）、`npm run typecheck && npm test && npm run build`；在宿主按其 profile 插件加载机制加载本仓库的 `dist/index.js` 和 `cordis.patch.yml`。确认启动日志没有插件解析或事件注册错误。不要将选择器值当作生成模型适配器。
- 将 `examples/jev-policy.patch.yml` 复制到**私有** profile 覆盖层。填写 Harness 凭证引用 `credentialRefs`（Vercel AI Gateway Bearer token 对应的引用）、实际已注册的候选模型及描述，然后设 `enabled: true`。配置替换整份插件配置，不能只覆盖 `enabled`。不要将 token 写进补丁或仓库。
- 先在测试 profile 启用 `logDecisions: true`；需要落盘诊断时使用绝对路径 `diagnosticLogFile`，验收后关闭并清理诊断文件。`stateDirectory` 默认 `~/.dsh-jev-router/sessions`，同一 Session 的 sidecar 和 ledger 应一起保留。

## 真实验收矩阵

使用一次性测试会话；每一项检查生成请求头、`stateDirectory` 下 sidecar/ledger 及 `jev-router-inspect` 的 `show <session-id>`。如只配置一个可用模型/档位，对应评估会跳过 HTTP，不能用来验证 Gateway 调用。

| 场景 | 通过标准 |
| --- | --- |
| 首次选 `auto/jev` + 自动强度，输入文本 | 模型和强度选择后才固定会话模型；请求发往具体已注册模型；ledger 记录两类评估（单选项可为 `single`）。 |
| 同会话继续发送用户消息，含工具往返 | 模型不变；每次主请求重新评估强度；改档按宿主适配器协议发送，检查请求头/更新记录。 |
| 恢复会话与子会话 | 恢复后保持具体模型；子会话继承父会话已选模型和强度选择方式，父会话尚未选定时失败。 |
| 标题/压缩旁路请求 | 不产生 Jev 评估，不选定新模型；使用具体会话模型和适配器默认强度。 |
| 再次选 `auto/jev`；只改任务说明 | 前者在下一次主请求重选模型；后者不重选已有会话模型。 |
| 指定模型 + 自动强度；指定模型 + 指定强度 | 前者仅评估强度；后者不产生 Jev 评估。 |
| 断开 Gateway / 凭证无效 / 无候选模型 | 模型选择失败不能偷偷使用备用模型；仅强度连续临时故障允许同模型降级；失败可按下表归因。 |
| 升级与回退 | 停止宿主，保存 profile 与测试 Session 的 sidecar/ledger；替换插件 bundle 后恢复会话验证。回退时恢复原 bundle 和 profile，不复用不兼容的新 sidecar；不要删除 Session 日志。 |

## 失败归因

先用 `jev-router-inspect` 的 `show <session-id>` 查看 `failureReasons`；无 ledger 时检查 `ledger` 是否关闭、请求是否进入主请求，以及该会话是否早于记录功能。若评估根本未开始，检查宿主错误及候选注册状态。诊断日志和 ledger 不含正文、请求体或凭证；不要为排查而粘贴 Bearer token。

| 现象或 reason | 下一步 |
| --- | --- |
| `credential`、`credential-timeout` | 检查 profile 的 `credentialRefs`、Harness 凭证能否读取及其权限；凭证读取超时不重试。 |
| `HTTP 401/403`、其他非临时 4xx | 检查 Gateway token、权限和请求配置；不会自动重试。 |
| `HTTP 408/429/500/502/503/504`、`timeout`、`network` | 查看 Gateway/网络状态；选模型失败则本次失败，强度连续临时故障可降级。 |
| `body-limit` | 缩短候选项和档位描述；超长正文已优先丢旧消息并截断最新用户正文中间。 |
| `invalid-answer`、`invalid-choice` | 检查 Gateway 响应格式或候选描述；不把任意回答当成已注册选项。 |
| `no user body`、`no available choices` | 提供用户正文；确认候选模型已注册、支持输入模态，自动强度有可用档位。 |
| `effort floor ... is not supported` | 将配置中的下限改成适配器实际支持的档位；指定强度不受下限影响。 |
| `parent has no session model`、`no session model` | 先完成父会话首次主请求，或为旁路请求选择具体模型。 |

记录验收日期、宿主 commit、插件 commit、Node 版本、候选 provider/model、各场景通过/失败，以及首次路由和后续强度评估的延迟与费用；不要记录消息正文或 token。真实 Gateway 验收须由有凭证的维护者运行，不是发布前可跳过的自动测试。
