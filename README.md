# cloudbox-r2

`cloudbox-r2` 是运行在 Cloudflare Workers、R2 和 Durable Objects 上的自托管文件管理与公开访问应用。

它将 Worker API、静态 Dashboard、R2 对象存储和 Durable Objects 组合为一个可独立部署的文件管理服务，适合需要自行掌控存储、认证和公开访问边界的个人或团队。

部署时，Worker、Durable Object classes 和缺失的 R2 bucket 由 Wrangler 按根目录配置创建或绑定；部署前请确认当前账号和目标资源。

直接下载安装脚本（macOS/Linux）：

```bash
curl -fSsLO https://raw.githubusercontent.com/ntetv/cloudbox-r2/main/scripts/install_cloudbox.sh
chmod +x install_cloudbox.sh
bash install_cloudbox.sh
```

安装脚本会自动准备 Node.js、下载固定版本源码、安装依赖并启动首次部署向导。

## 核心能力

- R2 文件和目录浏览、搜索、分页、复制、删除与 Metadata 管理
- 响应式访客页面和管理员页面
- 文件上传、分片传输、断点恢复和取消上传
- 文件锁与递归目录锁
- 直接公开文件 URL 和目录 URL
- 管理员登录、注销、session 撤销和多层限流
- HttpOnly、Secure、SameSite 管理员 Cookie
- 管理 API 同源请求保护
- `readonly` 安全模式
- 短期 transfer token、过期校验和服务端归属校验
- 内部对象隐藏和公开 Metadata 防护
- 可自定义管理员入口，避免所有部署使用同一路径

## 运行架构

```text
浏览器
  │
  ▼
Cloudflare Worker
  ├── 静态 Dashboard（Workers Assets）
  ├── 管理 API 和公开访问 API
  ├── 管理员 session、Origin 和限流校验
  └── transfer 上传下载协议
       │
       ├── Cloudflare R2：文件、目录和内部 Metadata
       └── Durable Objects：限流、session、transfer 状态和 registry
```

Worker 负责所有路由。未知路径不会回退到访客页面，错误的管理入口会返回 `404`。

## 根目录源码部署

根目录 `wrangler.toml` 直接引用 `src/index.ts`（其直接引用 `packages/worker/src/index.ts`）和构建后的 `packages/dashboard/dist`，不依赖 npm 包或 tarball。默认配置保持模板语义：`readonly: false`，公开整个绑定 bucket（隐藏内部对象除外），并使用初始 `v1-cloudbox-r2` migration。

## 仅 Cloudflare 账号的本地首次部署

已有完整源码时，在仓库根目录运行：

```bash
bash scripts/install_cloudbox.sh
```

没有完整仓库时，也可以只保存 Shell 启动器并在想要放置源码的父目录运行：

```bash
bash /root/install_cloudbox.sh
```

Shell 启动器会优先验证并调用同目录、且位于完整仓库标记下的 `scripts/install_cloudbox.mjs`；不会因为临时目录中出现同名文件就执行。若只需要直接运行现有 MJS，也可以把仓库中的 `scripts/install_cloudbox.mjs` 单独保存为 `/root/install_cloudbox.mjs`，然后在想要放置源码的父目录运行：

```bash
node /root/install_cloudbox.mjs
# 可选：指定另一个完整 40 位 commit SHA
node /root/install_cloudbox.mjs --ref 4381495afa9278cc2c83a2638707b5d6ce4ffb98
```

Shell 启动器会复用当前 PATH 中可解析为 Node.js `22` 或更高版本的 `node`。如果 Node 缺失、版本过低或输出异常，它只在用户目录 `${XDG_DATA_HOME:-$HOME/.local/share}/cloudbox-r2/node-v22.23.2-<platform>` 准备固定的官方 Node.js `22.23.2`，校验固定 SHA-256 后再原子发布；不会修改 shell profile、系统目录或全局 PATH。支持 macOS x64/arm64，以及使用 glibc 的 Linux x64/arm64；musl、Windows 和其他架构会明确拒绝。下载只使用固定的 `https://nodejs.org/download/release/v22.23.2/` HTTPS 地址。单独复制并执行 Shell 启动器也可用；没有受信任 sibling 时，它只从固定的 `https://raw.githubusercontent.com/ntetv/cloudbox-r2/3e25bce90a933d1f6f25975ad134cb45c6dd3546/scripts/install_cloudbox.mjs` 下载远程 MJS，强制 HTTPS、重定向和超时限制，并校验固定 SHA-256 `cb992e322b167e13341dabaf69f896eb4404e0b357bd52bab873e9a57af1a948` 后，以私有 staging 原子缓存到 `${XDG_CACHE_HOME:-$HOME/.cache}/cloudbox-r2/install_cloudbox-3e25bce90a933d1f6f25975ad134cb45c6dd3546.mjs`（mode `700`）。每次启动都会重新校验已有缓存；损坏或不匹配时拒绝执行且不会覆盖，下载失败只清理本次 staging。Shell 不读取或记录 Cloudflare Token，下载完成后仍以原参数、cwd 和 TTY `exec` Node。

单文件模式默认固定 `ntetv/cloudbox-r2` commit `4381495afa9278cc2c83a2638707b5d6ce4ffb98`，只从 HTTPS `codeload.github.com` 下载源码，并在当前 cwd 创建 `cloudbox-r2-4381495afa92`。目标已存在时会拒绝且不覆盖。源码下载完成后才会收集 Token；解包使用 npm registry 的固定 `tar@7.5.14`（Node.js `>=22`，固定 tarball SRI 与隐藏 npm lock、完整传递依赖版本/resolved/integrity 校验、通过 npm `--ignore-scripts` 安装），并在受限 Node worker 中执行，带固定内存、时间、输出、下载和解压大小上限，不调用系统 `tar`。网络需要访问 `codeload.github.com` 和 `registry.npmjs.org`；该流程不使用 Git、GitHub API 或远端源码中不存在的 setup 文件。

需要官方 Node.js 22+（含 npm）；向导会在目标源码的隔离目录准备固定版本 pnpm 9.15.4，并使用锁定的 Wrangler 4.51.0。单文件模式只支持 Linux/macOS，因为固定 commit 的构建脚本包含 Unix `rm`/`cp`；Windows 会在构建前明确拒绝，本地兼容 build 版本尚未发布。它只支持交互式终端，会显示部署前检查和开始部署两个固定状态，先构建和 dry-run 检查，再在明确确认后创建新的 Worker、专用 R2 bucket、七个 Worker secrets 并部署。每次只能使用全新的 Worker 和 bucket 名称；向导不会覆盖、迁移、恢复或卸载现有资源。源码准备期间收到 SIGINT/SIGTERM 会清理向导拥有的临时目录和侧锁；SIGKILL 无法被捕获，不能保证本机清理，但侧锁会记录向导标记、PID 和时间，下一次仅在确认 PID 已不存在且锁确属本向导时回收，其他锁不会删除。

无论真实部署成功、失败、取消，还是 bucket/secrets 已部分写入后失败，向导都会在主流程 `finally` 中尝试清理本次 standalone bootstrap 生成的 `cloudbox-r2-<SHA 前 12 位>` 源码副本、`.wrangler/setup` 内的配置/pnpm/tar 临时目录和日志，以及当前执行的固定远程 MJS 缓存。完整用户仓库模式不会删除仓库源码；只清理传入 root 下的 `.wrangler/setup` 命名空间，不碰其他 `.wrangler` 状态。`${XDG_DATA_HOME:-$HOME/.local/share}/cloudbox-r2/node-v...` 官方 Node.js 用户缓存会保留，sibling 模式脚本和根源码会保留。清理只使用 Node 文件 API、精确的本次调用标记和路径校验，不执行资源删除命令；不会删除或修改任何 GitHub 历史 commit，也不会删除 R2、Worker、Durable Objects 或 secrets。SIGKILL 发生在 `finally` 之前时仍可能留下这些本机生成物，需要人工检查。

部署成功后，向导会合并 Wrangler 的 stdout 和 stderr，只接受与所选 Worker 匹配的 `https://<worker>.<account>.workers.dev` 地址；若 Wrangler 没有输出地址，向导会使用当前 API Token 请求账号 Workers subdomain API（`GET /accounts/<ACCOUNT_ID>/workers/subdomain`），严格校验 `result.subdomain` 后组合出 `https://<worker>.<subdomain>.workers.dev`。地址找到后会检查首页；首页响应未包含预期页面标记时，部署地址仍会输出，同时显示首页验证警告，便于手动访问排查。API 不可用、响应无效、关闭 `workers_dev` 或使用自定义域名时，部署仍视为成功，并提示到 Cloudflare Dashboard 查看域名配置。

需要先在 Cloudflare Dashboard 创建一个**账号范围** API Token。向导只接受此 Token 和单独输入的 32 位十六进制 Cloudflare 账号 ID；账号 ID 不是第二个凭据。当前交互模式会显式显示所有手动输入，包括 API Token、管理入口和管理员密码；向导不会主动把这些值写入 npm/pnpm、构建命令、参数、配置或 Wrangler 日志，但终端本身可能被录屏、共享屏幕、SSH 审计或旁观者捕获，请只在可信终端运行。Token 仍只在当前进程内存中保存，并仅注入 Wrangler 子进程和固定 Cloudflare API 请求的 `Authorization` header。向导不会调用 `wrangler login`、OAuth、浏览器登录、Global API Key 或邮箱密码，也不依赖本机已有 OAuth 状态。

请在 Cloudflare 官方 [API Token 权限参考](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) 和 [Workers 授权说明](https://developers.cloudflare.com/workers/authorization/workers/) 中按当前界面选择最小的账号级权限：Worker 脚本部署/编辑、R2 bucket 创建与管理、Durable Objects namespace/migration 管理，以及 Workers Assets 所属的 Worker 脚本部署权限；仅当使用路由或自定义域名时再增加对应的 Routes 权限。优先使用官方 “Edit Cloudflare Workers” 模板后收窄到目标账号，并按权限参考核对当前名称，不要凭旧名称创建权限。Token 必须能读取目标账号的 Worker 部署列表和 R2 bucket 信息；向导会用这些只读请求预检权限，不要求 `whoami`、用户或邮箱权限。

部署前请确认：未加锁的公开对象可被访客访问，Cloudflare 资源可能产生费用。云端写入不是原子事务，失败时不会自动删除已创建资源；请按错误提示人工检查。真实云端写入和真实 Token 未在本地验证。

## 推荐部署方式

### 1. 准备环境

需要 Cloudflare Workers、R2 和 Durable Objects 权限、Node.js `22` 或更高版本，以及 pnpm `9.15.4`。仓库脚本使用 workspace 内固定的 Wrangler `4.51.0`，不使用 `npx` 随机安装。

根配置默认 Worker 和 bucket 名称均为 `cloudbox-r2`，这是未确认的目标占位配置，不代表已存在或已授权的生产资源。首次部署向导中，Worker 和 R2 bucket 输入直接回车也会分别使用 `cloudbox-r2`；非空输入仍必须符合名称格式。部署前请审核账号、资源名称和计费影响；如需不同名称，可在提示处输入自定义名称。默认名称或自定义名称只要已存在，向导都会停止，不覆盖或复用资源。向导会读取根配置中的唯一顶层 Worker `name` 和唯一 `bucket_name` 字段生成临时配置，不要求它们仍叫 `cloudbox-r2`；`validate-deploy-config` 默认只校验必要结构，也可通过 `--worker-name` 与 `--bucket-name` 校验动态配置。单文件下载会额外校验快照身份仍是固定源项目默认名称，避免把未预期的源码变体当成下载结果；向导始终先执行结构校验，只有快照自带 validator 支持动态参数时才调用 pnpm validator，旧快照的品牌硬编码不会阻断自定义名称。

### 2. 使用 Token 检查配置

```bash
pnpm install --frozen-lockfile --offline
# 先以安全方式在当前 shell 注入 CLOUDFLARE_API_TOKEN（不要写入命令历史）
pnpm --filter ./packages/worker exec wrangler --version
pnpm validate-deploy-config
```

### 3. 构建并预览部署

```bash
pnpm deploy:dry-run
```

Wrangler 当前支持在部署时自动创建缺失的 R2 bucket；本配置不会绑定已知旧资源。若当前 Wrangler 或账号策略不允许自动创建，请在审核后手动创建与 `wrangler.toml` 相同名称的全新 bucket，再重试部署。应用不会导入其他 bucket 的对象或 Metadata。

### 4. 首次部署 Worker

确认 dry-run 输出、Worker 名称、bucket 名称和绑定均正确后，手动执行：

```bash
pnpm deploy
```

首次部署会根据当前 `wrangler.toml` 创建 Worker 和 Durable Object classes，并应用初始 `v1-cloudbox-r2` SQLite migration。保持 migration tag 和 class 列表一致，不要绑定现有生产资源。

在 secrets 设置完成前，Worker 可能对请求返回：

```text
Cloudbox R2 configuration unavailable
```

这是缺少必需 secret 时的 fail-closed 行为。

### 6. 设置 Worker secrets

逐条执行以下命令。Wrangler 会交互式读取值；不要把真实值直接写入 shell 命令、源码、`wrangler.toml` 或日志：

```bash
pnpm --filter ./packages/worker exec wrangler secret put CLOUDBOX_R2_ADMIN_PATH
pnpm --filter ./packages/worker exec wrangler secret put ADMIN_USERNAME
pnpm --filter ./packages/worker exec wrangler secret put ADMIN_PASSWORD
pnpm --filter ./packages/worker exec wrangler secret put ADMIN_SESSION_SECRET
pnpm --filter ./packages/worker exec wrangler secret put PUBLIC_ACCESS_SESSION_SECRET
pnpm --filter ./packages/worker exec wrangler secret put PUBLIC_ACCESS_PASSWORD_PEPPER
pnpm --filter ./packages/worker exec wrangler secret put TRANSFER_SESSION_SECRET
```

secret 要求：

| Secret | 要求 |
| --- | --- |
| `CLOUDBOX_R2_ADMIN_PATH` | 5–12 个字符；只允许字母、数字、`-`、`_`；不要包含 `/` |
| `ADMIN_USERNAME` | 管理员登录用户名；1–256 个 UTF-8 字节 |
| `ADMIN_PASSWORD` | 6–16 个 UTF-8 字节 |
| 其他四项安全 secret | 每项至少 32 字节 |

`ADMIN_USERNAME`、`ADMIN_PASSWORD` 和其他四项安全 secret 的六个值必须全部不同。5–12 个字符的限制只适用于管理入口名称，不适用于管理员密码或其他 secret；管理入口只需使用符合上述字符规则的单一 segment。如果 `CLOUDBOX_R2_ADMIN_PATH` 不符合规则，Worker 会返回 `503`，请重新生成管理入口值。

管理入口实际地址为：

```text
https://<worker-domain>/<CLOUDBOX_R2_ADMIN_PATH>
```

例如 secret 值由部署者自行生成后，实际 URL 会使用对应的单一路径 segment。不要在 README、截图、Issue 或公开日志中发布真实管理入口和 secret 值。

### 7. 部署后检查

先确认访客页面可访问：

```bash
curl -i https://<worker-domain>/
```

再使用真实管理入口检查登录页：

```bash
curl -i https://<worker-domain>/<admin-path>
```

预期结果：

- `/` 返回访客页面
- 正确的自定义入口返回登录页面
- 缺少或非法 `CLOUDBOX_R2_ADMIN_PATH` 时返回 `503`，不会启动无认证管理入口

## 本地开发

根目录本地开发：

```bash
pnpm dev
```

本地开发如需注入 secret，可使用未提交的 `.dev.vars`。该文件只允许存在于本机，不能提交到 Git、上传到 GitHub 或复制到部署产物。生产环境必须使用 `pnpm --filter ./packages/worker exec wrangler secret put` 管理 secret。

本地配置至少需要与生产使用相同的七个字段名。测试值必须与生产值完全不同。

## 项目结构

```text
cloudbox-r2/
├── packages/
│   ├── dashboard/
│   │   ├── client/                 # 原生静态页面 controllers
│   │   ├── static/login.html       # 登录页面源文件
│   │   ├── public/                 # 实际使用的静态资源
│   │   └── scripts/                # Dashboard 构建脚本
│   └── worker/                     # Worker API 和安全边界
├── template/                       # 独立示例模板（非根目录部署入口）
├── wrangler.toml                    # 根目录源码部署配置
├── scripts/                         # Shell 启动器与部署配置校验
├── LICENSE
└── README.md
```

源码仓库通常不提交 `dist/`、`packages/worker/dashboard/`、`node_modules/`、`.wrangler/`、`.dev.vars`、测试报告、日志或 `*.tgz`。其中构建目录和 tarball 是部署/安装流程可能需要的生成产物，不是 secrets；`.dev.vars`、日志和报告则不应进入部署产物或公开位置。

## 安全边界

- 管理员认证始终启用，不能通过公开配置关闭。
- 管理 session 使用 HttpOnly、Secure、SameSite Cookie，不使用可读 localStorage token。
- 管理 API 需要同源请求保护。
- 管理登录、登录来源和公开解锁均有独立限流。
- 公开访问只使用显式配置的 bucket 和 prefix。
- 公开锁密码使用带 pepper 的 PBKDF2-SHA256 哈希。密码锁是 Worker 层的访问控制，不会加密 R2 中的文件内容。
- 递归目录锁会保护其子资源；密码或锁版本变化会使已发出的解锁 session 失效。
- transfer token 有短期有效期、服务端归属和取消校验。
- `.cloudbox-r2/` 内部对象不会作为普通文件或目录展示。
- 自定义管理入口只提供额外的路径不可预测性，不能替代密码、session、限流和同源校验。

## 部署和运维注意事项

- 部署不会自动执行；请先审核 `pnpm deploy:dry-run` 输出，再手动执行 `pnpm deploy`。
- 应用不会自动导入其他 bucket 的对象或 Metadata。需要导入数据时，请另行准备并验证迁移命令和目标路径。
- Durable Object migration 由当前 `wrangler.toml` 管理；首次部署前确认 migration tag 和 class 列表未被改动。
- 管理员 secrets 必须通过 Wrangler secret 管理，不得写入源码、`wrangler.toml` 或日志。
- `.env`、`.dev.vars`、`.wrangler`、HAR 和日志不得提交 Git 或公开；构建生成物是否上传由部署流程决定，但不应包含 secrets。

部署完成后确认：

1. Worker 名称、R2 bucket 名称和绑定配置符合当前环境。
2. 七个 Worker secrets 已通过 Wrangler 设置。
3. 访客页面可以访问。
4. 自定义管理入口可以打开并完成登录。
5. `readonly` 配置符合当前运行需求。

## 项目边界

不同实例是否隔离取决于部署者是否为每个实例配置独立的 Worker、R2 bucket、Durable Object namespace 和 secrets。复用这些资源可能导致认证、transfer 状态或内部 Metadata 共享；应用不会自动提供跨实例隔离。

## 许可证

MIT License，详见 [LICENSE](LICENSE)。
