# cloudbox-r2

`cloudbox-r2` 是运行在 Cloudflare Workers、R2 和 Durable Objects 上的自托管文件管理与公开访问应用。

它将 Worker API、静态 Dashboard、R2 对象存储和 Durable Objects 组合为一个可独立部署的文件管理服务，适合需要自行掌控存储、认证和公开访问边界的个人或团队。

部署时，Worker 和 Durable Object classes 由 Wrangler 按配置创建或绑定；R2 bucket 需要先创建，再通过 `wrangler.toml` 中的 `BUCKET` binding 连接。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ntetv/cloudbox-r2)

当前按钮仅提供部署快捷入口；仓库为私有且尚未满足按钮自动部署所需配置，请按下文手动部署步骤操作。

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

## npm 包

以下部署路径不依赖 `cloudbox-r2` 是否已发布到 npm registry，推荐先从源码构建并打包。只有在已确认官方包可用时，才在独立的 `template/` 项目中使用 registry 安装：

```bash
pnpm --ignore-workspace add cloudbox-r2
```

从源码安装时，在仓库内的独立模板目录中使用本地包：

```bash
# 在仓库根目录执行
pnpm install --frozen-lockfile
pnpm package

# 进入仓库内的独立模板目录，并明确忽略父 workspace
cd template
pnpm --ignore-workspace add ../packages/worker/cloudbox-r2-1.0.0.tgz
pnpm --ignore-workspace install
```

`pnpm package` 会先构建 Dashboard 和 Worker，再在 `packages/worker/` 生成 tarball。若部署前无法获得官方包或这个本地 tarball，部署不能继续。完成任一路径后，继续执行下方“推荐部署方式”的环境准备和 Wrangler 步骤；不要混用两种安装路径。

公共入口：

```ts
import {
  AdminLoginRateLimiter,
  AdminLoginSourceRateLimiter,
  AdminSessionStore,
  CloudboxR2,
  PublicAccessRateLimiter,
  TransferRegistry,
  TransferStore,
} from "cloudbox-r2";
```

最小 Worker 入口：

```ts
export {
  AdminLoginRateLimiter,
  AdminLoginSourceRateLimiter,
  AdminSessionStore,
  PublicAccessRateLimiter,
  TransferRegistry,
  TransferStore,
};

export default CloudboxR2({
  readonly: false,
  publicBucket: { binding: "BUCKET" },
});
```

`CloudboxR2Config` 只包含当前生产需要的配置：

```ts
export type CloudboxR2Config = {
  readonly?: boolean;
  publicBucket?: {
    binding: string;
    prefix?: string;
  };
};
```

`readonly` 默认启用。只有明确设置 `readonly: false` 时，管理员页面才允许写入、删除、复制和上传操作。上方示例和部署模板显式设置了 `readonly: false`，用于可写管理场景；如果只需要浏览和下载，请改为 `readonly: true` 或删除该字段。

不设置 `publicBucket.prefix` 时，应用会公开绑定 bucket 中所有符合公开对象规则的对象（内部隐藏对象除外）；生产环境通常应限制到专用目录。如果只公开某个目录，建议限制 `publicBucket.prefix`，例如：

```ts
publicBucket: {
  binding: "BUCKET",
  prefix: "public",
}
```

## 推荐部署方式

推荐使用仓库中的 `template/` 作为独立 Worker 项目。按上一节选择 registry 或本地 tarball 安装 `cloudbox-r2`，不需要把本项目的测试、开发工具或源代码部署到 Cloudflare。

### 1. 准备环境

需要：

- Cloudflare 账号，并拥有 Workers、R2 和 Durable Objects 权限
- Node.js `22` 或更高版本
- pnpm `9.15.4`（与仓库 `packageManager` 声明一致）
- 一个全新的 Worker 名称
- 一个全新的 R2 bucket

每次部署都应使用与当前环境匹配的 Worker 名称、R2 bucket 和 Durable Object 资源。

### 2. 获取模板并安装依赖

如果使用 registry 安装，获取本项目源码后进入部署模板目录；如果已按上一节安装本地 tarball，则直接进入该目录。以下命令显式忽略父 workspace，按独立项目执行：

```bash
# 从仓库根目录执行
cd template
pnpm --ignore-workspace install
pnpm --ignore-workspace exec wrangler login
```

`template/` 是独立部署模板，虽然不匹配仓库的 workspace glob，但本文所有模板命令都显式使用 `--ignore-workspace`。`cloudbox-r2` 包只提供 Worker 运行时和 Dashboard 资产，不包含 `template/` 目录。

### 3. 修改 Wrangler 配置

编辑当前模板目录中的 `wrangler.toml`，至少替换以下值：

```toml
name = "replace-with-new-worker-name"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "replace-with-new-r2-bucket"
```

请替换为部署环境自己的 Worker 名称和 bucket 名称，不要填写真实 token 或其他环境的配置。

在 Cloudflare R2 设置中关闭该 bucket 的 `r2.dev` 和 custom domain 公开访问。否则对象可以绕过 Worker 直接访问，公开 prefix、密码锁和其他 Worker 访问控制都不会生效。

### 4. 创建全新的 R2 bucket

使用与 `wrangler.toml` 相同的 bucket 名称：

```bash
pnpm --ignore-workspace exec wrangler r2 bucket create <new-r2-bucket-name>
```

应用只使用当前 `wrangler.toml` 绑定的 R2 bucket，不会自动导入其他 bucket 的对象或 Metadata。本文档只覆盖全新实例部署，不包含数据导入操作。

### 5. 首次部署 Worker

```bash
pnpm --ignore-workspace exec wrangler deploy
```

首次部署会根据当前 `wrangler.toml` 创建 Worker 和 Durable Object classes，并应用初始 `v1-cloudbox-r2` SQLite migration。保持 migration tag 和 class 列表与模板一致，不要手动修改。

在 secrets 设置完成前，Worker 可能对请求返回：

```text
Cloudbox R2 configuration unavailable
```

这是缺少必需 secret 时的 fail-closed 行为。

### 6. 设置 Worker secrets

逐条执行以下命令。Wrangler 会交互式读取值；不要把真实值直接写入 shell 命令、源码、`wrangler.toml` 或日志：

```bash
pnpm --ignore-workspace exec wrangler secret put CLOUDBOX_R2_ADMIN_PATH
pnpm --ignore-workspace exec wrangler secret put ADMIN_USERNAME
pnpm --ignore-workspace exec wrangler secret put ADMIN_PASSWORD
pnpm --ignore-workspace exec wrangler secret put ADMIN_SESSION_SECRET
pnpm --ignore-workspace exec wrangler secret put PUBLIC_ACCESS_SESSION_SECRET
pnpm --ignore-workspace exec wrangler secret put PUBLIC_ACCESS_PASSWORD_PEPPER
pnpm --ignore-workspace exec wrangler secret put TRANSFER_SESSION_SECRET
```

secret 要求：

| Secret | 要求 |
| --- | --- |
| `CLOUDBOX_R2_ADMIN_PATH` | 12–64 个字符；只允许字母、数字、`-`、`_`；不要包含 `/` |
| `ADMIN_USERNAME` | 管理员登录用户名；1–256 个 UTF-8 字节 |
| `ADMIN_PASSWORD` | 6–16 个 UTF-8 字节 |
| 其他四项安全 secret | 每项至少 32 字节 |

`ADMIN_USERNAME`、`ADMIN_PASSWORD` 和其他四项安全 secret 的六个值必须全部不同。管理入口名称不能与系统内置路径冲突。请使用随机、不可预测的单一 segment，不要使用 `api`、`assets`、`public`、`cloudbox-r2`、`visitor`、`robots` 或 `favicon` 等路径名称。运行时会拒绝所有系统保留 segment；如果 `CLOUDBOX_R2_ADMIN_PATH` 不符合规则，Worker 会返回 `503`，请重新生成管理入口值。

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

进入模板目录：

```bash
cd template
pnpm --ignore-workspace run dev
```

本地开发如需注入 secret，可使用未提交的 `template/.dev.vars`。该文件只允许存在于本机，不能提交到 Git、上传到 GitHub 或复制到部署产物。生产环境必须使用 `wrangler secret put` 管理 secret。

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
├── template/                       # 可独立部署的 Worker 模板
│   ├── visitor.html
│   ├── admin.html
│   ├── src/index.ts
│   └── wrangler.toml
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

- 部署不会自动执行；请按本 README 手动执行 Wrangler 命令。
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
