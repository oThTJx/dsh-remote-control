# @firefly0621/dsh-remote-control

[English](README.md) | 中文

远程控制能力的 host 插件：建立指向中继服务器的**出站** WebSocket 连接，向已配对的手机 App 提供插件清单与设置命令。dsh 主机无需公网 IP 和入站端口——它主动拨出，与 OpenClaw/小龙虾（Claw）手机控制模式一致。

## 作为 profile 插件安装

```sh
dsh plugin --profile web add @firefly0621/dsh-remote-control
```

浏览器配对面板（`@firefly0621/dsh-client-ui-remote-control`）是本包的依赖，因此一次安装同时带来 host 插件与 设置 → 插件 → 远程控制 标签页。

**连接是显式的**：插件保持断开，直到你在配对面板按下**连接**；QR 码与 6 位配对码只在连接成功后出现（中继通过活动链接铸造配对码）。**断开连接**会断开并清除配对码。本地启动一个中继（`@firefly0621/dsh-remote-relay`，默认 `ws://127.0.0.1:8787`）或指向你自己的——插件默认 `ws://127.0.0.1:8787`，自动生成 `deviceId`/`deviceSecret`（持久化在 settings 命名空间 `remote-control`，密钥在所有线上表面脱敏），中继地址可在面板上实时编辑。手机扫码（或输入配对码）一次即保持配对——之后 App 用存储的 token 恢复。

生产环境只需配置中继：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- update:
    - id: remote-control
      config:
        relayUrl: wss://relay.example.com
```

## 配置

| 键 | 类型 | 含义 |
|---|---|---|
| `relayUrl` | string | 公开中继 WSS URL，如 `wss://relay.example.com`；缺省回退到 `ws://127.0.0.1:8787`（本地运行的中继）。也可在配对面板实时编辑（设置 → 插件 → 远程控制）；面板持久化的值优先于 cordis.yml。 |
| `deviceId` | string | 稳定设备 id；缺省时自动生成并持久化。 |
| `deviceSecret` | string | 长期 secret；缺省时自动生成并持久化。 |

## 行为

- 连接是显式的：**连接**启动出站客户端，**断开连接**停止并清除配对码。连接时插件用 `hello { deviceSecret }` 认证；中继铸造 6 位配对码并通过 `pairing.issue` 回传。Web GUI 面板显示配对码及编码 `relay=<url>&code=<6位码>` 的 QR 码，另有**测试连接**按钮对中继执行一次真实线往返。连接失败以带原因的错误状态呈现。
- 线上的命令：
  - `plugin.list` → 当前非组 Loader 条目（id、module、enabled、fiber 阶段）。
  - `settings.describe` → 通过 `ctx.settings.describe({ redactSecrets: true })` 列出所有已注册 settings 命名空间——secret 字段绝不离开 host。
  - `settings.mutate` → 带乐观并发的路径级编辑（`ctx.settings.mutate(ns, ops, expectedRevision)`），由 settings provider 持久化。
- 设备发起的中继命令：`sessions.list` / `sessions.revoke` 支撑 GUI 的已绑定设备列表与移除；`resetIdentity` 重新生成身份并重连，使所有已绑定会话失效。
- 连接管理：30s 心跳、指数退避重连（1s → 60s 上限加抖动）、fiber 释放时完整拆除。

## 中继

中继是 `@firefly0621/dsh-remote-relay`（独立 Node 服务，也发布到 npm）。部署环境变量：`PORT`、`NODE_ENV=production`（要求 TLS）、`TLS_CERT`/`TLS_KEY`、`DSH_RELAY_DEVICE_SECRETS`、可选 `DSH_RELAY_ALLOW_AUTO_REGISTER=1`（未知随机 deviceId 的首次 hello 即绑定——零配置模式），以及可选 `DSH_RELAY_DATA_DIR`（持久会话存储，中继重启后已配对的手机可恢复）。见 [dsh-remote-relay 仓库](https://github.com/oThTJx/dsh-remote-relay)。

## 模型体验

无：本插件向 App 提供 host 状态，不注册 prompt、tool 或 provider 请求。

#### KV Cache 影响

无：本插件从不组装或发送模型请求。

## 已知限制与暂缓事项

- **不能启停/安装/卸载** —— Loader 是唯一生命周期权威且没有 mutation 路径；清单只读，设置编辑只触碰用户设置文档。
- **配对码由中继铸造** —— 设备只展示不生成；轮换配对码需要中继侧改动（设备可通过重连强制一次）。
- **中继会话仅在有 `DSH_RELAY_DATA_DIR` 时持久化** —— 没有它时中继重启清空会话，手机必须重新配对。
