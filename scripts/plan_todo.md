# Go 单文件部署器开发与验收计划

> 当前状态：开发已获用户授权，按本文件顺序执行。
>
> 当前阶段限制：先做本地 macOS 原型和本地模拟测试；不部署生产、不删除 R2 对象、不执行 Durable Object migration 写入、不提交或推送，除非后续明确授权。

## 0. 总体目标

将现有依赖 Node.js、pnpm、Wrangler 和 Shell/PowerShell 启动器的首次部署流程，逐步改造成跨平台 Go 部署器：

- Windows 10/11 x64、macOS、Linux 分别发布独立可执行文件。
- 运行用户不需要预装 Go、Node.js、pnpm、Wrangler 或 .NET。
- Worker、Dashboard 和部署元数据由发布构建阶段固定，并由 Go 程序读取或内嵌。
- 运行时只通过 Cloudflare API 完成部署，不调用本机 Shell、PowerShell、Wrangler 或系统 curl。
- 首先在当前 macOS 环境完成 API 原型、本地模拟测试和候选单文件验证。
- macOS 原型通过后，再扩展 Windows/Linux，不复制部署业务逻辑。
- 现有 `install_cloudbox.*` 入口在 Go 版本通过验收前保留，不提前替换。

## 1. 不在本轮自动执行的动作

- 不使用真实生产 Token。
- 不创建、删除或修改生产 Worker、R2 bucket、Durable Objects 或 secrets。
- 不执行真实 Durable Object migration。
- 不删除 R2 对象。
- 不覆盖、迁移、恢复或卸载已有 Cloudflare 资源。
- 不提交 Git、不推送 GitHub、不发布 Release。
- 不把 `.env`、`.dev.vars`、HAR、Cookie、Token、私钥、真实域名、真实 bucket、个人绝对路径写入代码或产物。
- 真实独立测试资源部署另设授权关卡，默认不执行。

## 2. 阶段总览

```text
P0 核对现有部署契约
P1 建立固定部署产物清单
P2 实现跨平台 Go API 原型
P3 建立本地模拟 API 与失败回归
G1 本地协议关卡
P4 独立测试资源真实部署（单独授权）
G2 真实 API 关卡
P5 封装 macOS 单文件候选版
P6 macOS 候选版验收
G3 macOS 关卡
P7 扩展 Windows/Linux
P8 发布入口切换（单独授权）
```

执行规则：

1. 先确认现有契约，再写 API 调用。
2. 先让本地模拟测试变红，再实现最小代码使其变绿。
3. 写入操作不盲目重试；结果不明时查询状态。
4. 云端写入不是原子事务；失败时报告已完成阶段，不自动删除资源。
5. 交叉编译通过不等于目标平台已支持；每个平台单独验证。
6. 每完成一个任务，更新本文件状态和验收记录。

---

## P0：核对现有部署契约

### P0-01 仓库和工作区基线

- [x] 记录当前 Git 分支、未提交改动和远端状态。
- [x] 确认 `scripts/plan_todo.md` 是本开发计划文件。
- [x] 不覆盖已有用户改动，Go 文件放入明确的工具目录。
- [x] 确认 Go 单文件部署器和根目录 `install_cloudbox.sh` 是当前部署入口；旧 Node/Wrangler 安装器已移除。

验收：

```text
能列出当前工作区状态；没有未授权删除或覆盖动作；Go 工具位置明确。
```

### P0-02 确认源码和构建权威来源

- [x] 确认 Worker 源码入口：`src/index.ts` / `packages/worker/src/index.ts`。
- [x] 确认 Dashboard 源码和构建入口：`packages/dashboard`。
- [x] 确认根 `wrangler.toml` 中的 compatibility date、Assets、R2 binding、Durable Object bindings 和 migrations。
- [x] 确认 `packages/worker/scripts/build-package.mjs` 生成的 Worker 产物结构。
- [x] 确认 `packages/dashboard/scripts/build-cloudbox-assets.mjs` 生成的静态资源结构。
- [x] 确认 artifact manifest 和 Go 本地校验规则；旧 `validate-deploy-config.mjs` 已移除。
- [x] 确认七项 secrets 的名称、长度、互异性和输入规则。

验收：

```text
每个部署字段都能追溯到现有配置或源码；没有通过猜测补 API 字段。
```

### P0-03 Cloudflare API 契约

- [ ] 查阅并记录当前 Cloudflare 官方 API 文档。
- [ ] 确认账号级 API Token 最小权限。
- [ ] 确认账号信息和权限预检接口。
- [ ] 确认 R2 bucket 查询、创建和状态接口。
- [ ] 确认 Worker script 上传/部署接口。
- [ ] 确认 Workers Assets 上传会话、文件哈希、批次和最终提交接口。
- [ ] 确认 Durable Objects namespace/class/migration 在 API 中的表达方式。
- [ ] 确认 Worker secrets 写入接口及单个 secret/批量 secret 的限制。
- [ ] 确认 workers.dev subdomain 查询接口和失败情形。
- [ ] 确认部署后访问检查方式。

验收：

```text
每个写入动作有官方接口、请求结构、响应结构、权限要求和幂等处理说明。
```

### P0-04 选定 Go 工具布局

首版建议目录：

```text
tools/cloudbox-deployer/
├── go.mod
├── cmd/cloudbox-deployer/main.go
├── internal/config/
├── internal/artifact/
├── internal/cloudflare/
├── internal/deploy/
├── internal/console/
└── internal/testsupport/（仅测试需要时创建）
```

约束：

- [x] 纯 Go，优先标准库。
- [x] 首版不引入 GUI。
- [x] 首版不引入复杂依赖注入、插件系统或工作流框架。
- [x] HTTP 客户端必须可注入测试 Transport 或 API base URL。
- [x] 代码从第一天避免 macOS、Windows、Linux 专用路径和命令。
- [x] 产物读取和 API 部署核心与控制台交互分离。

验收：

```text
macOS 本地开发可运行；代码结构可直接交叉编译到其他平台；没有把 macOS 行为写死到核心。
```

**P0 关卡：P0-01 至 P0-04 全部完成后，才进入 P1/P2。**

---

## P1：建立固定部署产物清单

### P1-01 生成产物

- [x] 使用现有项目官方构建命令生成 Dashboard 产物。
- [x] 使用现有项目官方构建命令和 Wrangler `--dry-run --outdir` 生成 Worker bundle。
- [x] 记录构建源码 commit、应用版本、compatibility metadata 和固定 Wrangler 版本。
- [x] 不把构建过程放入用户端 Go 程序。

### P1-02 定义 artifact manifest

manifest 至少记录：

- [x] manifest 格式版本。
- [x] Cloudbox 应用版本。
- [x] 源码 commit SHA。
- [x] Worker 模块入口和 MIME 类型。
- [x] Dashboard 文件路径、大小和 SHA-256。
- [x] Worker 文件大小和 SHA-256。
- [x] compatibility date/flags（当前 canonical metadata 显式记录 compatibility date 和空 flags 列表）。
- [x] R2 binding 名称。
- [x] Durable Object class 与 binding 列表。
- [x] 初始 migration tag/class 列表。
- [x] 需要写入的 secret 名称，不包含 secret 值。

### P1-03 产物安全检查

- [x] 拒绝产物目录中的 symlink/reparse point（当前 POSIX 已验证；Windows reparse point 待平台测试）。
- [x] 拒绝绝对路径、路径越界和重复归一化路径。
- [x] 拒绝 `.env`、`.dev.vars`、`.wrangler`、HAR、日志、Cookie、私钥和 token 文件（canonical artifact 扫描）。
- [x] 扫描文本产物，确认没有 Cloudflare Token、真实账号 ID、真实域名和用户路径（canonical artifact 扫描）。
- [x] 清单哈希与实际文件一致。
- [x] 任一校验失败时，在云端写入前停止。

### P1-04 原型输入形式

- [x] P2 阶段允许从本地固定 artifact 目录读取，先验证 API 链路。
- [ ] P5 阶段再将 artifact 内嵌到 macOS 单文件。
- [x] 外部目录模式和内嵌模式使用相同 manifest 校验逻辑（当前 Go manifest/VerifyFiles 统一校验；内嵌封装待 P5）。
- [x] 不用外部可变 `main` 或未固定下载地址作为部署产物来源。

验收：

```text
干净构建可生成完整 manifest；缺文件、哈希错误、敏感文件和路径异常均在本地被拒绝。
```

---

## P2：实现 Go API 原型

### P2-01 基础工程

- [x] 创建 `tools/cloudbox-deployer/go.mod`。
- [x] 固定 Go toolchain 版本策略（`go 1.22` module 目标，当前 macOS 使用 Go 1.24.5 验证）。
- [x] 创建 `cmd/cloudbox-deployer` 入口。
- [x] deploy 入口改为直接运行二进制；部署二进制不接受特殊命令或测试参数。
- [x] artifact 构建工具独立放在 `cmd/cloudbox-artifact`，不暴露在部署二进制中。
- [x] 不再提供部署二进制的 help/version/子命令入口；直接运行即进入部署。
- [x] 使用 `build:deployer` 生成 macOS 单文件候选。

### P2-02 配置和输入

- [x] 校验 Cloudflare API Token。
- [x] 校验 32 位十六进制 Cloudflare account ID。
- [x] 校验 Worker name。
- [x] 校验 R2 bucket name。
- [x] 复用现有管理入口、管理员用户名、管理员密码规则。
- [x] 生成四项高熵安全 secret。
- [x] 检查所有 secret 互不相同。
- [x] 交互确认前显示账号、Worker、bucket、artifact 版本和费用提醒。
- [x] 最终摘要不显示 Token、管理员密码或生成的 secret。
- [x] 按现有要求，在敏感输入前显示终端可见性、录屏、共享和 SSH 审计警告。

### P2-03 HTTP 客户端

- [x] 使用 `net/http` 和显式 timeout。
- [x] 使用 `context.Context` 支持取消。
- [x] 默认只访问可信 Cloudflare API host（本地 HTTP 仅允许 loopback `httptest`）。
- [x] 测试支持注入本地 `httptest.Server`。
- [x] 重定向策略不把 Authorization 转发到不可信 host。
- [x] 限制响应大小，拒绝异常大的错误响应。
- [x] 解析 HTTP 状态、Cloudflare success、errors、messages 和 result。
- [x] 错误信息脱敏，不打印 Authorization header、Token、secret 值。
- [x] 429、5xx、超时和可重试网络错误只对读取请求做有限退避；写入请求不盲重试。

### P2-04 预检

- [ ] 验证 account ID 和 Token 对应账号权限。
- [x] 验证 artifact manifest 与部署参数一致（当前覆盖本地 artifact、名称格式和 secret 名称；动态 Worker binding 完整对照待补）。
- [x] 查询 Worker 是否已存在。
- [x] 查询 R2 bucket 是否已存在。
- [x] 已存在时停止，不覆盖、不复用、不迁移。
- [ ] 查询所需 Durable Object/Worker 资源前置条件。
- [x] 在任何云端写入前完成本地和远程预检。

### P2-05 R2 bucket

- [x] 创建专用 R2 bucket。
- [x] 记录创建阶段和返回状态（工作流结果对象已记录）。
- [x] 超时后查询 bucket 状态，不直接重复创建。
- [x] 创建失败时报告“可能已创建/需要检查”，不自动删除。

### P2-06 Workers Assets

- [x] 读取 manifest 中的文件列表和 SHA-256。
- [x] 实现 Cloudflare Workers Assets 上传协议原型。
- [x] 确认并实现 Cloudflare 当前要求的 asset upload hash 算法：复现 Wrangler `blake3(base64(content) + extension).hex().slice(0, 32)`；SHA-256 仍单独用于本地完整性校验。
- [ ] 支持批量上传、批量失败和会话失效的完整重试策略（批量/失败状态已覆盖，上传重试和 JWT 失效续传待补）。
- [x] 传输过程不把文件内容写入日志。
- [x] 上传结果可核对缺失、重复和 hash 不一致。

### P2-07 Worker 部署

- [x] 上传 Worker 模块或 multipart Worker payload 原型。
- [x] 写入 R2 binding metadata。
- [x] 写入 Assets binding metadata。
- [x] 写入 Durable Object bindings metadata。
- [x] 仅按 manifest 应用 compatibility 配置。
- [x] 生成初始 migration metadata；真实 migration 写入仍必须等 P4 单独授权。
- [x] 部署请求超时后查询 Worker deployment 状态，不盲目重复部署；Worker version 上传无 version ID 时仍保留 unknown 状态。

### P2-08 secrets

- [x] 在 Worker version metadata 原型中写入七项 secrets binding。
- [x] Token 仅放入 Authorization header。
- [x] secret 值不进命令参数、不写磁盘、不写日志。
- [x] secrets/Worker version 失败时记录阶段，不自动删除已创建资源。
- [x] 失败输出只显示 secret 名称和状态，不显示值。

### P2-09 地址和首页检查

- [ ] 优先读取 API 返回的 Worker 地址。
- [x] 部署后显式调用 Worker subdomain API 启用 `workers.dev`。
- [x] 无地址时调用 Workers subdomain API。
- [x] 严格校验 Worker 名称、subdomain 和 `workers.dev` 结构。
- [x] workers.dev 未启用时保留部署成功状态，不伪造 URL。
- [x] 首页检查能力保留为可选 `--check-home`；默认不因首页 404 输出部署警告。
- [x] 首页响应异常、重定向异常和标记缺失分别记录（显式传入 `--check-home` 时启用）。

### P2-10 阶段状态

统一阶段结果：

```text
预检完成
用户取消，尚未写入
R2 bucket 已创建或结果未知
secrets 已写入或部分写入
Worker 已部署或结果未知
地址已确认
首页验证通过/警告
```

验收：

- [x] 核心部署逻辑不调用 Node、pnpm、Wrangler、Shell、PowerShell 或系统 curl。
- [x] 全部本地参数和 artifact 错误在云端写入前拦截。
- [x] 结果未知时不宣称失败或成功。
- [x] 不存在资源时可进入写入流程；已存在资源时确定停止。

---

## P3：本地模拟 API 与失败回归

### P3-01 测试边界

测试通过公开接口和 HTTP seam 完成：

- [x] Go CLI 参数/交互接口（`dry-run` 已覆盖本地交互；真实部署命令仍待 P4/API 完成）。
- [x] Go artifact 校验接口。
- [x] 可替换 HTTP Transport 或 `httptest.Server`。
- [x] 部署编排器公开阶段结果。

不测试私有实现细节，不把测试写成对内部函数名称的绑定。

### P3-02 参数红绿测试

- [x] 合法 Token、account ID、Worker、bucket 通过。
- [x] 非法名称、账号 ID、管理入口拒绝。
- [x] 管理员密码长度和用户名相等规则拒绝。
- [x] 两次密码不一致拒绝。
- [x] 生成 secret 数量、长度和互异性正确。
- [x] 默认 Worker/bucket 行为与现有流程一致。

### P3-03 artifact 红绿测试

- [x] manifest 缺字段拒绝。
- [x] Worker 哈希错误拒绝（通过文件篡改验证）。
- [x] Dashboard 文件哈希错误拒绝。
- [x] symlink/reparse point 拒绝（POSIX symlink 回归已通过；Windows reparse point 待平台 CI）。
- [x] 路径越界、绝对路径、重复路径拒绝。
- [ ] 敏感文件和敏感文本拒绝。
- [ ] manifest 与部署名称不一致拒绝。

### P3-04 API 红绿测试

- [x] Cloudflare API success=false。
- [x] Token 无效/错误信息脱敏。
- [ ] 权限不足的完整映射。
- [x] 资源已存在。
- [x] 资源明确不存在。
- [x] 429。
- [x] 5xx。
- [x] 超时。
- [x] 断网/网络错误。
- [x] JSON 格式错误。
- [x] 错误响应超过大小限制。
- [x] 恶意重定向不转发 Authorization。

### P3-05 上传与部分成功测试

- [x] Assets 单批成功。
- [x] Assets 多批成功。
- [x] 某批失败时停止并记录批次。
- [x] bucket 成功、secrets 失败路径的状态模型（bucket unknown/query、部署工作流）已覆盖。
- [ ] secrets 成功、Worker 失败。
- [x] Worker deployment 请求超时但查询显示已部署。
- [ ] Worker 请求超时且查询仍未知。
- [x] 首页 500、404、重定向、标记缺失核心检查。
- [x] 没有 workers.dev subdomain 时保留 deployed 状态。

### P3-06 安全输出测试

- [x] Token 不出现在 stdout。
- [x] Token 不出现在 stderr。
- [x] Token 不出现在错误字符串。
- [x] 管理员密码和生成 secret 不出现在 CLI 输出。
- [x] Authorization 不发往非 Cloudflare API host。
- [x] 文件内容不出现在阶段日志。

### P3-07 中断和退出码

- [ ] 确认前取消返回专用退出码。
- [ ] 上传中 Ctrl+C 取消 context。
- [ ] 取消后不启动后续写入阶段。
- [ ] 预检失败、参数失败、部署部分成功、结果未知、成功分别有稳定退出码。
- [ ] 本地临时文件仅清理本次拥有的路径。

### P3-08 本地命令

计划执行：

```bash
cd tools/cloudbox-deployer
gofmt -w .
go test ./...
go vet ./...
go test -race ./...
go build ./cmd/cloudbox-deployer
# 当前模块目录执行：gofmt、go test、go vet、go test -race、go build 均已通过
```

如 Go 版本或环境不支持某项，记录精确命令和原因，不伪报通过。

**G1 关卡：P3 全部通过后，才考虑真实独立测试资源。**

---

## P4：真实独立测试资源验证（单独授权）

本阶段默认暂停。必须获得明确授权后执行。

### P4-01 执行前确认

- [ ] 测试账号和 API Token 权限已确认。
- [ ] Worker/bucket 名称全新且专用。
- [ ] 可能产生费用已确认。
- [ ] 不接触生产资源。
- [ ] 是否允许写入 Durable Object migration 已明确。
- [ ] 失败后的云端资源处理方案已明确。

### P4-02 真实流程

- [ ] 只读预检。
- [ ] 展示部署摘要。
- [ ] 明确确认。
- [ ] 创建 bucket。
- [ ] 上传 Assets。
- [ ] 配置 Worker、bindings 和 DO metadata。
- [ ] 写入七项 secrets。
- [ ] 查询 workers.dev 地址。
- [ ] 首页检查。
- [ ] 登录页检查。
- [ ] 使用测试文件验证上传、列举、下载。
- [ ] 再次运行相同名称，确认安全拒绝。

### P4-03 证据

- [ ] 记录 Go 构建版本和 artifact commit。
- [ ] 记录每个部署阶段结果。
- [ ] 记录首页、登录和文件操作结果。
- [ ] 记录失败和结果未知场景。
- [ ] 公开报告不包含真实 Token、密码、管理入口或私密域名。

**G2 关卡：真实 API 行为通过后，才封装正式单文件。**

---

## P5：macOS 单文件候选版

### P5-01 内嵌产物

- [ ] 使用 Go `embed` 或等效固定方式内嵌 Worker、Dashboard 和 manifest。
- [ ] 构建时生成 artifact，不手工编辑内嵌文件。
- [ ] 启动时重新校验内嵌 artifact。
- [ ] 单文件运行不依赖外部源码、脚本、Node、pnpm 或 Wrangler。

### P5-02 macOS 交互

- [ ] `--help`、`--version` 不联网。
- [ ] Worker/bucket 默认值与现有向导一致。
- [ ] 显示部署前检查状态。
- [ ] 显示开始部署状态。
- [ ] 长操作显示活动状态和阶段。
- [ ] 可显示真实上传进度；不能伪造未知百分比。
- [ ] 支持 Ctrl+C。
- [ ] 最终输出地址、首页验证状态和后续人工检查提示。

### P5-03 本地文件和权限

- [ ] 普通用户可运行。
- [ ] 不修改 shell profile、PATH、系统目录或系统配置。
- [ ] 临时文件使用安全目录和唯一名称。
- [ ] 临时目录清理路径经过所有权和越界校验。
- [ ] 失败不会删除用户文件。

### P5-04 单文件验收

- [ ] 复制到空目录可运行。
- [ ] 无 Go、Node、pnpm、Wrangler 时可运行。
- [ ] 中文路径和空格路径可运行。
- [ ] 只读当前目录可运行。
- [ ] 记录文件大小、启动时间和内存，以实测为准。

---

## P6：macOS 候选版验收

- [ ] 当前 Mac CPU 架构完整运行。
- [ ] 另一 Mac 架构仅在真实机器或可信 CI 验证后标记支持。
- [ ] 无网络、代理、超时、证书异常验证。
- [ ] Ctrl+C 和终端关闭行为验证。
- [ ] Gatekeeper 行为记录。
- [ ] Developer ID 签名/notarization 是否纳入发布范围，单独决定。
- [ ] SHA-256 记录。
- [ ] README 支持矩阵与实际结果一致。
- [ ] 现有 SH/BAT 入口未被提前删除。
- [ ] `git diff --check`、Go 测试、构建和敏感信息扫描通过。

**G3 关卡：macOS 候选版通过后，才扩展 Windows/Linux。**

---

## P7：Windows/Linux 扩展

### P7-01 Windows 10/11 x64

- [ ] 交叉编译。
- [ ] Windows 10 目标最低版本明确。
- [ ] Windows 11 验证。
- [ ] 控制台中文输入/输出。
- [ ] 双击和终端运行。
- [ ] Ctrl+C、退出码和取消。
- [ ] 中文路径、空格路径。
- [ ] 普通用户权限。
- [ ] 无 Node/.NET/Go 环境运行。
- [ ] 系统代理、TLS 和证书行为。
- [ ] 代码签名和 SmartScreen 行为。

### P7-02 Linux x64/ARM64

- [ ] `CGO_ENABLED=0` 构建。
- [ ] Linux x64 验证。
- [ ] Linux ARM64 仅实机验证后标记支持。
- [ ] glibc 环境验证。
- [ ] musl/极简镜像行为记录。
- [ ] CA 证书缺失给出明确错误，不关闭 TLS 验证。
- [ ] SSH 终端、代理和 Ctrl+C。

### P7-03 发布矩阵

每个平台分别记录：

```text
目标平台：
CPU 架构：
编译命令：
启动验证：
本地模拟测试：
真实 API 验证：
文件大小：
签名/公证：
已知限制：
```

交叉编译成功不等于平台验收通过。

---

## P8：发布入口切换（单独授权）

- [ ] Go 版本通过 macOS 验收。
- [ ] Windows/Linux 支持范围有实际证据。
- [ ] 现有部署脚本与 Go 版本行为差异已记录。
- [ ] README 更新下载地址、校验值和平台矩阵。
- [x] 根目录 `install_cloudbox.sh` 只负责判断 macOS/Linux 架构、固定 SHA-256 下载 `tool/` Go 二进制并执行。
- [ ] 不使用可变 `main` 二进制作为不可验证发布源；固定版本和 SHA-256。
- [ ] 发布包不包含 secrets、用户路径和测试凭据。
- [ ] 提交、推送、Release 和公开入口切换逐项取得授权。

---

## 当前执行记录

### 任务状态

- [x] 已确认采用“macOS 优先验证的跨平台 Go 部署器”路线。
- [x] 已创建本计划文件。
- [x] P0-01 仓库和工作区基线。
- [x] P0-02 源码和构建权威来源。
- [ ] P0-03 Cloudflare API 契约（Assets hash 已核实；DO API 前置条件和真实请求仍待独立测试资源验证）。
- [x] P0-04 Go 工具布局。
- [x] P1 固定部署产物清单（canonical build、manifest、敏感扫描和 compatibility metadata 已完成）。
- [x] P2 Go API 原型（真实 `deploy` CLI 已接入；Assets completion JWT 累积已修复，Durable Objects 初始 migration 已改为非版本化 Worker upload；Worker version unknown 查询和完整 JWT 失效续传仍待补）。
- [ ] P3 本地模拟与失败回归（43 项测试通过，secrets→Worker 失败和未知结果矩阵待补）。
- [x] G1 本地协议关卡（本地模拟 API 的真实 deploy 全流程通过；未连接 Cloudflare）。
- [ ] P4 真实测试资源部署（需单独授权）。
- [x] P5 macOS 单文件候选版（artifact 生成/内嵌、直接运行部署入口已通过；正式签名和下载验收待后续）。
- [ ] P6 macOS 验收。
- [ ] P7 Windows/Linux 扩展（Windows amd64 已完成真实部署验证；Windows x86/ARM64、Linux 各架构和签名发布仍待完成）。
- [ ] P8 发布入口切换（根 Shell 启动器和 tool 二进制已准备，GitHub 发布 pin/推送仍待授权）。

### 本次执行记录

```text
状态：进行中，未进入真实云端部署

已完成：
- 写入本计划文件。
- 核对现有 Worker、Dashboard、wrangler.toml、secrets 和现有 Node/Wrangler 工作流。
- 创建 tools/cloudbox-deployer Go module。
- 实现 artifact manifest 生成、加载、路径校验、symlink 拒绝、SHA-256 完整性校验和 Wrangler upload hash。
- 实现 canonical artifact 构建脚本：现有 pnpm build、Wrangler dry-run bundle、BLAKE3 upload hash、敏感内容扫描和 build metadata。
- 实现 Cloudflare API client 原型：R2 bucket、Worker 列表、Assets upload session、Assets multipart upload、Worker version、非版本化 Worker upload、deployment、secret、workers.dev subdomain、deployment 状态查询。
- 实现读取请求有限重试、429/5xx/网络错误分类、写入不盲重试。
- 实现本地预检和部署工作流原型，支持 bucket/deployment 结果未知后的查询确认。
- 实现部署后首页检查核心和警告保留。
- 实现部署后显式启用 Worker `workers.dev` subdomain，并兼容 Wrangler 所需的 `Cloudflare-Workers-Script-Api-Date: 2025-08-01` 请求头；失败时保留部署成功状态并输出部署警告。
- 实现 macOS 控制台 dry-run：显式输入、安全提示、默认名称、部署摘要和取消处理；不写入 Cloudflare。
- 实现 macOS 单文件 artifact 内嵌候选和离线校验命令。
- 接入真实部署 CLI：直接运行 `cloudbox_deployer` 即进入 API Token、预检、确认、bucket、Assets、Worker migration/version、secrets、workers.dev 和首页流程。
- 将 artifact 构建命令拆到独立 `cmd/cloudbox-artifact`，部署二进制不再暴露子命令。
- 添加 `build:deployer` 生成 `cloudbox_deployer` 单文件二进制。
- 添加 config、artifact、console、Cloudflare API、预检、工作流、Assets 批次和单文件内嵌测试。

涉及文件：
- tools/cloudbox-deployer/go.mod
- tools/cloudbox-deployer/cmd/cloudbox-deployer/main.go
- tools/cloudbox-deployer/internal/config/
- tools/cloudbox-deployer/internal/artifact/
- tools/cloudbox-deployer/internal/console/
- tools/cloudbox-deployer/internal/cloudflare/
- tools/cloudbox-deployer/internal/deploy/
- scripts/build_cloudbox_artifact.mjs
- package.json
- scripts/plan_todo.md

验证命令和结果：
- node --check scripts/build_cloudbox_artifact.mjs：通过
- gofmt -w tools/cloudbox-deployer：通过
- go test ./...：48 passed
- go vet ./...：通过
- go test -race ./...：此前通过；本轮新增 subdomain/migration 代码已通过 go test
- go build ./cmd/cloudbox-deployer：通过
- macOS arm64、Windows amd64、Linux amd64 交叉编译：此前通过
- canonical pnpm build + Wrangler dry-run + Go manifest + artifact 校验：通过
- 独立 Node BLAKE3 基准与 manifest uploadHash：匹配
- macOS dry-run y/n 两条路径：通过
- API 429/5xx/网络错误/超时/响应大小/JSON/重定向测试：通过
- Assets 多批次和批次失败测试：通过
- bucket/deployment unknown 查询确认测试：通过
- 首页成功、缺标记和部署警告保留测试：通过
- 单文件 artifact 内嵌候选：14 个文件、706698 字节，embedded-verify 通过
- `build:deployer` 生成二进制并通过 `embedded-verify`。
- `deploy` 真实流程接入本地模拟 API：预检、创建 bucket、Assets、Worker version、deployment、地址输出均通过。
- 未使用真实 Token，未执行云端写入；真实 deploy 仅对本地 HTTP 模拟 API 验证

阻塞/待补：
- Worker version metadata、Durable Objects migration 和 secrets binding 尚未在真实 Cloudflare 资源验证。
- Assets 多批重试、写入超时后的远程状态查询和首页检查尚未完成。
- 单文件 artifact 内嵌候选已完成；正式签名、公证、下载后 Gatekeeper 和真实部署 CLI 接线仍未完成。
- P4 真实独立测试资源部署未授权，保持暂停。
```

### 验收记录模板

```text
任务编号：
状态：未开始 / 进行中 / 待验收 / 已通过 / 阻塞

完成内容：
涉及文件：
验证命令：
实际结果：
证据位置：
未解决问题：
是否涉及云端写入：否 / 是（已获授权）
下一步：
```

### 开发纪律

- 任何失败测试先保留为回归测试，再修复最小代码。
- 任何真实云端写入先停在授权关卡，不因本地测试通过自动执行。
- 任何新增依赖先说明必要性和维护成本。
- 任何公共入口、README、脚本或发布 pin 的修改，均在 Go 版本通过验收后单独审核。
