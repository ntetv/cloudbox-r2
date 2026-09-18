#!/bin/sh
set -eu
umask 077

NODE_VERSION=22.23.2
NODE_RELEASE_URL="https://nodejs.org/download/release/v${NODE_VERSION}"

# Filled only after a released, fixed MJS payload has a real commit and hash.
REMOTE_MJS_REF=499f2b41895a6402747bb3a6ff7e924fdc7c96b3
REMOTE_MJS_SHA256=ad3c05ddd41cc23058dffca6b66a7cb773c1dbc838dd90a71e2a3271b5397634

staging=
node_command=
node_bin_directory=
script_directory=
mjs_path=
node_platform=
node_home=

fail() {
	printf '%s\n' "setup-cloudflare: $*" >&2
	exit 1
}

cleanup_staging() {
	if [ -n "$staging" ]; then
		rm -rf "$staging" || :
		staging=
	fi
}

cleanup() {
	status=$?
	trap - EXIT HUP INT TERM
	cleanup_staging
	exit "$status"
}

trap cleanup EXIT HUP INT TERM

resolve_script_directory() {
	case "$0" in
		*/*)
			script_directory=${0%/*}
			[ -n "$script_directory" ] || script_directory=/
			;;
		*)
			script_directory=.
			;;
	esac
	if ! script_directory=$(CDPATH= cd -P "$script_directory" 2>/dev/null && pwd -P); then
		fail "无法定位启动器目录。"
	fi
}

trusted_sibling_mjs() {
	[ -f "$script_directory/setup-cloudflare.mjs" ] || return 1
	if ! project_root=$(CDPATH= cd -P "$script_directory/.." 2>/dev/null && pwd -P); then
		return 1
	fi
	for marker in \
		package.json \
		pnpm-lock.yaml \
		pnpm-workspace.yaml \
		wrangler.toml \
		src/index.ts \
		packages/worker/package.json \
		packages/dashboard/package.json
	do
		[ -f "$project_root/$marker" ] || return 1
	done
	return 0
}

resolve_mjs() {
	if trusted_sibling_mjs; then
		mjs_path=$script_directory/setup-cloudflare.mjs
		return
	fi
	if [ -n "$REMOTE_MJS_REF" ] || [ -n "$REMOTE_MJS_SHA256" ]; then
		fail "独立模式的固定 MJS payload 尚未完成实现；请先发布并固定 commit 与 SHA-256。"
	fi
	fail "未找到受信任的 sibling setup-cloudflare.mjs；独立模式的固定 MJS payload 尚未发布，请从完整仓库运行此启动器。"
}

node_major_at_least_22() {
	version=$1
	case "$version" in
		v[0-9]*.[0-9]*.[0-9]*) ;;
		*) return 1 ;;
	esac
	major=${version#v}
	major=${major%%.*}
	case "$major" in
		''|*[!0-9]*) return 1 ;;
	esac
	[ "$major" -ge 22 ]
}

find_existing_node() {
	candidate=
	version=
	if ! candidate=$(command -v node 2>/dev/null); then
		return 1
	fi
	if ! version=$("$candidate" --version 2>/dev/null); then
		return 1
	fi
	if ! node_major_at_least_22 "$version"; then
		return 1
	fi
	node_command=$candidate
	node_bin_directory=
	return 0
}

require_tool() {
	tool=$1
	if ! command -v "$tool" >/dev/null 2>&1; then
		fail "缺少必需命令 ${tool}；已在下载前停止。"
	fi
}

detect_platform() {
	if ! kernel=$(uname -s 2>/dev/null); then
		fail "无法识别操作系统。"
	fi
	if ! machine=$(uname -m 2>/dev/null); then
		fail "无法识别 CPU 架构。"
	fi
	case "$kernel:$machine" in
		Darwin:x86_64|Darwin:amd64)
			node_platform=darwin-x64
			;;
		Darwin:arm64|Darwin:aarch64)
			node_platform=darwin-arm64
			;;
		Linux:x86_64|Linux:amd64)
			node_platform=linux-x64
			;;
		Linux:aarch64|Linux:arm64)
			node_platform=linux-arm64
			;;
		Linux:*)
			fail "不支持的 Linux CPU 架构：${machine}。"
			;;
		*)
			fail "不支持的平台：${kernel}/${machine}；仅支持 macOS 或 Linux。"
			;;
	esac

	if [ "$kernel" = Linux ]; then
		if ! ldd_command=$(command -v ldd 2>/dev/null); then
			fail "无法确认 Linux 使用 glibc；检测到未知 libc，拒绝继续。"
		fi
		ldd_output=$("$ldd_command" --version 2>&1 || :)
		case "$ldd_output" in
			*musl*|*Musl*|*MUSL*)
				fail "检测到 musl libc；官方 Linux Node 包仅按 glibc 处理。"
				;;
			*glibc*|*GLIBC*|*GNU*)
				;;
			*)
				fail "无法确认 Linux 使用 glibc；未知 libc 拒绝继续。"
				;;
		esac
	fi
}

node_release_details() {
	case "$node_platform" in
		darwin-x64)
			node_archive=node-v22.23.2-darwin-x64.tar.gz
			node_sha256=58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026
			;;
		darwin-arm64)
			node_archive=node-v22.23.2-darwin-arm64.tar.gz
			node_sha256=61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6
			;;
		linux-x64)
			node_archive=node-v22.23.2-linux-x64.tar.gz
			node_sha256=b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a
			;;
		linux-arm64)
			node_archive=node-v22.23.2-linux-arm64.tar.gz
			node_sha256=013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30
			;;
		*)
			fail "内部平台映射无效：${node_platform}。"
			;;
	esac
	node_archive_url=$NODE_RELEASE_URL/$node_archive
}

validate_node_home() {
	candidate_home=$1
	candidate_node=$candidate_home/bin/node
	candidate_npm=$candidate_home/bin/npm
	[ -x "$candidate_node" ] || return 1
	[ -x "$candidate_npm" ] || return 1
	candidate_version=$("$candidate_node" --version 2>/dev/null) || return 1
	[ "$candidate_version" = "v$NODE_VERSION" ]
}

prepare_fixed_node() {
	detect_platform
	node_release_details

	if [ -z "${HOME:-}" ]; then
		fail "未设置 HOME，无法选择用户目录。"
	fi
	if [ -n "${XDG_DATA_HOME:-}" ]; then
		data_home=$XDG_DATA_HOME
	else
		data_home=$HOME/.local/share
	fi
	case "$data_home" in
		/*) ;;
		*) fail "XDG_DATA_HOME 必须是绝对路径。" ;;
	esac

	cache_parent=$data_home/cloudbox-r2
	node_home=$cache_parent/node-v$NODE_VERSION-$node_platform
	if [ -e "$node_home" ] || [ -L "$node_home" ]; then
		if validate_node_home "$node_home"; then
			node_command=$node_home/bin/node
			node_bin_directory=$node_home/bin
			return
		fi
		fail "Node 缓存已存在但校验失败，拒绝执行或覆盖：$node_home"
	fi

	require_tool curl
	require_tool tar
	require_tool mktemp
	if command -v sha256sum >/dev/null 2>&1; then
		checksum_command=$(command -v sha256sum)
		checksum_kind=sha256sum
	elif command -v shasum >/dev/null 2>&1; then
		checksum_command=$(command -v shasum)
		checksum_kind=shasum
	else
		fail "缺少 sha256sum 或 shasum；已在下载前停止。"
	fi

	if ! mkdir -p "$cache_parent"; then
		fail "无法创建 Node 用户缓存目录：$cache_parent"
	fi
	if ! staging=$(mktemp -d "$cache_parent/.node-v$NODE_VERSION-$node_platform.XXXXXX"); then
		fail "无法创建私有 Node staging 目录。"
	fi
	if [ -z "$staging" ] || [ ! -d "$staging" ]; then
		fail "mktemp 未返回有效的 Node staging 目录。"
	fi

	archive_path=$staging/$node_archive
	extract_root=$staging/extracted
	if ! mkdir "$extract_root"; then
		fail "无法创建 Node 解压 staging 目录。"
	fi
	if ! curl --fail --silent --show-error --location \
		--proto '=https' --proto-redir '=https' --max-redirs 3 \
		--connect-timeout 10 --max-time 120 \
		--output "$archive_path" "$node_archive_url"
	then
		fail "Node.js $NODE_VERSION 下载失败。"
	fi
	[ -f "$archive_path" ] || fail "Node.js 下载没有生成归档文件。"

	if [ "$checksum_kind" = sha256sum ]; then
		if ! checksum_output=$("$checksum_command" "$archive_path"); then
			fail "Node.js 归档 SHA-256 计算失败。"
		fi
	else
		if ! checksum_output=$("$checksum_command" -a 256 "$archive_path"); then
			fail "Node.js 归档 SHA-256 计算失败。"
		fi
	fi
	actual_sha256=${checksum_output%%[[:space:]]*}
	[ "$actual_sha256" = "$node_sha256" ] || fail "Node.js 归档 SHA-256 不匹配，拒绝解包。"

	if ! tar -xzf "$archive_path" -C "$extract_root"; then
		fail "Node.js 归档解包失败。"
	fi
	candidate_home=$extract_root/node-v$NODE_VERSION-$node_platform
	if ! validate_node_home "$candidate_home"; then
		fail "Node.js staging 校验失败，拒绝发布。"
	fi
	if [ -e "$node_home" ] || [ -L "$node_home" ]; then
		fail "Node 缓存目标在发布前出现，拒绝覆盖：$node_home"
	fi
	if ! mv "$candidate_home" "$node_home"; then
		fail "无法原子发布 Node 缓存：$node_home"
	fi
	if ! validate_node_home "$node_home"; then
		fail "Node 缓存发布后校验失败，拒绝执行。"
	fi
	node_command=$node_home/bin/node
	node_bin_directory=$node_home/bin
}

resolve_script_directory
resolve_mjs

if ! find_existing_node; then
	prepare_fixed_node
fi

if [ -n "$node_bin_directory" ]; then
	if [ -n "${PATH:-}" ]; then
		PATH=$node_bin_directory:$PATH
	else
		PATH=$node_bin_directory
	fi
	export PATH
fi

cleanup_staging
exec "$node_command" "$mjs_path" "$@"
