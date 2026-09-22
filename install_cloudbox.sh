#!/bin/sh
set -eu
umask 077

# 发布前将 main 替换为包含 tool/ 二进制和本启动器的固定 40 位 commit SHA。
BINARY_REF=${CLOUDBOX_BINARY_REF:-main}
BINARY_BASE_URL="https://raw.githubusercontent.com/ntetv/cloudbox-r2/${BINARY_REF}/tool"

script_directory=
staging=
binary_path=
binary_owned=0
checksum_command=
checksum_kind=
platform=

fail() {
	printf '%s\n' "install_cloudbox: $*" >&2
	exit 1
}

cleanup() {
	status=$?
	trap - EXIT HUP INT TERM
	if [ -n "$staging" ]; then
		rm -rf "$staging" || :
	fi
	if [ "$binary_owned" -eq 1 ] && [ -n "$binary_path" ]; then
		rm -f "$binary_path" || :
	fi
	exit "$status"
}

trap cleanup EXIT HUP INT TERM

require_tool() {
	tool=$1
	if ! command -v "$tool" >/dev/null 2>&1; then
		fail "缺少必需命令 ${tool}。"
	fi
}

resolve_script_directory() {
	case "$0" in
		*/*) script_directory=${0%/*} ;;
		*) script_directory=. ;;
	esac
	[ -n "$script_directory" ] || script_directory=.
	if ! script_directory=$(CDPATH= cd -P "$script_directory" 2>/dev/null && pwd -P); then
		fail "无法定位 install_cloudbox.sh 所在目录。"
	fi
}

resolve_checksum_tool() {
	if command -v sha256sum >/dev/null 2>&1; then
		checksum_command=$(command -v sha256sum)
		checksum_kind=sha256sum
	elif command -v shasum >/dev/null 2>&1; then
		checksum_command=$(command -v shasum)
		checksum_kind=shasum
	else
		fail "缺少 sha256sum 或 shasum。"
	fi
}

checksum_matches() {
	target=$1
	expected=$2
	if [ "$checksum_kind" = sha256sum ]; then
		output=$($checksum_command "$target") || return 1
	else
		output=$($checksum_command -a 256 "$target") || return 1
	fi
	actual=${output%%[[:space:]]*}
	[ "$actual" = "$expected" ]
}

resolve_sha256() {
	case "$platform" in
		darwin-arm64) printf '%s\n' "25f27cd58909b28b458aa42efe9ab895f3c83ee9b53c4b85254d898f662ff32d" ;;
		darwin-amd64) printf '%s\n' "338ab6bc1d1502a432b948306ca02e6454d993bee11868a196277019cc8e6ed8" ;;
		linux-amd64) printf '%s\n' "cd1bca34f04a69a7deab52acdf61a008b2ee02d34ecd1b04df08140d07232eff" ;;
		linux-386) printf '%s\n' "a9fcdf50919863aa4e63262f8fb03cbe841284bc7d4633d9d4fa6ac064b46470" ;;
		linux-arm64) printf '%s\n' "c872182a5b0e67ae9978007c5bd37204ca2e480c076ccf0068116ea6caeca628" ;;
		linux-armv7) printf '%s\n' "f0a30f7f4a95e52f043e88a33c95705148c8ceeaf7f382d0ab1d451034e91f1d" ;;
		*) fail "内部架构映射无效：$platform。" ;;
	esac
}

detect_platform() {
	kernel=
	machine=
	kernel=$(uname -s 2>/dev/null || :)
	machine=$(uname -m 2>/dev/null || :)
	[ -n "$kernel" ] || fail "无法识别操作系统。"
	[ -n "$machine" ] || fail "无法识别 CPU 架构。"
	case "$kernel:$machine" in
		Darwin:arm64|Darwin:aarch64) platform=darwin-arm64 ;;
		Darwin:x86_64|Darwin:amd64) platform=darwin-amd64 ;;
		Darwin:*) fail "macOS 仅支持 arm64 和 amd64；检测到 $machine。" ;;
		Linux:aarch64|Linux:arm64) platform=linux-arm64 ;;
		Linux:armv7l|Linux:armv7|Linux:armhf|Linux:arm) platform=linux-armv7 ;;
		Linux:x86_64|Linux:amd64) platform=linux-amd64 ;;
		Linux:i386|Linux:i686|Linux:x86) platform=linux-386 ;;
		Linux:*) fail "不支持的 Linux CPU 架构：$machine。" ;;
		*) fail "不支持的平台：$kernel/$machine；仅支持 macOS 或 Linux。" ;;
	esac
}

resolve_binary_path() {
	binary_path=$script_directory/cloudbox_deployer-$platform
}

use_existing_binary() {
	[ -e "$binary_path" ] || return 1
	[ ! -L "$binary_path" ] || fail "同目录二进制是符号链接，拒绝执行：$binary_path"
	[ -f "$binary_path" ] || fail "同目录二进制不是普通文件，拒绝执行：$binary_path"
	checksum_matches "$binary_path" "$binary_sha256" || fail "同目录二进制 SHA-256 不匹配，拒绝执行：$binary_path"
	chmod 700 "$binary_path" || fail "无法设置二进制权限。"
	binary_owned=1
	return 0
}

download_binary() {
	require_tool curl
	require_tool mktemp
	require_tool mkdir
	require_tool mv
	require_tool chmod
	require_tool rm
	resolve_checksum_tool
	if [ -e "$binary_path" ] || [ -L "$binary_path" ]; then
		if use_existing_binary; then
			return
		fi
		fail "同目录二进制已存在但校验失败，拒绝覆盖：$binary_path"
	fi
	staging=$(mktemp -d "$script_directory/.cloudbox_deployer-$platform.XXXXXX") || fail "无法创建同目录 staging 目录。"
	chmod 700 "$staging" || fail "无法设置 staging 目录权限。"
	temporary=$staging/cloudbox_deployer-$platform
	url=$BINARY_BASE_URL/cloudbox_deployer-$platform
	if ! curl --fail --silent --show-error --location \
		--proto '=https' --proto-redir '=https' --max-redirs 3 \
		--connect-timeout 10 --max-time 180 \
		--output "$temporary" "$url"
	then
		fail "固定 $platform 二进制下载失败。"
	fi
	[ -f "$temporary" ] || fail "二进制下载没有生成文件。"
	checksum_matches "$temporary" "$binary_sha256" || fail "二进制 SHA-256 不匹配，拒绝执行。"
	chmod 700 "$temporary" || fail "无法设置二进制 staging 权限。"
	if [ -e "$binary_path" ] || [ -L "$binary_path" ]; then
		fail "同目录二进制在发布前出现，拒绝覆盖：$binary_path"
	fi
	mv "$temporary" "$binary_path" || fail "无法原子发布同目录二进制。"
	checksum_matches "$binary_path" "$binary_sha256" || fail "同目录二进制发布后校验失败。"
	chmod 700 "$binary_path" || fail "无法设置二进制权限。"
	binary_owned=1
}

resolve_script_directory
require_tool uname
detect_platform
resolve_binary_path
resolve_checksum_tool
binary_sha256=$(resolve_sha256)
download_binary

"$binary_path" "$@"
status=$?
exit "$status"
