# dsh-jev-router

可选 Cordis 插件：通过官方 `typesafe-ai/jev` evaluate API 选择具体会话模型，以及每次主请求的推理强度。将 bundle 挂在 Harness profile 的模型适配器、Session Controller、AgentLoop 和凭证插件旁边。补丁默认禁用；使用 profile 覆盖启用，并通过 `credentialRefs` 配置 Vercel AI Gateway Bearer token 的 Harness 凭证引用。插件不直接读取环境变量，也不注册生成模型适配器。

## 宿主

上游 DeepSeek Harness 没有本插件使用的选择器事件和 `configuration-update` 内容块。请配合 [wendyeq/deepseek-harness](https://github.com/wendyeq/deepseek-harness) 的 `local/jev-host` 分支，从 `737a4c131e` 或其后续提交运行。测试从旁边的 `../deepseek-harness` 检出导入。

## 选择

模型列表增加 `auto/jev`，推理强度列表增加「自动」（内部值 `auto/jev`）。第一次主请求先让 Jev 在已配置且已注册的模型路由中选模型，再从该模型支持的档位里选择最低够用的推理强度。两次成功后，会话模型保持不变；后续主请求独立选择强度。再次选择 `auto/jev` 会让原有会话模型作废；只修改任务说明不会。指定模型保持不变，无论其强度是自动还是指定。子会话沿用父会话的具体模型和强度选择方式；父会话尚未选定自动模型时，子会话路由失败。会话模型和选择方式保存在每个 Session 的原子 sidecar，恢复后保留。评估出的强度不是用户选择。一条模型路由的第一次强度是请求级设档（Responses 用 `reasoning.effort`，Chat Completions 用 `reasoning_effort`），并写入 sidecar。同一路由之后的改档会在下一条用户消息前追加一条 `configuration_update`，不改写请求级强度，这样前缀缓存仍能命中。新档位一直生效，直到下一条更新。两条更新不会相邻；压缩删掉上一条之后，下一次请求会补一条新的。Chat Completions 没有 `configuration_update`，之后的改档会作为新的 `reasoning_effort` 发送。切换具体模型会开启新的缓存上下文，并重新设档。首次主请求前会将自动强度的选择意图记录为 `model/selection`，避免 UI 将实际请求强度误当作用户的固定选择；旧会话在下一次主请求时补记。

只有主请求询问 Jev。标题和压缩请求使用具体会话模型及该模型适配器的默认强度；没有会话模型则失败。请求头与 provider 调用只包含实际注册的路由，不包含选择器标记。选模型时，Jev 最多读取最近八条用户和助手正文；选强度时还可读取每条最多 1600 字的工具结果正文。系统与开发者提示、工具参数、推理块和图片均不参与评估。没有用户正文、没有候选项或档位、无效结果、缺少凭证、超时、取消或请求体过大，都会使本次请求失败。仅 Jev HTTP 503 在一秒后重试，最多重试两次（共三次调用）；每次尝试最多五秒，含两次等待的总上限为 17 秒。强度评估连续 503 后，使用同一模型上一次已发送的有效档位；首次没有上一档时使用适配器支持的默认档位，否则失败。模型选择连续 503 时仍失败，不凭空选模型。其他错误不重试，也不使用备用模型。请求体上限为 28,000 UTF-8 字节。仅有一个选项时跳过 Jev。

## 配置

`enabled` 默认 `false`。启用时必须在配置文件提供至少一个 `candidates`（`model`、`description`，可选 `provider`）；模型 ID 不写死在代码中。`effortDescriptions` 按模型 ID 或更具体的 `provider/model` 配置档位说明；只有当前适配器实际支持的档位会进入选择题，未配置的档位使用适配器给出的描述或名称。参见 [`examples/jev-policy.patch.yml`](examples/jev-policy.patch.yml)：复制到私有 profile 覆盖层，设置 `enabled: true` 和 Harness 凭证引用后使用；不要只覆盖 `enabled`，因为 dsh 的补丁会替换整份配置。更新说明只影响之后的评估，不会重选已固定的会话模型。

`logDecisions` 默认 `false`；测试环境设为 `true` 后，通过 Harness 日志输出 Session id、评估类型、尝试次数、HTTP 状态、耗时、选中档位和 503 降级来源。不记录正文、请求体或凭证，也不写入 Session 日志。可设置绝对路径 `diagnosticLogFile`，将相同的脱敏事件追加为 JSONL（新文件权限 `0600`）；文件不会自动轮转，排查后请自行清理。写入失败只告警，不中断生成。`credentialRefs` 默认空列表；有多个选项时至少要配置一个凭证引用。`stateDirectory` 默认 `~/.dsh-jev-router/sessions`，须为绝对路径。`maxBodyBytes` 与 `timeoutMs` 可调低，不可超过第一版上限。sidecar 与 Session 日志一起保留；不同安装若复用 Session id，不应共用状态目录。

## Model Experience

首次自动路由需要两次小型 Jev evaluate 调用，此后每次主请求需要一次强度评估；只有一个选项时无需调用。这些调用消耗用户的 gateway 配额，而非选中 provider 的生成 token。实际生成沿用具体适配器的 token 计算和 KV 缓存；切换具体模型将开启新的 provider 缓存上下文。之后的改档保持请求级强度，Responses 会追加 `configuration_update`，该条目之前的前缀仍可命中缓存。选择器值不会发送给适配器。

## Known Limitations and Deferred Work

第一版不监控更合适的模型、不自动加载 skill、不拆分超长评估、不重试 HTTP 503 以外的错误、不设置强度下限，也不展示路由费用。Session 跨主机迁移时，需要共享持久化的 sidecar。Harness 的会话选择及生成请求头会持久记录；任务说明更新只影响后续评估。
