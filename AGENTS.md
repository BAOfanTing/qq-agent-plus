# Repository Instructions

When adding or changing an experimental feature, follow
[`docs/EXPERIMENTAL_FEATURE_STANDARD.md`](docs/EXPERIMENTAL_FEATURE_STANDARD.md).

In particular:

- treat each experimental feature as an independently owned module;
- keep the experiment settings page limited to enable/disable and graduation;
- give any feature with operational UI its own page;
- keep runtime enablement separate from the persistent `graduated` state;
- preserve data while disabled and never auto-retry unknown external writes.

## 本地访问 Web 控制台（给用户/协作者的入口）

控制台默认只监听服务器本机 `127.0.0.1:3210`，不对外开放。两条等价入口：

- **Windows（无需 Node）**：仓库根目录 `console-tunnel.bat`。双击即用；首次运行输入
  `user@host` 并记住（写入 `.console-tunnel.cfg`，已 gitignore），自动通过 SSH 读取服务器上的
  控制台令牌并免登录打开浏览器；`test` 子命令只做连通性自检（返回 `TEST_OK` / 非零退出），
  `forget` 清除记住的地址。
- **macOS / Linux / 本机有 Node**：`SSHHOST=user@host node src/ops.js console --open`
  （`console --print` 只打印 ssh 命令）。

两者行为必须保持一致：同样经 `ssh -L` 隧道转发 3210（控制台）/ 5099（SnowLuma WebUI）/
6081（QQ 扫码登录），不要求服务器开放任何公网端口。改其一请同步改另一个。

## 发布节奏

- **影响使用的紧急问题**（部署失败、消息发不出/收不到、数据或安全问题）：修完测完即发补丁版。
- **不影响使用的**（文案、观感、边角误报、体验优化、内部加固）：先合入 `main`、同步到服务器自测，
  然后**攒着** —— 攒够一批或与下个功能版一起发。一天最多一版为宜。
- **默认只部署到自有服务器**：改完推 `main`、同步到线上跑着看，不推 tag、不发 Release；
  攒够了再一起发。别为了单个修复开一期版本。
- 发版流程见 [`docs/AUTO_UPDATE.md`](docs/AUTO_UPDATE.md)：推 `v*` tag → 工作流先跑与 CI 相同的检查、
  再建**草稿** Release → 填说明后发布。不要另用 `gh release create`：同一个 tag 会多出重复草稿。

