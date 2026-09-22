package deploy

import (
	"context"
	"fmt"

	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/artifact"
	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/config"
)

type Remote interface {
	BucketExists(context.Context, string) (bool, error)
	WorkerExists(context.Context, string) (bool, error)
}

type PreflightResult struct {
	WorkerName   string
	BucketName   string
	WorkerExists bool
	BucketExists bool
}

func ValidateLocal(input config.DeploymentInput, manifest artifact.Manifest, artifactRoot string) error {
	if err := config.ValidateInput(input); err != nil {
		return err
	}
	if err := artifact.VerifyFiles(artifactRoot, manifest); err != nil {
		return err
	}
	return nil
}

func CheckRemote(ctx context.Context, remote Remote, workerName, bucketName string) (PreflightResult, error) {
	if workerName == "" || bucketName == "" {
		return PreflightResult{}, fmt.Errorf("Worker 和 bucket 名称不能为空")
	}
	workerExists, err := remote.WorkerExists(ctx, workerName)
	if err != nil {
		return PreflightResult{}, fmt.Errorf("检查 Worker 失败：%w", err)
	}
	bucketExists, err := remote.BucketExists(ctx, bucketName)
	if err != nil {
		return PreflightResult{}, fmt.Errorf("检查 R2 bucket 失败：%w", err)
	}
	if workerExists || bucketExists {
		return PreflightResult{
			WorkerName:   workerName,
			BucketName:   bucketName,
			WorkerExists: workerExists,
			BucketExists: bucketExists,
		}, fmt.Errorf("目标资源已存在，停止部署（Worker=%t，bucket=%t）", workerExists, bucketExists)
	}
	return PreflightResult{
		WorkerName:   workerName,
		BucketName:   bucketName,
		WorkerExists: false,
		BucketExists: false,
	}, nil
}
