package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/artifact"
	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/cloudflare"
	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/config"
	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/console"
	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/deploy"
	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/embedded"
)

func deployCommand(args []string) error {
	if len(args) > 0 {
		return fmt.Errorf("该二进制不接受命令或测试参数，请直接运行 cloudbox_deployer")
	}
	root, cleanup, err := resolveEmbeddedArtifact()
	if err != nil {
		return err
	}
	defer cleanup()
	manifest, err := artifact.Load(filepath.Join(root, "manifest.json"))
	if err != nil {
		return err
	}
	if err := artifact.VerifyFiles(root, manifest); err != nil {
		return err
	}

	reader := bufio.NewReader(os.Stdin)
	input, err := console.PromptDeploymentInput(reader, os.Stdout)
	if err != nil {
		return err
	}
	secrets, err := config.GenerateSecrets(input)
	if err != nil {
		return err
	}
	client, err := cloudflare.New(input.AccountID, input.APIToken, "", nil)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var confirmErr error
	result, err := deploy.Run(
		ctx,
		client,
		root,
		manifest,
		input,
		secrets,
		func(workerName, bucketName, version string) bool {
			console.PrintSummary(os.Stdout, input, version)
			confirmed, confirmError := console.Confirm(os.Stdout, reader)
			if confirmError != nil {
				confirmErr = confirmError
				return false
			}
			return confirmed
		},
		func(stage string) {
			fmt.Fprintf(os.Stdout, "部署记录：%s\n", stage)
		},
	)
	if confirmErr != nil {
		return confirmErr
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "部署状态：%s\n", result.Status)
		if len(result.Completed) > 0 {
			fmt.Fprintf(os.Stderr, "已完成阶段：%s\n", strings.Join(result.Completed, "、"))
		}
		return err
	}
	if result.Status == "cancelled" {
		fmt.Fprintln(os.Stdout, "已取消，未创建云端资源。")
		return nil
	}
	if result.URL == "" {
		fmt.Fprintln(os.Stdout, "Worker 已部署，但未检测到 workers.dev 地址，请到 Cloudflare Dashboard 查看。")
	} else {
		fmt.Fprintf(os.Stdout, "部署成功：%s\n", result.URL)
	}
	if result.DeploymentWarning != "" {
		fmt.Fprintf(os.Stdout, "部署警告：%s\n", result.DeploymentWarning)
	}
	return nil
}

func resolveEmbeddedArtifact() (string, func(), error) {
	if len(embedded.Files) == 0 {
		return "", func() {}, fmt.Errorf("当前二进制未内嵌 artifact，请重新生成 cloudbox_deployer")
	}
	root, err := os.MkdirTemp("", "cloudbox-deploy-artifact-")
	if err != nil {
		return "", func() {}, fmt.Errorf("创建内嵌 artifact 临时目录失败：%w", err)
	}
	cleanup := func() { _ = os.RemoveAll(root) }
	for name, content := range embedded.Files {
		relative := filepath.Clean(filepath.FromSlash(name))
		if name == "" || filepath.IsAbs(relative) || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			cleanup()
			return "", func() {}, fmt.Errorf("内嵌 artifact 路径无效：%s", name)
		}
		target := filepath.Join(root, relative)
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			cleanup()
			return "", func() {}, err
		}
		if err := os.WriteFile(target, content, 0o600); err != nil {
			cleanup()
			return "", func() {}, err
		}
	}
	return root, cleanup, nil
}
