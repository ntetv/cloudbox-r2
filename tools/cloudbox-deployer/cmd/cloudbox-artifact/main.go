package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/artifact"
)

type buildMetadata struct {
	ApplicationVersion string   `json:"applicationVersion"`
	SourceCommit       string   `json:"sourceCommit"`
	CompatibilityDate  string   `json:"compatibilityDate"`
	CompatibilityFlags []string `json:"compatibilityFlags"`
	MainModule         string   `json:"mainModule"`
	MigrationTag       string   `json:"migrationTag"`
	MigrationClasses   []string `json:"migrationClasses"`
}

func main() {
	if len(os.Args) < 2 {
		fatal(fmt.Errorf("必须提供 build-manifest 或 validate-artifact 命令"))
	}
	switch os.Args[1] {
	case "build-manifest":
		if err := buildManifest(os.Args[2:]); err != nil {
			fatal(err)
		}
	case "validate-artifact":
		if err := validateArtifact(os.Args[2:]); err != nil {
			fatal(err)
		}
	default:
		fatal(fmt.Errorf("未知 artifact 工具命令：%s", os.Args[1]))
	}
}

func buildManifest(args []string) error {
	flags := flag.NewFlagSet("build-manifest", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	artifactRoot := flags.String("artifact-root", "", "artifact 文件根目录")
	workerFile := flags.String("worker-file", "", "已构建的 Worker module 文件")
	assetsDirectory := flags.String("assets-dir", "", "Dashboard assets 目录")
	output := flags.String("output", "", "manifest 输出路径")
	uploadHashesPath := flags.String("upload-hashes", "", "由 Wrangler 兼容构建阶段生成的 asset upload hash JSON")
	buildMetadataPath := flags.String("build-metadata", "", "canonical artifact 构建 metadata JSON")
	applicationVersion := flags.String("app-version", "", "应用版本")
	sourceCommit := flags.String("source-commit", "", "源码 commit SHA")
	compatibilityDate := flags.String("compatibility-date", "", "Cloudflare compatibility date")
	mainModule := flags.String("main-module", "worker.js", "multipart metadata 中的 main_module")
	migrationTag := flags.String("migration-tag", "", "Durable Objects migration tag")
	migrationClasses := flags.String("migration-classes", "", "逗号分隔的 new SQLite classes")
	r2Binding := flags.String("r2-binding", "BUCKET", "R2 binding 名称")
	durableObjectBindings := flags.String("durable-object-bindings", "ADMIN_LOGIN_RATE_LIMITER=AdminLoginRateLimiter,ADMIN_SESSION_STORE=AdminSessionStore,PUBLIC_ACCESS_RATE_LIMITER=PublicAccessRateLimiter,ADMIN_LOGIN_SOURCE_RATE_LIMITER=AdminLoginSourceRateLimiter,TRANSFER_STORE=TransferStore,TRANSFER_REGISTRY=TransferRegistry", "逗号分隔的 binding=class")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *artifactRoot == "" {
		return fmt.Errorf("必须提供 --artifact-root")
	}
	root := filepath.Clean(*artifactRoot)
	if *workerFile == "" {
		*workerFile = filepath.Join(root, "worker.js")
	}
	if *assetsDirectory == "" {
		*assetsDirectory = filepath.Join(root, "assets")
	}
	if *output == "" {
		*output = filepath.Join(root, "manifest.json")
	}
	if *uploadHashesPath == "" {
		*uploadHashesPath = filepath.Join(root, "upload-hashes.json")
	}
	compatibilityFlags := []string{}
	if *buildMetadataPath != "" {
		metadata, err := loadBuildMetadata(*buildMetadataPath)
		if err != nil {
			return err
		}
		if *applicationVersion == "" {
			*applicationVersion = metadata.ApplicationVersion
		}
		if *sourceCommit == "" {
			*sourceCommit = metadata.SourceCommit
		}
		if *compatibilityDate == "" {
			*compatibilityDate = metadata.CompatibilityDate
		}
		compatibilityFlags = append([]string{}, metadata.CompatibilityFlags...)
		if metadata.MainModule != "" && *mainModule == "worker.js" {
			*mainModule = metadata.MainModule
		}
		if *migrationTag == "" {
			*migrationTag = metadata.MigrationTag
		}
		if *migrationClasses == "" {
			*migrationClasses = strings.Join(metadata.MigrationClasses, ",")
		}
	}
	uploadHashes, err := loadUploadHashes(*uploadHashesPath)
	if err != nil {
		return err
	}
	classes := splitNonEmpty(*migrationClasses)
	bindings, err := parseBindings(*r2Binding, *durableObjectBindings)
	if err != nil {
		return err
	}
	manifest, err := artifact.Build(artifact.BuildOptions{
		ArtifactRoot:       *artifactRoot,
		WorkerFile:         *workerFile,
		AssetsDirectory:    *assetsDirectory,
		ApplicationVersion: *applicationVersion,
		SourceCommit:       *sourceCommit,
		CompatibilityDate:  *compatibilityDate,
		CompatibilityFlags: compatibilityFlags,
		MainModule:         *mainModule,
		Bindings:           bindings,
		Migration: artifact.Migration{
			Tag:              *migrationTag,
			NewSQLiteClasses: classes,
		},
		UploadHashes: uploadHashes,
		SecretNames: []string{
			"ADMIN_PASSWORD",
			"ADMIN_SESSION_SECRET",
			"ADMIN_USERNAME",
			"CLOUDBOX_R2_ADMIN_PATH",
			"PUBLIC_ACCESS_PASSWORD_PEPPER",
			"PUBLIC_ACCESS_SESSION_SECRET",
			"TRANSFER_SESSION_SECRET",
		},
	})
	if err != nil {
		return err
	}
	if err := artifact.Write(*output, manifest); err != nil {
		return err
	}
	fmt.Printf("artifact manifest 已写入：%s\n", *output)
	return nil
}

func validateArtifact(args []string) error {
	flags := flag.NewFlagSet("validate-artifact", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	manifestPath := flags.String("manifest", "", "artifact manifest 路径")
	root := flags.String("root", "", "artifact 文件根目录")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *manifestPath == "" || *root == "" {
		return fmt.Errorf("必须提供 --manifest 和 --root")
	}
	manifest, err := artifact.Load(*manifestPath)
	if err != nil {
		return err
	}
	if err := artifact.VerifyFiles(filepath.Clean(*root), manifest); err != nil {
		return err
	}
	fmt.Printf("artifact 校验通过：%s\n", *manifestPath)
	return nil
}

func loadBuildMetadata(path string) (buildMetadata, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return buildMetadata{}, fmt.Errorf("读取 build metadata 失败：%w", err)
	}
	var metadata buildMetadata
	if err := json.Unmarshal(data, &metadata); err != nil {
		return buildMetadata{}, fmt.Errorf("解析 build metadata 失败：%w", err)
	}
	return metadata, nil
}

func loadUploadHashes(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取 upload hash manifest 失败：%w", err)
	}
	var hashes map[string]string
	if err := json.Unmarshal(data, &hashes); err != nil {
		return nil, fmt.Errorf("解析 upload hash manifest 失败：%w", err)
	}
	return hashes, nil
}

func parseBindings(r2Binding, durableObjectBindings string) ([]artifact.Binding, error) {
	if r2Binding == "" {
		return nil, fmt.Errorf("R2 binding 不能为空")
	}
	bindings := []artifact.Binding{{Name: "ASSETS", Type: "assets"}, {Name: r2Binding, Type: "r2_bucket"}}
	for _, item := range splitNonEmpty(durableObjectBindings) {
		parts := strings.SplitN(item, "=", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return nil, fmt.Errorf("Durable Object binding 格式无效：%s", item)
		}
		bindings = append(bindings, artifact.Binding{Name: parts[0], Type: "durable_object_namespace", ClassName: parts[1]})
	}
	return bindings, nil
}

func splitNonEmpty(value string) []string {
	var values []string
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item != "" {
			values = append(values, item)
		}
	}
	return values
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "cloudbox-artifact: %s\n", err)
	os.Exit(1)
}
