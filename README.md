# cloudbox-r2

`cloudbox-r2` 是运行在 Cloudflare Workers、R2 和 Durable Objects 上的自托管文件管理与公开访问应用。

它将 Worker API、静态 Dashboard、R2 对象存储和 Durable Objects 组合为一个可独立部署的文件管理服务，适合需要自行掌控存储、认证和公开访问边界的个人或团队。

部署时，Worker、Durable Object classes 和缺失的 R2 bucket 由 Wrangler 按根目录配置创建或绑定；部署前请确认当前账号和目标资源。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ntetv/cloudbox-r2)

根目录源码部署是推荐路径；顶部按钮保留为 Cloudflare 的快捷入口。

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

## 推荐部署方式

### 1. 准备环境

需要 Cloudflare Workers、R2 和 Durable Objects 权限、Node.js `22` 或更高版本，以及 pnpm `9.15.4`。仓库脚本使用 workspace 内固定的 Wrangler `4.51.0`，不使用 `npx` 随机安装。

根配置默认 Worker 和 bucket 名称均为 `cloudbox-r2`，这是未确认的目标占位配置，不代表已存在或已授权的生产资源。部署前请审核账号、资源名称和计费影响；如需不同名称，先修改根目录 `wrangler.toml`。

### 2. 登录并检查配置

```bash
pnpm install --frozen-lockfile --offline
pnpm exec wrangler login
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
pnpm exec wrangler secret put CLOUDBOX_R2_ADMIN_PATH
pnpm exec wrangler secret put ADMIN_USERNAME
pnpm exec wrangler secret put ADMIN_PASSWORD
pnpm exec wrangler secret put ADMIN_SESSION_SECRET
pnpm exec wrangler secret put PUBLIC_ACCESS_SESSION_SECRET
pnpm exec wrangler secret put PUBLIC_ACCESS_PASSWORD_PEPPER
pnpm exec wrangler secret put TRANSFER_SESSION_SECRET
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

本地开发如需注入 secret，可使用未提交的 `.dev.vars`。该文件只允许存在于本机，不能提交到 Git、上传到 GitHub 或复制到部署产物。生产环境必须使用 `pnpm exec wrangler secret put` 管理 secret。

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
├── scripts/                         # 部署配置校验
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
