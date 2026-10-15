# 示例插件：Minecraft 服务器状态

社区反馈（issue #37）里那个诉求的完整实现：**让机器人能查一台 Minecraft 服务器现在有谁在线**。
它同时是"一个插件长什么样"的活文档 —— 不依赖任何 npm 包，只用一个文件和一段 JSON 协议
（契约见 `docs/PLUGINS.md`）。

## 它给模型加了什么

一个只读工具 `mc-status.players`：

- 参数：`host`（服务器地址，例如 `play.example.com` 或 `mc.example.com:25566`）
- 返回：在线人数 / 最大人数、版本、在线玩家名单（超过 30 人只列前 30）、服务器标语
- 上游：默认走公开状态接口 `https://api.mcsrvstat.us/3/{host}`
  （服务器的在线查询没开时只能看到人数，这时它会如实说明"没有公开名单"）

## 装（两种都行）

**A. 直接拷目录**（最简单，适合先在测试群试）：

```bash
cp -r examples/plugins/mc-status "$(你的数据目录)/plugins/"
```

然后把配置里的 `plugins.enabled` 打开、`plugins.enabledIds` 加上 `"mc-status"`，
或者直接在控制台「设置 → 插件」里点「启用」。**装上 ≠ 授权**：不启用它不会跑。

**B. 打成 tar.gz 走一键安装接口**（适合分发给别人）：

```bash
tar --format=ustar -czf mc-status-1.0.0.tar.gz -C examples/plugins mc-status
sha256sum mc-status-1.0.0.tar.gz        # 把这个值连同下载地址一起给别人
```

对方在控制台「设置 → 插件」页或调 `POST /api/plugins/install`
（body: `{"url": "...", "sha256": "..."}`）即可。注意安装器**必须**校 sha256，
而且只认 `ustar` 格式（pax 长路径头会被拒并提示重打）。

## 你可以照着改什么

- **换接口**：配置 `plugins.settings.mc-status.statusUrl` 指到你自己的状态页（`{host}` 是占位符）。
  这样连内网的服务器也能查（前提是那个地址从机器人这台机器上可达，并且不是内网地址 ——
  宿主侧的网络守卫会拦内网，见 `docs/PLUGINS.md` 的信任声明）。
- **加工具**：在 `plugin.json` 的 `tools` 里加一条声明，再在 `index.mjs` 的 `tools` 里加一个函数。
  manifest 里声明了才会给模型看；没声明的调用会被宿主拒。
- **加周期任务**：manifest 里加 `schedule`，宿主会按 `everyMs` 到点触发 `schedule` 方法 ——
  定时器在宿主手里，插件重启也不会丢。
