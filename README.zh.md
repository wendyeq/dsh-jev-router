# dsh-jev-router

可选 Cordis 插件：通过官方 `typesafe-ai/jev` evaluate API 为会话选定模型，并在每次主请求上选择推理强度。将 bundle 挂在 Harness profile 的模型适配器、Session Controller、AgentLoop 和凭证插件旁边。补丁默认禁用；用 profile 覆盖启用，并用 `credentialRefs` 配置 Vercel AI Gateway Bearer token 的 Harness 凭证引用。插件不直接读取环境变量，也不注册生成模型适配器。

术语见 [CONTEXT.md](CONTEXT.md)。第一版范围见 [ROADMAP.md](ROADMAP.md)。真实宿主的安装、回退和验收见 [P0 安装与验收](docs/p0-acceptance.md)。英文说明见 [README.md](README.md)。

## 宿主

上游 DeepSeek Harness 没有本插件使用的选择器事件和 `configuration-update` 内容块。请配合 [wendyeq/deepseek-harness](https://github.com/wendyeq/deepseek-harness) 的 `local/jev-host` 分支，从 `737a4c131e` 或其后续提交运行。测试从旁边的 `../deepseek-harness` 检出导入。本地测试不代替需要 Gateway 凭证的真实验收。

## 共享推理策略

`gpt-6-astra`、`gpt-6-luna` 和 `gpt-6.1-sol` 的自动推理强度来自旁边的 `../jev-router-policy/src/index.ts`。源码用这条相对路径导入，没有写入 `package.json` 依赖，也没有机器绝对路径。`npm run build` 把这份源码打进 `dist/index.js`。宿主加载的是这个包，不是旁边的目录。只改策略源码不会生效，要重新构建，并在下次启动宿主时加载新的 `dist/index.js`。Pi 在加载扩展时读取同一份文件；本插件不会。

## 选择

模型列表增加 `auto/jev`，推理强度列表增加「自动」（内部值 `auto/jev`）。

第一次主请求先让 Jev 在已配置且当前已注册的自动模型中选会话模型，再从该模型支持的档位里选择最低够用的推理强度。两次都成功后，会话模型在该会话内保持不变；之后的主请求只重新选择推理强度。同一会话里再次选择 `auto/jev`，原来的会话模型作废。只改任务说明不会重选。指定模型保持不变，无论推理强度是自动还是指定。

子会话不另选会话模型，沿用父会话已经选定的具体模型，推理强度沿用父会话的选择方式。父会话还没有会话模型时，子会话路由失败。会话模型和选择方式写在每个 Session 的原子 sidecar 里，恢复后仍在。评估出来的强度不是用户的指定推理强度。

一条模型路由的第一次强度是请求级设档（Responses 用 `reasoning.effort`，Chat Completions 用 `reasoning_effort`），并写入 sidecar。同一路由之后的改档在下一条用户消息前追加一条 `configuration_update`，不改写请求级强度，因此这条更新之前的前缀缓存仍能命中。新档位一直生效，直到下一次更新。两条更新不会相邻；压缩删掉上一条之后，下一次请求补一条。Chat Completions 没有 `configuration_update`，之后的改档作为新的 `reasoning_effort` 发送。切换具体模型会开启新的缓存上下文，并重新设档。

首次主请求会先记下自动推理强度的 `model/selection`，避免界面把当次请求强度看成用户选定的档位。旧会话在下一次主请求时补记。

### Jev 读到什么

只有主请求询问 Jev。标题和压缩这类旁路请求使用具体会话模型和适配器默认强度，不询问 Jev，也不选定会话模型；还没有会话模型时，旁路请求失败。请求头和 provider 调用只有已注册的具体路由，没有选择器标记。

选会话模型时，最多最近 8 条用户和助手正文。选推理强度时还可以带工具结果正文，每条 1600 字。系统与开发者提示、工具参数、推理块和图片不参与。请求体超过上限时，先丢掉较早的整条消息，最新一条用户消息始终保留；只剩它仍放不下时，保留开头和结尾，中间注明省略了原文多少字中的多少字。诊断日志只记丢弃条数和省略字数。

选推理强度时，还会带上本会话同一路由上一轮实际生效、且仍在可选档位内的强度。正常选档可以把它作为保持理由，没有明确理由时保持当前档位；连续失败、不确定性未解决或下一步决策困难时可以升档。这是本次决策之前的档位，不是本次决策的结果。没有可用上一档时（通常是首次主请求）省略该字段，选会话模型时不带。连续临时故障的降级逻辑不变。

### 失败、重试与降级

没有用户正文、没有可用的自动模型或档位、回答无效、缺少凭证、超时、取消，或缩到只剩标注仍放不下（例如选项说明过长），这次请求路由失败。请求体上限是 28,000 个 UTF-8 字节。只剩一个选项时直接使用，不问 Jev。

临时故障等一秒再试，最多再试两次（一共三次）：HTTP 408、429、500、502、503、504，网络错误，以及单次尝试超时。每次尝试最多 5 秒，第一次把读凭证的时间也算进去；加上两次等待，总上限 17 秒。凭证读取卡住不重试。其余 HTTP 4xx、无效结果、缺少凭证不重试。选模型失败不改用其他模型。

推理强度三次都是临时故障时才降级：用同一模型上一次已经发出的有效档位；还没有上一档时用适配器支持的默认档。默认档低于配置下限时用下限档。仍然没有可用档位则失败。已有的会话模型不会因为强度降级被取消。

## 配置

`enabled` 默认 `false`。启用时配置里至少要有一条 `candidates`（`model`、`description`，可选 `provider`）。这个字段名是配置键；文档里把它叫做自动模型。模型 ID 不写在代码里。

`effortDescriptions` 按模型 ID，或更具体的 `provider/model`，写各档说明。只有当前适配器实际支持的档位会进入选择题；没写说明的档位用适配器自己的描述或名称。

`effortFloors` 用同样的键写自动推理强度的最低档。适配器按从低到高列出档位，只提供下限这一档和更高的档位。只剩一档时不问 Jev。模型不支持所配的下限时，这次请求失败，不会忽略该配置。指定推理强度不受下限影响。

示例是 [`examples/jev-policy.patch.yml`](examples/jev-policy.patch.yml)。复制到私有 profile 覆盖层，填上 Harness 凭证引用后再把 `enabled` 设为 `true`。dsh 的补丁会替换整份配置，不能只覆盖 `enabled`。改说明只影响之后的评估，不重选已经选定的会话模型。

`logDecisions` 默认 `false`。测试时设为 `true`，Harness 日志会有 Session id、评估类型、尝试次数、HTTP 状态、耗时、选中档位、临时故障原因和降级来源。不记录正文、请求体或凭证，也不写入 Session 日志。绝对路径 `diagnosticLogFile` 把同样的脱敏事件追加成 JSONL（新文件权限 `0600`）。文件不会自动轮转，查完请自己删。写入失败只告警，不打断生成。

`credentialRefs` 默认空。有多个选项时至少要有一个凭证引用。`stateDirectory` 默认 `~/.dsh-jev-router/sessions`，必须是绝对路径。`maxBodyBytes` 和 `timeoutMs` 可以调低，不能超过第一版的上限。sidecar 和 Session 日志一起留；不同安装如果复用 Session id，不要共用状态目录。

## 检查与费用

状态目录里每个 Session 有一份 `<session-id>.ledger.jsonl`（权限 `0600`）。每次 Jev 评估记下问题类型、结果、选中的模型或档位、尝试次数、耗时、token 数和网关报告的费用；降级另记一条。不记录正文、请求体或凭证。写入失败只告警。`ledger: false` 关闭它。启动时把这次进程实际使用的自动模型、档位说明和下限写到 `_policy.json`。

成功评估还会记下 Gateway 返回的选项概率 `probabilities`。`probabilityStatus` 是 `available`、`missing` 或 `invalid`。只接受刚好覆盖全部选项、每个值在 0–1、总和允许两位小数舍入误差的分布，不重新归一化。概率缺失或无效不影响选择，也不因此重试。旧账本没有概率时视为缺失。只有一个选项、因而跳过评估时，没有概率。`show` 的 `probabilityDecisions` 列出每次成功评估的分布、最高项、次高项和概率差 `margin`。这些数只供观察，不是任务成功率，也不会自动升降档。

本仓库带有 skill `dsh-jev-router-inspect`。它读上述文件和 Harness 会话日志，查看会话选择、档位分布、降级、失败原因和费用，并可按需问 Jev：保持当前模型，还是另开会话换一个。只给建议，不切换模型。安装到 `~/.agents/skills`（dsh 也会读这个目录）：

```bash
npx skills add wendyeq/dsh-jev-router --skill dsh-jev-router-inspect -g
```

按需检查换模型需要环境变量 `AI_GATEWAY_API_KEY`，每次检查产生一次评估费用。读取压缩的会话日志需要 `zstd`。

## 生成体验

第一次自动路由是两次小型 Jev evaluate；之后每次主请求一次推理强度评估。只有一个选项时不调用。这些调用用的是用户的 gateway 配额，不是所选模型的生成 token。真正生成仍走选定适配器自己的 token 计量和 KV 缓存。切换具体模型会开启新的 provider 缓存上下文。之后的改档保持请求级强度；Responses 追加 `configuration_update`，该条之前的前缀仍可命中。选择器的值不会发给适配器。

## 限制

第一版不在后台寻找更合适的模型（由 skill 按需检查），不自动加载 skill，不把超长评估拆成多段再合并，不重试超过两次，也不在多次评估之间共用超时预算。Session 迁到另一台机器时，sidecar 需要双方都能读到的持久存储。Harness 会持久保存会话选择和生成请求头；任务说明的更新只影响以后的评估。
