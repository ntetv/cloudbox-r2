package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/artifact"
	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/cloudflare"
	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/config"
)

type API interface {
	Remote
	CreateBucket(context.Context, string) error
	StartAssetsUploadSession(context.Context, string, map[string]cloudflare.AssetManifestEntry) (cloudflare.AssetsUploadSession, error)
	UploadAssetBucket(context.Context, string, []cloudflare.AssetUpload) (string, error)
	CreateWorkerVersion(context.Context, string, []byte, string, string, io.Reader, int64) (cloudflare.WorkerVersion, error)
	UploadWorker(context.Context, string, []byte, string, string, io.Reader, int64) error
	PutSecret(context.Context, string, string, string) error
	DeployVersion(context.Context, string, string, string) error
	DeploymentContainsVersion(context.Context, string, string) (bool, error)
	EnableWorkerSubdomain(context.Context, string) (bool, error)
	WorkersDevSubdomain(context.Context) (string, error)
}

type Confirm func(workerName, bucketName, version string) bool
type HomeCheck func(context.Context, string) error
type Stage func(string)

type Result struct {
	Status            string
	Completed         []string
	VersionID         string
	URL               string
	HomeCheckError    string
	DeploymentWarning string
}

func Run(ctx context.Context, api API, root string, manifest artifact.Manifest, input config.DeploymentInput, secrets map[string]string, confirm Confirm, onStage Stage) (Result, error) {
	return run(ctx, api, root, manifest, input, secrets, confirm, onStage, nil)
}

func RunWithHomeCheck(ctx context.Context, api API, root string, manifest artifact.Manifest, input config.DeploymentInput, secrets map[string]string, confirm Confirm, onStage Stage, homeCheck HomeCheck) (Result, error) {
	return run(ctx, api, root, manifest, input, secrets, confirm, onStage, homeCheck)
}

func run(ctx context.Context, api API, root string, manifest artifact.Manifest, input config.DeploymentInput, secrets map[string]string, confirm Confirm, onStage Stage, homeCheck HomeCheck) (Result, error) {
	if onStage == nil {
		onStage = func(string) {}
	}
	if err := ValidateLocal(input, manifest, root); err != nil {
		return Result{Status: "preflight_failed"}, err
	}
	if err := validateSecrets(manifest, secrets); err != nil {
		return Result{Status: "preflight_failed"}, err
	}
	preflight, err := CheckRemote(ctx, api, input.WorkerName, input.BucketName)
	if err != nil {
		return Result{Status: "preflight_failed"}, err
	}
	onStage(fmt.Sprintf("预检完成：Worker=%s，bucket=%s", preflight.WorkerName, preflight.BucketName))
	if confirm != nil && !confirm(input.WorkerName, input.BucketName, manifest.ApplicationVersion) {
		return Result{Status: "cancelled"}, nil
	}

	result := Result{Status: "deploying"}
	if err := api.CreateBucket(ctx, input.BucketName); err != nil {
		if cloudflare.IsOutcomeUnknown(err) {
			exists, queryErr := api.BucketExists(ctx, input.BucketName)
			if queryErr == nil && exists {
				result.Completed = append(result.Completed, "R2 bucket")
				onStage(fmt.Sprintf("R2 bucket %s 已确认创建", input.BucketName))
			} else {
				result.Status = "bucket_unknown"
				onStage(fmt.Sprintf("R2 bucket %s 可能已创建", input.BucketName))
				return result, err
			}
		} else {
			result.Status = "bucket_unknown"
			onStage(fmt.Sprintf("R2 bucket %s 可能已创建", input.BucketName))
			return result, err
		}
	} else {
		result.Completed = append(result.Completed, "R2 bucket")
		onStage(fmt.Sprintf("R2 bucket %s", input.BucketName))
	}

	completionJWT, err := uploadAssets(ctx, api, root, manifest, input.WorkerName)
	if err != nil {
		result.Status = "assets_failed"
		return result, err
	}
	result.Completed = append(result.Completed, "Workers Assets")
	onStage("Workers Assets")

	metadata, err := workerMetadata(manifest, input.BucketName, secrets, completionJWT)
	if err != nil {
		result.Status = "preflight_failed"
		return result, err
	}
	workerPath := filepath.Join(root, filepath.FromSlash(manifest.Worker.Path))
	worker, err := os.Open(workerPath)
	if err != nil {
		result.Status = "worker_failed"
		return result, fmt.Errorf("打开 Worker artifact 失败：%w", err)
	}
	var version cloudflare.WorkerVersion
	var createErr error
	if len(manifest.Migration.NewSQLiteClasses) > 0 {
		createErr = api.UploadWorker(ctx, input.WorkerName, metadata, manifest.Worker.MainModule, manifest.Worker.MIMEType, worker, manifest.Worker.Size)
	} else {
		version, createErr = api.CreateWorkerVersion(ctx, input.WorkerName, metadata, manifest.Worker.MainModule, manifest.Worker.MIMEType, worker, manifest.Worker.Size)
	}
	closeErr := worker.Close()
	if createErr != nil {
		if cloudflare.IsOutcomeUnknown(createErr) {
			exists, queryErr := api.WorkerExists(ctx, input.WorkerName)
			if queryErr == nil && exists {
				result.Completed = append(result.Completed, "Worker upload")
				onStage(fmt.Sprintf("Worker %s 已确认上传", input.WorkerName))
			} else {
				result.Status = "worker_unknown"
				onStage(fmt.Sprintf("Worker %s 可能已上传", input.WorkerName))
				return result, createErr
			}
		} else {
			result.Status = "worker_failed"
			onStage(fmt.Sprintf("Worker %s 上传失败", input.WorkerName))
			return result, createErr
		}
	}
	if closeErr != nil {
		return result, fmt.Errorf("关闭 Worker artifact 失败：%w", closeErr)
	}
	for _, name := range manifest.SecretNames {
		if err := api.PutSecret(ctx, input.WorkerName, name, secrets[name]); err != nil {
			result.Status = "secrets_failed"
			onStage(fmt.Sprintf("secrets %s 可能已部分写入", name))
			return result, err
		}
	}
	result.Completed = append(result.Completed, "Worker secrets")
	onStage("七项 Worker secrets")

	if len(manifest.Migration.NewSQLiteClasses) > 0 {
		result.Completed = append(result.Completed, "Worker migration deployment")
		onStage(fmt.Sprintf("Worker %s migration 已提交", input.WorkerName))
	} else {
		if version.ID == "" {
			result.Status = "worker_unknown"
			return result, errors.New("Worker version 响应缺少 version ID")
		}
		result.VersionID = version.ID
	}
	if len(manifest.Migration.NewSQLiteClasses) == 0 {
		result.Completed = append(result.Completed, "Worker version")
		onStage(fmt.Sprintf("Worker version %s", version.ID))
	}

	if len(manifest.Migration.NewSQLiteClasses) > 0 {
		return finishDeployment(ctx, api, input.WorkerName, result, homeCheck, onStage)
	}

	if err := api.DeployVersion(ctx, input.WorkerName, version.ID, "cloudbox-r2 Go deployer"); err != nil {
		if cloudflare.IsOutcomeUnknown(err) {
			deployed, queryErr := api.DeploymentContainsVersion(ctx, input.WorkerName, version.ID)
			if queryErr == nil && deployed {
				result.Completed = append(result.Completed, "Worker deployment")
				onStage(fmt.Sprintf("Worker %s 已确认部署", input.WorkerName))
			} else {
				result.Status = "deployment_unknown"
				onStage(fmt.Sprintf("Worker %s 可能已部署", input.WorkerName))
				return result, err
			}
		} else {
			result.Status = "deployment_unknown"
			onStage(fmt.Sprintf("Worker %s 可能已部署", input.WorkerName))
			return result, err
		}
	} else {
		result.Completed = append(result.Completed, "Worker deployment")
		onStage(fmt.Sprintf("Worker %s", input.WorkerName))
	}

	return finishDeployment(ctx, api, input.WorkerName, result, homeCheck, onStage)
}

func finishDeployment(ctx context.Context, api API, workerName string, result Result, homeCheck HomeCheck, onStage Stage) (Result, error) {
	result.Status = "deployed"
	enabled, err := api.EnableWorkerSubdomain(ctx, workerName)
	if err != nil || !enabled {
		if err != nil {
			result.DeploymentWarning = fmt.Sprintf("workers.dev 启用失败：%s", err)
			onStage(result.DeploymentWarning)
		} else {
			result.DeploymentWarning = "workers.dev 未启用，请到 Cloudflare Dashboard 开启 Worker subdomain"
			onStage(result.DeploymentWarning)
		}
		return result, nil
	}
	subdomain, err := api.WorkersDevSubdomain(ctx)
	if err != nil || config.ValidateWorkerName(subdomain) != nil {
		result.DeploymentWarning = "workers.dev 地址不可用，请到 Cloudflare Dashboard 查看域名配置"
		onStage(result.DeploymentWarning)
		return result, nil
	}
	result.URL = "https://" + workerName + "." + subdomain + ".workers.dev"
	if homeCheck != nil {
		if err := homeCheck(ctx, result.URL+"/"); err != nil {
			result.HomeCheckError = err.Error()
		}
	}
	return result, nil
}

func CheckHome(ctx context.Context, rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Path == "" {
		return errors.New("首页地址无效")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname())) {
		return errors.New("首页检查地址必须使用 HTTPS")
	}
	client := &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return fmt.Errorf("创建首页检查请求失败：%w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("首页检查请求失败：%w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("首页验证失败（HTTP %d）", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
	if err != nil {
		return fmt.Errorf("读取首页响应失败：%w", err)
	}
	if len(body) > 1<<20 {
		return errors.New("首页响应超过大小上限")
	}
	text := string(body)
	if !strings.Contains(text, "cloudbox-r2") && !strings.Contains(text, "Cloudbox") {
		return errors.New("首页验证未找到预期页面标记")
	}
	return nil
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func uploadAssets(ctx context.Context, api API, root string, manifest artifact.Manifest, workerName string) (string, error) {
	entries := make(map[string]cloudflare.AssetManifestEntry, len(manifest.Assets))
	byHash := make(map[string]artifact.Asset, len(manifest.Assets))
	for _, asset := range manifest.Assets {
		entries[asset.Path] = cloudflare.AssetManifestEntry{Hash: asset.UploadHash, Size: asset.Size}
		byHash[asset.UploadHash] = asset
	}
	session, err := api.StartAssetsUploadSession(ctx, workerName, entries)
	if err != nil {
		return "", fmt.Errorf("创建 Workers Assets 上传会话失败：%w", err)
	}
	if len(session.Buckets) == 0 {
		if session.JWT == "" {
			return "", errors.New("Workers Assets 上传响应缺少 completion JWT")
		}
		return session.JWT, nil
	}
	completionJWT := ""
	for _, bucket := range session.Buckets {
		uploads := make([]cloudflare.AssetUpload, 0, len(bucket))
		for _, hash := range bucket {
			asset, ok := byHash[hash]
			if !ok {
				return "", fmt.Errorf("Cloudflare 要求上传未知的 asset hash：%s", hash)
			}
			assetPath := strings.TrimPrefix(asset.Path, "/")
			filePath := filepath.Join(root, filepath.FromSlash(manifest.AssetsDirectory), filepath.FromSlash(assetPath))
			content, err := os.ReadFile(filePath)
			if err != nil {
				return "", fmt.Errorf("读取 Dashboard asset 失败：%w", err)
			}
			uploads = append(uploads, cloudflare.AssetUpload{
				Hash:        hash,
				Content:     content,
				ContentType: asset.ContentType,
			})
		}
		if len(uploads) == 0 {
			continue
		}
		batchJWT, err := api.UploadAssetBucket(ctx, session.JWT, uploads)
		if err != nil {
			return "", fmt.Errorf("上传 Workers Assets 批次失败：%w", err)
		}
		if batchJWT != "" {
			completionJWT = batchJWT
		}
	}
	if completionJWT == "" {
		return "", errors.New("Workers Assets 上传响应缺少 completion JWT")
	}
	return completionJWT, nil
}

func workerMetadata(manifest artifact.Manifest, bucketName string, secrets map[string]string, assetsJWT string) ([]byte, error) {
	bindings := make([]map[string]any, 0, len(manifest.Bindings)+len(manifest.SecretNames))
	for _, binding := range manifest.Bindings {
		entry := map[string]any{
			"name": binding.Name,
			"type": binding.Type,
		}
		switch binding.Type {
		case "r2_bucket":
			entry["bucket_name"] = bucketName
		case "durable_object_namespace":
			entry["class_name"] = binding.ClassName
		case "assets":
		default:
			return nil, fmt.Errorf("不支持的 Worker binding 类型：%s", binding.Type)
		}
		bindings = append(bindings, entry)
	}
	metadata := map[string]any{
		"main_module":        manifest.Worker.MainModule,
		"bindings":           bindings,
		"compatibility_date": manifest.CompatibilityDate,
		"migrations": map[string]any{
			"new_tag": manifest.Migration.Tag,
			"steps": []map[string]any{{
				"new_sqlite_classes": manifest.Migration.NewSQLiteClasses,
			}},
		},
		"assets": map[string]any{
			"jwt": assetsJWT,
			"config": map[string]any{
				"html_handling":      "none",
				"not_found_handling": "404-page",
				"run_worker_first":   true,
			},
		},
	}
	if len(manifest.CompatibilityFlags) > 0 {
		metadata["compatibility_flags"] = manifest.CompatibilityFlags
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return nil, fmt.Errorf("编码 Worker metadata 失败：%w", err)
	}
	return encoded, nil
}

func validateSecrets(manifest artifact.Manifest, secrets map[string]string) error {
	if len(secrets) != len(manifest.SecretNames) {
		return errors.New("Worker secrets 数量与 artifact manifest 不一致")
	}
	for _, name := range manifest.SecretNames {
		if secrets[name] == "" {
			return fmt.Errorf("缺少 Worker secret：%s", name)
		}
	}
	return nil
}
