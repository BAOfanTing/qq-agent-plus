# 长期向量记忆（实验性）

长期记忆是 QQ Agent Plus 主进程内的实验模块，不需要额外容器、服务令牌或向量数据库。它和现有人物印象、会话 handoff 分工不同：人物印象保存稳定画像，handoff 保存当前会话状态，长期记忆保存可按语义找回的事件、项目进度、约定和群内知识。

## 生命周期

- `enabled`：是否运行自动召回和后台写入；默认关闭。
- `mode=shadow`：会写入并记录召回结果，不会影响 QQ 回复。
- `mode=active`：将筛选后的记忆临时注入当前轮回复。
- `graduated`：是否显示为正式导航项目；与 `enabled` 独立。

禁用不会删除已有数据，也不会发起模型总结或 Embedding 请求。

## 存储与检索

所有数据位于 Agent 的数据目录：`living-memory/living-memory.sqlite`。同一 SQLite 文件保存记忆卡片、来源回合、Embedding 向量和向量状态；删除或归档记忆会在同一事务边界内移除或停用对应向量。

召回始终按当前会话隔离，可选加入管理员全局知识。先执行关键词候选检索；配置 Embedding 后，主进程会对当前作用域的本地向量做余弦相似度排序，再与关键词、重要度和时效性合并评分。默认每次最多扫描 20,000 条当前作用域的向量，可通过 `LIVING_MEMORY_VECTOR_SCAN_LIMIT` 调整到 100,000。

Embedding 未配置时，记忆保存、管理和关键词检索仍可正常使用。首次还没有已向量化卡片时，也会直接走关键词检索，不会为无结果的语义检索额外调用 Embedding。

## Embedding 配置

Embedding 使用 OpenAI 兼容的 `/embeddings` 接口，凭据只从运行进程的环境变量读取，不会写入 `config.json` 或返回给控制台：

```bash
LIVING_MEMORY_EMBEDDING_BASE_URL=https://example.com/v1
LIVING_MEMORY_EMBEDDING_API_KEY=...
LIVING_MEMORY_EMBEDDING_MODEL=BAAI/bge-m3
LIVING_MEMORY_EMBEDDING_DIMENSIONS=1024
LIVING_MEMORY_RECALL_VECTOR_TIMEOUT_MS=1200
LIVING_MEMORY_VECTOR_SCAN_LIMIT=20000
```

`LIVING_MEMORY_EMBEDDING_DIMENSIONS=0` 时，会从首次成功响应推断维度。实时语义分支超过 `LIVING_MEMORY_RECALL_VECTOR_TIMEOUT_MS` 时，系统保留关键词结果并标记为降级，不让 QQ 回复因检索超时。

外部 Embedding 模式下，记忆摘要和正文会发送给配置的 Embedding 提供商。私聊、全局记忆和敏感信息策略由长期记忆设置控制。

## 从旧外置服务迁移

早期试验版可能把卡片和来源回合放在独立的 `living-memory` 服务中，并把向量放在 Qdrant。内置版提供可重复执行的迁移脚本：它只追加不存在的卡片/回合 ID，保留卡片的创建与更新时间，绝不覆盖已在内置库中修改过的数据。

先停掉旧 Agent 与旧记忆服务，确保旧 SQLite 的 `-wal` 文件不再变化；然后先预演：

```bash
node scripts/migrate-living-memory.mjs \
  --from /path/to/legacy/living-memory.sqlite \
  --to /data/living-memory/living-memory.sqlite \
  --dry-run
```

确认统计无误后执行，并使用当前进程的 `LIVING_MEMORY_EMBEDDING_*` 环境变量重建本地向量：

```bash
node scripts/migrate-living-memory.mjs \
  --from /path/to/legacy/living-memory.sqlite \
  --to /data/living-memory/living-memory.sqlite \
  --reembed --confirm
```

迁移不会复制 Qdrant 向量：它们是外部索引的实现细节，且可能与当前 Embedding 模型或维度不兼容。回填失败的卡片仍保留并可关键词检索；脚本可以安全重跑，只会继续导入缺失记录和重试未就绪的向量。

Docker 部署可参考 [`deploy/docker-compose.living-memory-builtin.yml`](../deploy/docker-compose.living-memory-builtin.yml)。该模板只启动 Agent 容器；Embedding 配置通过部署环境变量注入，不需要服务令牌、Qdrant 或 `living-memory` sidecar。
