# 缓存优化方案（2026-03-30）

## 背景
当前只读工具缓存主要在“单次任务（当前问题）”内生效：
- 同一步内去重
- 同一任务后续步骤复用 `previousSteps`

跨消息、跨任务、跨重启基本无法命中，导致重复调用较多。

## 目标
- 提升跨任务命中率，减少重复只读工具调用耗时与成本
- 保持正确性与可控失效
- 用指标验证收益，避免“加了缓存但看不到效果”

## 分阶段方案

### Phase 1：进程内缓存（LRU + TTL）+ SingleFlight（优先）
实施范围：
- 只读工具（`readonly=true`）接入全局缓存层
- Key：`tool + normalizedArgs + scope + promptVersion`

关键点：
- LRU 控制最大容量（如 500~2000）
- TTL 按工具配置（默认值 + 工具覆盖）
- SingleFlight：同 key 并发请求只执行一次，其他请求复用同一个 Promise

收益：
- 实现成本低，收益快
- 解决并发击穿与大量重复请求

---

### Phase 2：持久化缓存（跨重启）
实施范围：
- 在 Phase 1 稳定后，将热点缓存落盘（SQLite 或 Redis）

关键点：
- 启动预热（可选）
- 存储字段：`key / value / createdAt / expiresAt / toolVersion`
- 清理策略：过期淘汰 + 容量淘汰

收益：
- 重启后仍可命中
- 启动后一段时间性能更稳定

---

### Phase 3：负缓存 + 精细失效
实施范围：
- 对稳定错误做短 TTL 负缓存（如 404、参数非法）
- 增加可控失效策略

关键点：
- 负缓存 TTL 较短（5s~60s）
- 不缓存不稳定错误（如超时、5xx）
- 支持按工具/按 key 手动失效
- 支持版本失效（工具实现变化自动失效旧缓存）

收益：
- 减少重复失败调用
- 提高缓存可维护性

## 缓存 Key 建议
- `toolName`
- `normalizedArgs`（排序后 JSON）
- `scope`（建议至少包含 tenant/chat 或业务隔离维度）
- `modelOrPromptFingerprint`（避免 prompt 变化导致错复用）
- `toolVersion`

示例：
`readonly:{tool}:{hash(normalizedArgs)}:{scope}:{toolVersion}:{promptFingerprint}`

## TTL 建议（示例）
- `get_current_time`：1~5s
- `http_request`：
  - 明显静态地址：5~30min
  - 动态接口：10~60s
- 计算类纯函数（如表达式计算）：可长 TTL（甚至永久 + 版本失效）

## 指标与验收
建议新增指标：
- `cache_hit_total`
- `cache_miss_total`
- `cache_stale_total`
- `cache_evict_total`
- `cache_singleflight_join_total`
- 按 tool 维度拆分（`:toolName`）

验收标准（建议）：
- 高频场景命中率 > 40%
- 平均工具调用耗时下降 > 20%
- 同 key 并发时执行次数显著下降（SingleFlight 生效）

## 风险与控制
- 风险：错误复用、过期策略不合理、内存增长
- 控制：
  - 默认仅缓存 `readonly` 工具
  - 严格 TTL + LRU 上限
  - 版本指纹参与 key
  - 先灰度（仅部分工具启用）

## 推荐落地顺序
1. 先做 Phase 1（LRU + TTL + SingleFlight）
2. 指标观察 3~7 天
3. 再做 Phase 2（持久化）
4. 最后做 Phase 3（负缓存和高级失效）
