# cloudbox-r2

`cloudbox-r2` 是运行在 Cloudflare Workers、R2 和 Durable Objects 上的自托管文件管理与公开访问应用。

它将 Worker API、静态 Dashboard、R2 对象存储和 Durable Objects 组合为一个可独立部署的文件管理服务，适合需要自行掌控存储、认证和公开访问边界的个人或团队。

部署时，Worker、Durable Object classes 和缺失的 R2 bucket 由 Wrangler 按根目录配置创建或绑定；部署前请确认当前账号和目标资源。

直接下载安装脚本（macOS/Linux）：

```bash
curl -fSsLO https://raw.githubusercontent.com/ntetv/cloudbox-r2/main/install_cloudbox.sh
chmod +x install_cloudbox.sh
./install_cloudbox.sh
```

Shell 启动器会自动识别 macOS/Linux 和 CPU 架构，从固定的 `tool/` 路径下载对应 Go 部署二进制，校验 SHA-256 后直接启动部署向导。运行用户不需要 Node.js、pnpm、Wrangler 或 Go。

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

## macOS/Linux 单文件部署

只需要下载根目录 Shell 启动器：

```bash
curl -fSsLO https://raw.githubusercontent.com/ntetv/cloudbox-r2/main/install_cloudbox.sh
chmod +x install_cloudbox.sh
./install_cloudbox.sh
```

启动器会自动判断：

- macOS Apple Silicon：`darwin-arm64`
- macOS Intel：`darwin-amd64`
- Linux x64：`linux-amd64`
- Linux x86：`linux-386`
- Linux ARM64：`linux-arm64`
- Linux ARMv7：`linux-armv7`

随后从固定的 `tool/` 路径下载对应的 `cloudbox_deployer-*`，校验 SHA-256、设置私有权限并直接执行。用户不需要安装 Node.js、pnpm、Wrangler 或 Go。

二进制直接进入部署向导，不接受额外命令或测试参数。默认使用内嵌的 Worker/Dashboard artifact，部署流程会创建全新的 Worker、R2 bucket，应用 Durable Objects migration，写入七项 secrets，并启用 Worker 的 `workers.dev` subdomain。

下载的二进制临时保存在 `install_cloudbox.sh` 同目录，部署器退出后自动删除；正常完成或失败都只保留 Shell 脚本。若进程被 `SIGKILL` 强制终止，系统无法执行清理，需要人工删除同目录残留的 `cloudbox_deployer-*` 文件。

SHA-256 不匹配时拒绝执行，不覆盖现有文件。Shell 启动器不读取或记录 Cloudflare Token。

> 当前启动器固定使用 commit `85e5888122ef43017f1a1146e7eeae4265476966` 中的 `tool/` 二进制，并逐平台校验 SHA-256。

## Windows 单文件部署

Windows 使用独立的 amd64 二进制：

```bat
curl.exe -fSsLO https://raw.githubusercontent.com/ntetv/cloudbox-r2/main/tool/cloudbox_deployer-windows-amd64.exe
cloudbox_deployer-windows-amd64.exe
```

Windows amd64 已完成真实部署验证。Windows x86/ARM64 二进制已生成，但仍需分别进行目标机验证。

## API Token 和权限

请在 Cloudflare Dashboard 创建账号范围 API Token。至少需要：

- Workers 脚本部署/编辑。
- R2 bucket 创建与管理。
- Durable Objects namespace/migration 管理。
- Workers Assets 所属的 Worker 脚本部署权限。

部署器会在终端显式显示 API Token、管理入口和管理员密码；不要在共享、录屏或审计终端运行。Token 只保存在当前进程内存，并通过 HTTPS `Authorization` header 发送到 Cloudflare API。

部署前请确认：未加锁的公开对象可被访客访问，Cloudflare 资源可能产生费用。云端写入不是原子事务，失败时不会自动删除已创建资源；请按错误提示人工检查。

## 推荐部署方式

### 1. 运行单文件部署器

macOS/Linux：

```bash
./install_cloudbox.sh
```

Windows amd64：

```bat
cloudbox_deployer-windows-amd64.exe
```

二进制直接进入部署向导，不接受子命令。启动器会自动识别 macOS/Linux 架构，下载 `tool/` 中对应的固定二进制并校验 SHA-256。

### 2. 部署前确认

向导会显示：

```text
Cloudflare 账号 ID
Worker 名称
R2 bucket 名称
应用版本
```

确认前不会显示 Token、管理员密码或生成的安全 secret。默认 Worker 和 bucket 名称都是 `cloudbox-r2`，直接回车使用默认值；实际测试建议输入全新的名称。

### 3. 部署流程

确认后，部署器会依次：

1. 检查 Worker 和 R2 bucket 不存在。
2. 创建专用 R2 bucket。
3. 上传 Workers Assets。
4. 上传 Worker 和 Durable Objects migration。
5. 写入七项 Worker secrets。
6. 启用 Worker `workers.dev` subdomain。
7. 查询访问地址。

云端写入不是原子事务。失败后不会自动删除已创建的 Worker、bucket、Durable Objects 或 secrets，请按阶段记录人工检查。

### 4. Secret 要求

| Secret | 要求 |
| --- | --- |
| `CLOUDBOX_R2_ADMIN_PATH` | 5–12 个字符；只允许字母、数字、`-`、`_`；不要包含 `/` |
| `ADMIN_USERNAME` | 管理员登录用户名；1–256 个 UTF-8 字节 |
| `ADMIN_PASSWORD` | 6–16 个 UTF-8 字节 |
| 其他四项安全 secret | 每项至少 32 字节 |

管理入口实际地址：

```text
https://<worker-domain>/<CLOUDBOX_R2_ADMIN_PATH>
```

不要在 README、截图、Issue 或公开日志中发布真实管理入口和 secret 值。

### 5. 部署后检查

访客页面：

```bash
curl -i https://<worker-domain>/
```

管理入口：

```bash
curl -i https://<worker-domain>/<admin-path>
```

预期：

- `/` 返回访客页面。
- 正确的自定义入口返回登录页面。
- 缺少或非法管理入口时返回 `503`，不会启动无认证管理入口。

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
