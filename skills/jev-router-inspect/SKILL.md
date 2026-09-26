---
name: jev-router-inspect
description: 查看 dsh-jev-router 的会话选择、推理强度记录、Jev 评估用量与费用，并按需判断是否该另开会话换模型。Use when asked about auto/jev routing, Jev cost, or whether a DeepSeek Harness session should switch models.
---

# Jev 路由检查

`scripts/inspect.mjs`（相对本 skill 目录）只读路由器状态（`~/.dsh-jev-router/sessions`）和 Harness 会话日志（`~/.dsh/sessions`），输出 JSON。路径不同时加 `--state-dir` / `--dsh-home`。读压缩会话日志需要 `zstd` 命令。

```bash
node scripts/inspect.mjs sessions                     # 最近会话：模型、选择方式、当前档位、评估次数和费用
node scripts/inspect.mjs show <session-id|latest>     # 单个会话：选择、档位分布、降级、失败原因、截断、用量
node scripts/inspect.mjs check <session-id|latest>    # 问 Jev：保持当前模型，还是另开会话换一个
```

用户没指明会话时用 `latest`，并在回答里写出会话 id，方便对上。

## 费用

`show` 的 `ledger.usage` 是会话里全部 Jev 评估的合计。`gatewayCostUsd` 是网关报告的费用；网关报 `0` 时，只有用户给出单价才估算：加 `--input-price` / `--output-price`（每百万 token 美元），读 `estimatedCostUsd`。不要自己假设单价。`evaluationsWithoutUsage` 大于 0 表示有评估没拿到用量，合计偏低。

没有 ledger 记录时，说明插件配置了 `ledger: false`，或会话早于用量记录功能。

## 换模型建议

`check` 会把最近用户和助手正文发给 Jev，需要 `AI_GATEWAY_API_KEY`，而且会产生一次评估费用。先告诉用户这两点；只想看会发什么时用 `--dry-run`。

- `suggestion: "keep"`：说明继续用当前模型。
- 其他值是具体 `provider/model`：建议用户**另开会话**，指定这个模型、推理强度选「自动」。同一会话里再选 `auto/jev` 会重新选模型，但丢掉当前前缀缓存，只在用户接受时提。
- 同时给出 `probabilities` 中建议项与 `keep` 的概率；两者接近时说明建议不强。
- 本次 `check` 的用量在返回的 `usage` 里，一并报给用户。

## 解读要点

- `selection.modelMode` 为 `auto (not yet chosen)`：第一次主请求还没成功，没有会话模型。
- `effortsByModel` 是每次主请求实际用的档位分布，包括降级（`fallbackSources`）。
- `failureReasons` 里 `HTTP 5xx`、`timeout`、`network` 是临时故障；`credential`、`body-limit`、`invalid-answer` 是配置或数据问题，建议用户查配置。
- `shortenedEvaluations` 是因超出 28,000 字节而丢弃旧消息或截断的评估次数。
- `probabilityDecisions` 展示成功评估的选项概率、最高项 `top`、次高项 `runnerUp` 和概率差 `margin`。`status` 为 `available` / `missing` / `invalid`；旧记录视为缺失，单选项与降级不计入。概率差仅用于观察选项区分程度，不是任务成功率，也不是自动升降档的依据。
