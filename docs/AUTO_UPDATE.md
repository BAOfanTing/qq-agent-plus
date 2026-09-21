# GitHub 自动更新部署

## 运行边界

自动更新由主进程之外的两个 systemd 用户单元执行：

```text
qq-agent-linux-update.timer
  -> qq-agent-linux-update.service
  -> scripts/auto-update.mjs
  -> deploy.sh
```

timer 每小时唤醒一次，应用配置中的 `intervalHours` 决定是否已经到达实际检查时间。
默认每 6 小时检查一次，功能默认关闭。更新器不复用聊天 Session，也不调用模型。

## 更新依据：只认已发布的 Release

更新提示与部署目标都以 GitHub 上**已发布的 Release** 为准，不会因为 branch 上多了一个提交就更新，
避免用户装上未经发布的中间状态：

1. 读取仓库最新 Release（草稿、预发布都不算）。仓库还没有 Release 时不提示、不更新。
2. 用「当前部署 revision...Release tag」的比较结果判断方向：

   | 比较结果 | 含义 | 行为 |
   | --- | --- | --- |
   | `ahead` | Release 领先当前部署 | 提示新版本，部署目标即该 tag 的提交 |
   | `diverged` | 两条线各有提交 | 按 Release 部署（以发布版本为准） |
   | `behind` | 当前部署已经包含该 Release | 提示“已是最新”，不回退 |
   | `identical` | 就是同一个提交 | 提示“已是最新” |

3. 比较接口不可用时既不提示也不部署，等下次检查——不猜方向，避免装错版本。
4. 当前部署 revision 不是 git 提交（压缩包安装等）时无法比较方向：控制台只说明不弹窗，
   但「立即更新」和自动更新会直接安装最新 Release（装完基线就变成 git 提交）。

发布流程：推送 `v*` tag 会触发 `.github/workflows/release.yml`，它先跑一遍与 CI 相同的检查，
再创建**草稿** Release。确认无误并发布后，控制台的“发现新版本”弹窗与自动更新才会看到这个版本。

## 配置

```json
{
  "autoUpdate": {
    "enabled": false,
    "ownerUin": "",
    "repository": "https://github.com/sakurawwwxh/qq-agent-plus.git",
    "branch": "main",
    "intervalHours": 6,
    "networkRetries": 4,
    "retryBaseMs": 1500,
    "retryMaxMs": 15000,
    "connectivityTimeoutSeconds": 20,
    "fetchTimeoutSeconds": 300,
    "forceHttp11": true,
    "disableOnFailure": true
  }
}
```

- 仓库只接受 GitHub HTTPS 地址。
- 分支名经过格式校验，默认 `main`；控制页可直接切换目标分支。
- `networkRetries` 是网络操作失败后的额外重试次数，范围 0–10。
- 重试采用指数退避：从 `retryBaseMs` 开始，最多增长到 `retryMaxMs`。
- `connectivityTimeoutSeconds` 控制轻量连通性预检超时；`fetchTimeoutSeconds` 控制实际 Git 拉取超时。
- `forceHttp11=true` 时 Git 使用 HTTP/1.1，并设置低速保护，可规避部分 HTTP/2 / GnuTLS 链路抖动。
- `disableOnFailure=true` 保持旧行为：更新失败后暂停后续自动更新；关闭后失败只记录并告警，后续周期继续尝试。
- 管理员 QQ 必须位于私聊白名单（单独的“测试 GitHub 连通性”不要求配置管理员）。
- 控制台“控制 -> 更新部署”可保存网络策略、测试连通性、立即手动更新、暂停或恢复自动更新。

## 更新流程

1. 使用 `data/update-repository.git` 作为持久 bare 仓库，保留 Git 对象缓存。
2. 先执行目标仓库 + 目标分支的 `git ls-remote` 轻量连通性测试；失败时按配置重试。
3. 连通性正常后读取最新已发布 Release，并按上一节的口径判断方向；没有可部署的版本时记录“已是最新”并结束。
4. 浅拉取该 Release 的 tag（`refs/tags/<tag>:refs/tags/<tag>`），解析出它指向的提交；
   与 `data/deployed-revision` 相同则记录“已是最新”并结束。`git fetch` 同样按配置重试。
5. 将目标提交检出到 `data/update-work/` 的临时目录。
6. 在独立临时数据目录中执行 `npm ci`、全部 `node:test` 单元测试及关键语法检查，不读取或修改生产数据。
   `npm ci` 使用 `--prefer-offline` 优先复用 npm cache，并把同一组重试参数传给 npm 的 fetch 层。
7. 调用目标提交中的 `deploy.sh`。部署脚本创建代码快照、保留数据和凭据、重装依赖、
   校验 systemd 单元、启动服务并检查 `/healthz`。
8. 成功后记录目标提交（`currentRevision`）与 Release tag（`targetVersion`）；失败时由 `deploy.sh` 恢复旧代码和服务。

`deploy.sh` 会同时安装和校验更新 service/timer，并在部署失败时恢复旧单元及原启用状态。

## 两条下载通道：git 与 API + 源码包

有些网络到 `github.com` 的 **git 通道**是黑洞（TCP 能连上但 `ls-remote` 一直卡到超时），
而 `api.github.com` 与 `codeload.github.com` 是好的。遇到这种情况不必手动升级：

1. `git ls-remote` 连通性预检失败后，会再用 GitHub API 探同一个仓库/分支
   （`GET /repos/<owner>/<repo>/commits/<branch>`）。它也失败才算真的不通（错误与告警逻辑不变）。
2. 判定要部署的 Release 后，用 API 把 tag 解析成 commit（`/commits/<tag>` → `sha`），
   再从 `codeload.github.com/<owner>/<repo>/tar.gz/<sha>` 拉该提交的源码包，
   用系统 `tar` 解开到工作目录（去掉压缩包顶层目录）。
3. 两条通道都是 HTTPS、都以 GitHub 给出的 commit sha 为锚点，后续步骤
   （`npm ci` → 单元测试 → `deploy.sh`）完全一致；`deploy.sh` 靠
   `QQ_AGENT_SOURCE_REVISION` 记录版本，不依赖工作目录里有 `.git`。
4. 解析 tag 与取源码各自都会**先试首选通道、失败再换另一条**：git 通了就用 git，
   git 不通就走 API，API 中途失败还会回退 git。本次实际走的通道记录在
   `data/auto-update.json` 的 `transport` 与 `connectivity.transport`（`git` / `api`）。
5. 源码包设了 64 MiB 上限，避免异常地址把内存吃满。
6. `QQ_AGENT_CODELOAD` 可覆盖 codeload 基地址（测试桩或自建镜像用），普通部署不需要设置。

## 连通性测试

控制页中的“测试 GitHub 连通性”会提交一个独立 `probe` 请求：

- 先走 Git transport（`git ls-remote`）检查目标仓库与分支；git 通道不通时自动改用
  GitHub API 探同一个分支，两条都失败才判定不通。
- 会应用 HTTP/1.1、超时、重试和指数退避设置。
- 不执行 `git fetch`、`npm ci`、测试或部署。
- 测试失败不会修改自动更新开关，也不会发送部署失败告警。
- 结果保存在 `data/auto-update.json` 的 `connectivity` 字段中，控制页可看到尝试次数、耗时、
  实际通道（`transport`）、目标 revision 和错误。

## 失败策略

检查、测试或部署失败都会在 `data/auto-update.json` 保存失败阶段、脱敏错误和目标提交，并在服务可用且 OneBot 已连接后向管理员发送一次通知。

`disableOnFailure=true` 时：

1. 将 `autoUpdate.enabled` 持久化为 `false`。
2. `autoDisabled=true`，timer 后续唤醒不会继续部署。
3. 管理员核对后可从控制页恢复自动更新。

`disableOnFailure=false` 时：

1. 自动更新开关保持原状。
2. `autoDisabled=false`，下一个检查周期仍会继续尝试。
3. 告警会明确说明自动更新保持启用，而不是误报“已停止”。

通知发送失败时保留 pending 状态，Agent 启动或 OneBot 重连后继续发送。不会因为告警失败再次触发部署，也不会递归创建异常。

“没有新 Release”“当前部署已包含最新 Release”“比较接口不可用”都不算失败：不发送告警、
不触发 `disableOnFailure`，只在状态文件与控制页“更新部署”面板里说明原因。

## 状态与运维

状态文件：

```text
data/auto-update.json          # 状态、连通性、updateNotice（弹窗判定结果）、ignoredVersion
data/auto-update-request.json  # 一次性请求（manual / scheduled / probe）
data/deployed-revision         # 当前部署的 git 提交，deploy.sh 写入
```

`updateNotice` 里 `reason` 的取值：`no-release`（还没有 Release）、`ahead-of-release`（当前部署已包含最新 Release）、
`unknown-deployed`（部署基线不是 git 提交）、`compare-failed`（无法比较方向）、`unreachable`（连不上 GitHub）、
`unconfigured`（没配仓库）。`available=true` 时才弹窗，`version` 即要部署的 Release tag。

判定用的 GitHub API 默认是 `api.github.com`；只有测试桩或自建镜像才需要设置 `QQ_AGENT_GITHUB_API` 覆盖它。

接口：

```text
GET  /api/auto-update/status
PUT  /api/auto-update/settings
POST /api/auto-update/run
POST /api/auto-update/pause
POST /api/auto-update/resume
POST /api/auto-update/notify-pending
```

高级网络配置由控制页通过通用 `/api/config` 持久化；连通性测试使用一次性的 `probe` 请求，不新增额外常驻服务。

命令：

```bash
manage.sh update-status
manage.sh update-now --confirm
manage.sh update-pause --confirm
manage.sh update-resume --confirm
```
