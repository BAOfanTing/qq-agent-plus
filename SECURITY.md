# 安全政策

## 支持的版本

只对最新的正式 Release 提供安全修复。

## 报告漏洞

**请不要用公开 issue 报告安全漏洞**（尤其是涉及 Token 泄露、命令注入、SSRF、
提示词注入绕过权限这类问题）。

请用 GitHub 的 [Private vulnerability reporting]（仓库 Security 标签页 →
Report a vulnerability）私下报告，通常 72 小时内会有首次回应。

报告时请附上：复现步骤、影响范围、以及（如果可能）最小化的 PoC。

## 这套系统默认暴露哪些东西

部署时请自查这几类面，均不应直接暴露公网：

- 控制台 HTTP 服务（默认 3210）：有 Token 鉴权，但只应通过 SSH 隧道或内网访问；
- OneBot WebSocket/HTTP 端口：只监听 127.0.0.1，供协议端与本程序通信；
- `data/` 目录：config.json（含模型 Key、控制台 Token）、消息库、身份库均为敏感数据，
  权限 0600，请勿放入版本库或公开目录。

## 处置承诺

确认后按严重程度修复并发布补丁版本；影响已发布 Release 的会在 Release 页说明。
