# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## 项目概述

「发个东西」(`internal-chat`) 是一个**局域网文字/文件 P2P 传输工具**。服务端只负责两件迫不得已的事：**在线用户列表**和 **WebRTC 信令转发**。真正的文字/文件数据全部走基于 WebRTC 的点对点 `RTCDataChannel`，不经过服务器，所以局域网内互传更快。打开浏览器、无需登录即可传输。

## 常用命令

```bash
npm install                         # 安装依赖 ws、selfsigned
npm run start [port]               # 启动服务端（HTTP），默认端口 8081，例：npm run start 8081
npm run start [port] https         # 启用自签名 HTTPS（局域网 IP 访问时需用它才能用文件落盘）
HTTPS=1 npm run start [port]       # 同上，等价于带 https 参数
```

- 无构建步骤、无 lint、无测试套件（仓库目前没有任何测试或 lint 配置）。
- 依赖：`ws`（WebSocket 信令）+ `selfsigned`（仅 `https` 模式下的自签名证书生成，首次运行生成并缓存到 `./cert/`，含 localhost/127.0.0.1/本机局域网 IP 的 SAN）。
- 打包二进制可执行文件（linux/win/macos）依赖 `pkg`，配置在 `package.json` 的 `pkg` 字段；目标为 node16，作者使用 Node `16.20.2`。打包命令：`npx pkg .`（生成到 `dist/`）。`selfsigned` 会被打进 `node_modules` 一并打包；`pkg` 只读环境下证书仅在内存生成、不缓存。
- 作者测试用 Node 版本为 16.20.2，未在其他版本验证。

## 整体架构

### 服务端（仅信令 + 在线列表）

- `index.js`：单一入口。
  - 用 `http.createServer` 提供 `www/` 下的静态文件（默认 `index.html`），并对 `.js`/`.css` 设 30 天缓存。
  - 同一个 HTTP server 上挂 `WebSocket.Server`（`ws` 库），WebSocket 路径为 `/ws`。
  - 通过 WebSocket 连接的 URL path 解析房间号与密码：`/ws/{roomId}/{pwd}`。
  - 定义了一组信令消息类型常量：`SEND_TYPE_*`（`1001`–`1007`，服务端→客户端）与 `RECEIVE_TYPE_*`（`9001`–`9004`、`9999` keepalive，客户端→服务端）。这些数字代码是前后端约定的协议，改动必须前后端同步。
  - `room_pwd.json`：可选文件，存放受密码保护房间的 `roomId`、密码的 **MD5**（`pwd` 字段）、以及可选的 TURN 服务器配置（`turns`）。缺失该文件不报错，仅不启用密码房。读取路径在打包后会取可执行文件所在目录（`process.pkg` 判断）。
- `data.js`：纯内存的房间/用户状态管理（`data` 对象），导出 `registerUser` / `unregisterUser` / `getUserList` / `getUser` / `updateNickname`。**无持久化**——重启即清空所有在线状态。

### 用户隔离分组逻辑（关键，跨文件理解）

`getKey(ip, roomId)`（`data.js:53`）决定一个连接归属哪个「频道」：
- 指定 `roomId` → 直接以 `roomId` 为 key。
- 否则按 IP 判断：`internalNet(ip)` 为 true（内网/回环）时使用固定 key `internal`（即同局域网默认互通），公网 IP 则各自用自身 IP 隔离。
- 受密码保护的房间：WebSocket 连接的 `roomId`/`pwd` 必须匹配 `room_pwd.json` 中的 `roomId` 且 `pwd` 等于存储的 MD5（大小写不敏感），否则 `roomId` 被置空、落到 `internal` 频道。

### 前端（www/）

- `index.html`：UI 骨架，引入 `xchatuser.js` 与 `index.js`，包含主聊天区、在线用户列表、以及密码/昵称/选人弹窗。
- `index.js`：UI 逻辑 + 信令客户端。负责连接 `/ws`、处理 `1001`–`1007` 消息、维护在线列表、发文件/文字、房间密码提交（密码经 MD5 后拼进 WS URL）。
- `xchatuser.js`：核心类 `XChatUser`，封装单个 WebRTC 对等连接（`RTCPeerConnection` + `RTCDataChannel`），负责 offer/answer/candidate 交换、文件分块传输、连接状态回调。ICE 服务器配置在 `window.fgdx_configuration`（默认一个公共 STUN，受密码房时由服务端 push TURN）。

  **文件传输设计（已优化，针对强局域网/非弱网）**：
  - DataChannel 为**完全可靠 + 有序**（`ordered:true`，去掉了原 `maxRetransmits` 与应用层重传），SCTP 自身保证送达。
  - 分块大小由 `sctp.maxMessageSize` 动态决定（最高 256KB，原写死 8KB）；发送窗口 `checkBufferedAmount` 上限 8MB（`connOption.bufferedAmountLowThreshold` 1MB）。**不要把这些阈值调回小值**，否则会重回"大文件很慢"。
  - 每块**不再发 JSON 控制消息**，接收端在可靠有序通道下按到达顺序组装二进制块。
  - 接收端优先用 **File System Access API**（`showSaveFilePicker` → 可写句柄）**流式落盘**，内存恒定、支持超大文件；不支持的浏览器回退到内存攒块 + Blob 下载。是否支持取决于安全上下文：`localhost`/`127.0.0.1`/HTTPS 可用，局域网 IP（`http://192.168.x.x`）不可用（回退内存方案）。**要在局域网 IP 上用落盘，服务端必须用 `npm run start [port] https` 起 HTTPS。**
  - 接收确认通过 `onReceiveFileRequest` 回调交由 UI 弹窗，用户点"保存"的手势内才调用 `showSaveFilePicker`；点"拒绝"则回 `##FILE_REJECT##`，发送端立即中止（不再等超时）。
- `style.css`：样式。

### 信令流（建立 P2P 连接）

1. 客户端连 `/ws` → 服务端 `registerUser` 分配 `id` 并通过 `1001` 回传自身 id / roomId / turns。
2. 服务端向房内所有用户广播 `1002`（房间信息/用户列表）。
3. 新用户收到 `1003`（joinedRoom），开始对房内其他人发起连接：发 `9002`（NEW_CONNECTION，含本地 offer）→ 服务端中转给目标 → 目标回 `9003`（CONNECTED，含 answer）→ 双向交换 `9001`（candidate）。最终两端直接通过 `RTCDataChannel` 传数据，服务端不再参与。

> 注意：服务端只「转发」信令（按 `uid`/`targetId` 路由到目标 socket），不理解信令内容含义，也不经手文件数据。

## 修改时的注意事项

- 前后端共用同一套数字消息类型协议（`1001`–`1007` / `9001`–`9004` / `9999`）。在 `index.js` 新增/修改消息类型时，必须同步更新 `www/index.js` 的对应处理分支，否则连接或传输会静默失败。
- 文件传输逻辑完全在 `www/xchatuser.js`，与服务器无关；调大单文件体积或分块策略看这里。
- `room_pwd.json` 在 `.gitignore` 中，不会被提交；其结构见 `.room_pwd.json` 示例（`pwd` 是密码的 MD5，不是明文）。
- 前端静态资源带 `?v=21` 查询串做缓存破坏（`index.html` 中引用），改动前端后如需强制刷新浏览器缓存需同步更新该版本号。
- 日志函数被 `index.js` 顶部 patch 成带时间戳格式（`YYYY-MM-DD HH:mm:ss.SSS`），非原生 `console.log`。
