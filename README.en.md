<div align="center">

<img src="docs/assets/mark.svg" alt="QQ Agent Plus" width="104" height="104">

# QQ Agent Plus

**A QQ group-chat agent for Linux servers — sends separate bubbles, uses stickers, remembers people, ships with an ops CLI**

[![CI](https://github.com/sakurawwwxh/qq-agent-plus/actions/workflows/ci.yml/badge.svg)](https://github.com/sakurawwwxh/qq-agent-plus/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-3da639.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/sakurawwwxh/qq-agent-plus?color=e8b400&label=stars&logo=github)](https://github.com/sakurawwwxh/qq-agent-plus/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/sakurawwwxh/qq-agent-plus?logo=git&logoColor=white)](https://github.com/sakurawwwxh/qq-agent-plus/commits/main)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Platform](https://img.shields.io/badge/platform-Linux-0b5fff?logo=linux&logoColor=white)](docs/LINUX.md)
[![OneBot](https://img.shields.io/badge/protocol-OneBot%20v11-12b7f5)](https://github.com/botuniverse/onebot-11)
[![LLM](https://img.shields.io/badge/LLM-OpenAI%20%E5%85%BC%E5%AE%B9-6b4fbb)](#-highlights)

[简体中文](README.md) ｜ **English**

<img src="docs/assets/console-demo.png" alt="Console: message archive and session management" width="880">

</div>

A QQ group-chat agent for Linux servers. It talks to an external OneBot v11 service and runs
each turn as an isolated OpenAI Chat Completions session — no DSH, MCP, Electron or Windows runtime.

## ✨ Highlights

Every item below comes from a real failure we hit in production; [CHANGES](docs/CHANGES.md)
records the failure mode and the effect of each fix.

- **Conversation behaviour** — split replies across bubbles, read images by attitude instead of
  describing them, keep the sticker catalogue in the system prompt, self-check before finishing.
- **Send path robustness** — retry transient send failures, QQ system faces, message-id
  normalisation, inline tool-call fallback parsing.
- **Sticker system** — auto-collect with QQ favourites first, fuzzy lookup fallback, sync guard so
  an API hiccup cannot wipe the local library.
- **Proactive talk** — multiple active windows, interval guard, skip-reason logging, follow-up
  nudge when nobody answers, catch-up for messages missed during restarts.
- **Model access** — per-purpose thinking switch, retry on provider moderation refusals, automatic
  fallback model.

Configuration examples live in [docs/CONFIG-EXAMPLES.md](docs/CONFIG-EXAMPLES.md); every ops
command is collected in [src/ops.js](src/ops.js) and documented in [docs/OPS.md](docs/OPS.md).

## 🖼 Demo

Every ops command ships with the app (`src/ops.js`); read-only commands never touch your data.
The CLI prints Chinese — the samples below are the real output shape (excerpt):

```text
$ node src/ops.js audit
===== 1. 服务与定时器 =====
  [正常] qq-agent-linux.service  active
  [正常] qq-agent-linux-update.timer  enabled
===== 3. 源码语法（全部 js） =====
  [正常] 所有 js 文件语法通过（75 个）
===== 4. 未定义调用扫描 =====
  [正常] 可疑未定义调用点: 0
===== 8. 运行态 =====
  [正常] OneBot: connected=true …
===== 自检结论 =====
  全部通过（0 项异常）
（节选：实际共 11 段，含配置 / 数据文件 / 价格缺口 / 最近日志 / 主机资源等）

$ node src/ops.js watch-send --minutes=5
基线：outbox 最新 rowid=17，待处理消息 0 条
      最近一条人类消息：今晚还打不打
SEND_OK：机器人通过工具层成功回话 ｜ group:123456789 ｜ run=3f2c… ｜ state=sent ｜ 打啊
      人类上一条：今晚还打不打
```

One turn in a group chat (illustration — real chat logs are never published): after picking up
the other person's message the bot continues with its own half in separate bubbles, and uses a
sticker when it fits:

```text
member:  playing tonight?
bot:     yes
bot:     just finished dinner, give me ten minutes
bot:     [sticker: stop dawdling]
```

## 🧱 Architecture

```text
OneBot WebSocket
  -> serialised per conversation into SQLite
  -> SQLite/WAL message state machine
  -> bounded aggregation: random 8-12 s by default, 20 s maximum
  -> legacy / threaded / lifecycle routing
  -> optional persisted threads and checkpoints
  -> one-shot Agent session
  -> session-bound tools
  -> OneBot HTTP
```

A message is acknowledged only after the turn was handled successfully. A failed model call or a
restart leaves the batch pending, so it is retried; when a send result cannot be confirmed the row
goes to `held` and waits for a human, so the bot can never post the same reply twice.

## 🔔 When does it reply?

The response-probability slider on the chat-settings page decides how often the bot answers
**ordinary** messages — the number on the slider *is* the probability. `0%` answers only messages
that @ the bot, name it, or hit a keyword; `100%` answers everything. Batches that @ or name the
bot, or that hit a keyword, always get an answer, regardless of the probability. Every batch rolls
independently; there is no accumulated quota and no “N out of 100” allowance. You can set one
slider for everything, or turn the unified toggle off and drag a value per group — groups without
their own value, and all private chats, follow the global slider. Configurations from the old
four-band slider are converted once, on first load: `0-20` becomes `0%`, `20-90` maps linearly,
`90+` becomes `100%`. The new model has no “answers @ but not keywords” state, so an old `0-10`
setting will also answer keywords after the conversion.

## 🚀 Full-stack quick start

Full Linux stack (SnowLuma + OneBot + QQ Agent) on a fresh machine:

```bash
git clone https://github.com/sakurawwwxh/qq-agent-plus.git
cd qq-agent-plus
bash deploy-all.sh
```

The installer asks for the deployment directory and ports, installs Docker (needs sudo),
downloads SnowLuma, configures OneBot and writes all service credentials. SnowLuma already
contains OneBot — do not install NapCat or Lagrange on top of it.

Defaults: root `/mnt/data/qq-agent`, console `3210`, SnowLuma WebUI `5099`, noVNC (QQ login)
`6081`. OneBot HTTP `3000` and WebSocket `3001` bind `127.0.0.1` only. Generated credentials are
written to `/mnt/data/qq-agent/deployment-access.txt` with mode `0600`. The script never modifies
UFW, firewalld or cloud security groups; if you need cross-host access, open the three user-facing
ports to a trusted LAN or VPN only — never expose noVNC or OneBot to the internet.

The first install also asks for the model base URL, API key, model name and the group allowlist.
Open the printed noVNC URL, scan the QQ login QR code, then return to the terminal. Unattended
installs need explicit model flags:

```bash
bash deploy-all.sh --yes --root-dir /mnt/data/qq-agent \
  --agent-port 3210 --snowluma-port 5099 --novnc-port 6081 \
  --model-base-url https://api.deepseek.com \
  --model-api-key "$DEEPSEEK_API_KEY" --model deepseek-chat \
  --allow-groups 123456789
```

`--skip-model-config` defers the model setup to the console. An empty allowlist means the bot
answers nothing until you configure it. Re-running is allowed only for managed installations whose
recorded configuration still matches; a read-only dry run is available:

```bash
bash deploy-all.sh --check-only --root-dir /mnt/data/qq-agent
```

QQ login is the only unavoidable manual protocol step. The full option list, credential rotation
(`--rotate-credentials`, `--snowluma-totp`) and rollback behaviour are documented in the
[Chinese README](README.md#-全栈一键部署) and [docs/LINUX.md](docs/LINUX.md).

## 📦 Agent-only install

Use `deploy.sh` when a compatible OneBot v11 service already exists, or when only the Agent should
be installed or updated. Requirements: Linux with systemd user services, `curl`, `tar`,
`sha256sum`, `rsync`, and an OpenAI Chat Completions compatible model. If no suitable Node.js is
found, the script downloads and verifies Node 22 into `INSTALL_DIR/.runtime`.

```bash
bash deploy.sh \
  --install-dir /mnt/data/qq-agent/app \
  --data-dir /mnt/data/qq-agent/data \
  --host 127.0.0.1 \
  --port 3210
```

The script validates its arguments and `node:sqlite` support, installs production dependencies,
creates the data directory and console token, registers `qq-agent-linux.service` with automatic
restart, checks port and unit conflicts, starts a first install in `observe` mode, and snapshots
the code before an update so a failed install can be rolled back. `--no-backup` skips the snapshot
when you already have your own backup flow; `--import-bridge` copies configuration from an old
Bridge install without touching the old directory.

The console binds `127.0.0.1` — reach it through an SSH tunnel (`console-tunnel.bat` on Windows,
`node src/ops.js console --open` elsewhere), which also forwards the SnowLuma WebUI and the QQ
login noVNC. Updates use the same command and preserve the existing configuration, run mode and
data. The installer also installs the Release-driven auto-update service and timer: disabled by
default, enabled from the console after setting an administrator. Hints and deployments follow
**published Releases** only (drafts, pre-releases and ordinary commits on `main` do not count),
and a failed update rolls back and stops auto-updating.
See [docs/AUTO_UPDATE.md](docs/AUTO_UPDATE.md).

## 🎭 Personas

The persona page ships several built-in cards in [`roles/`](roles), one markdown file per card:
the default 小鲸鱼, a game-client-engineer variant, plus a sarcastic friend, a warm companion, a
homelab/tech nerd and a catgirl. Picking a card only fills the draft — nothing changes until you
save. Each card has a behaviour profile (legacy group-chat style or natural-and-reliable), and you
can add a custom copy based on the current draft. Editing a file under `roles/` only affects the
built-in templates of new installations; an instance keeps whatever role text was saved.

## ⏰ Time control

The time-control page is off by default and, while off, ignores every time rule. When enabled it
uses Asia/Shanghai and a default “DS off-peak” schedule (weekdays `00:00-09:00`, `12:00-14:00`,
`18:00-24:00`, plus all weekend); each chat can inherit the global rule, override it, or stay
active around the clock. Messages that arrive in an inactive window are archived but never
answered and never queued for catch-up. Model requests, tool rounds, retries, memory work and
sending are all gated; daily summaries and the console model test follow the same schedule.

## 🛠 Ops CLI

`manage.sh` covers the service itself:

```bash
bash manage.sh status          # also: logs / health / token / restart / observe
bash manage.sh activate --confirm-exclusive
bash manage.sh update-status
bash manage.sh update-now --confirm
bash manage.sh backup /path/to/new-backup-dir
```

Everything else lives in `src/ops.js`, Node built-ins only:

```bash
node src/ops.js help          # all subcommands
node src/ops.js audit         # service + code + data health check (read-only)
node src/ops.js audit-host    # host health check (read-only)
node src/ops.js scan --strict # undefined-call scan (CI runs it in strict mode)
node src/ops.js backup --confirm
node src/ops.js guard --confirm
node src/ops.js watch-send --minutes=5
node src/ops.js install-timers --print
```

Destructive commands require `--confirm` and support `--dry-run` / `--print` previews. Every
subcommand accepts `--help`. Paths and credentials come from environment variables
(`QQ_AGENT_*`, `SSH*`); no real addresses or secrets are stored in the repository.
See [docs/OPS.md](docs/OPS.md).

When the console says OneBot is not connected, the reason is in `onebot.error` — the health check
prints it, and the per-error triage table is in
[Troubleshooting](docs/LINUX.md#onebot-shows-not-connected). Note that `ops.js` probes the
protocol side on `3390` by default; if you left the installer default, add
`QQ_AGENT_ONEBOT_HTTP_PORT=3000`.

## 💾 Data

Everything lives in the data directory you passed to the deploy scripts:

- `config.json` — configuration and credentials, mode `0600`
- `messages.sqlite` — messages, leases and outbound state
- `sessions/` — one record per Agent run
- `memory/` — long-term impressions and cross-session handoff state
- `console-access.txt` — console address and token, mode `0600`
- `daily-moments.json`, `qzone-interactions.json` — daily-summary and Qzone interaction state

Chat logs, keys, tokens and runtime data are git-ignored. `node scripts/sanitize-release.mjs`
produces a cleaned copy of the tree before you share it.

## ✅ Verification

```bash
npm ci --omit=dev --ignore-scripts
npm run test:unit     # unit tests
npm run test:local    # local regression (uses a temp data dir, never production data)
node src/ops.js scan --strict
npm audit --omit=dev
bash -n deploy.sh manage.sh
```

CI (GitHub Actions) runs the syntax check, the strict undefined-call scan, unit tests and the local
regression on every push and pull request. Two small confirmed issues are open on this baseline,
neither on the main path; see [KNOWN-ISSUES](docs/KNOWN-ISSUES.md) for the current list and the
history. Framework and API details are in the [Chinese docs](docs/README.md).

## 📄 License

MIT (see [LICENSE](LICENSE)). Derivation and third-party copyright are documented in
[NOTICE](NOTICE.md). The OneBot implementation is separate software under its own license.
