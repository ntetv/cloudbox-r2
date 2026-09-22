package artifact

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const CurrentFormatVersion = 1

var requiredSecretNames = []string{
	"CLOUDBOX_R2_ADMIN_PATH",
	"ADMIN_USERNAME",
	"ADMIN_PASSWORD",
	"ADMIN_SESSION_SECRET",
	"PUBLIC_ACCESS_SESSION_SECRET",
	"PUBLIC_ACCESS_PASSWORD_PEPPER",
	"TRANSFER_SESSION_SECRET",
}

type Manifest struct {
	FormatVersion      int       `json:"formatVersion"`
	ApplicationVersion string    `json:"applicationVersion"`
	SourceCommit       string    `json:"sourceCommit,omitempty"`
	Worker             Worker    `json:"worker"`
	AssetsDirectory    string    `json:"assetsDirectory"`
	Assets             []Asset   `json:"assets"`
	CompatibilityDate  string    `json:"compatibilityDate"`
	CompatibilityFlags []string  `json:"compatibilityFlags"`
	Bindings           []Binding `json:"bindings"`
	Migration          Migration `json:"migration"`
	SecretNames        []string  `json:"secretNames"`
}

type Worker struct {
	Path       string `json:"path"`
	SHA256     string `json:"sha256"`
	Size       int64  `json:"size"`
	MainModule string `json:"mainModule"`
	MIMEType   string `json:"mimeType"`
}

type Asset struct {
	Path        string `json:"path"`
	SHA256      string `json:"sha256"`
	UploadHash  string `json:"uploadHash"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
}

type Binding struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	ClassName string `json:"className,omitempty"`
}

type Migration struct {
	Tag              string   `json:"tag"`
	NewSQLiteClasses []string `json:"newSqliteClasses"`
}

type BuildOptions struct {
	ArtifactRoot       string
	WorkerFile         string
	AssetsDirectory    string
	ApplicationVersion string
	SourceCommit       string
	CompatibilityDate  string
	CompatibilityFlags []string
	Bindings           []Binding
	Migration          Migration
	SecretNames        []string
	UploadHashes       map[string]string
	MainModule         string
}

func Build(options BuildOptions) (Manifest, error) {
	root, err := filepath.Abs(options.ArtifactRoot)
	if err != nil || options.ArtifactRoot == "" {
		return Manifest{}, errors.New("artifact root 无效")
	}
	workerPath, err := relativeWithin(root, options.WorkerFile)
	if err != nil {
		return Manifest{}, fmt.Errorf("Worker artifact 不在 artifact root 内：%w", err)
	}
	assetsDirectory, err := relativeWithin(root, options.AssetsDirectory)
	if err != nil {
		return Manifest{}, fmt.Errorf("Dashboard assets 不在 artifact root 内：%w", err)
	}
	worker, err := inspectWorker(options.WorkerFile, workerPath, options.MainModule)
	if err != nil {
		return Manifest{}, err
	}
	assets, err := inspectAssets(options.AssetsDirectory, options.UploadHashes)
	if err != nil {
		return Manifest{}, err
	}
	if options.ApplicationVersion == "" {
		return Manifest{}, errors.New("application version 不能为空")
	}
	if options.CompatibilityDate == "" {
		return Manifest{}, errors.New("compatibility date 不能为空")
	}
	if options.Migration.Tag == "" || len(options.Migration.NewSQLiteClasses) == 0 {
		return Manifest{}, errors.New("Durable Objects migration 不完整")
	}
	secretNames := append([]string(nil), options.SecretNames...)
	sort.Strings(secretNames)
	return Manifest{
		FormatVersion:      CurrentFormatVersion,
		ApplicationVersion: options.ApplicationVersion,
		SourceCommit:       options.SourceCommit,
		Worker:             worker,
		AssetsDirectory:    filepath.ToSlash(assetsDirectory),
		Assets:             assets,
		CompatibilityDate:  options.CompatibilityDate,
		CompatibilityFlags: append([]string{}, options.CompatibilityFlags...),
		Bindings:           append([]Binding(nil), options.Bindings...),
		Migration:          options.Migration,
		SecretNames:        secretNames,
	}, nil
}

func Write(path string, manifest Manifest) error {
	if err := Validate(manifest); err != nil {
		return err
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化 artifact manifest 失败：%w", err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("写入 artifact manifest 失败：%w", err)
	}
	return nil
}

func Load(path string) (Manifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Manifest{}, fmt.Errorf("读取 artifact manifest 失败：%w", err)
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("解析 artifact manifest 失败：%w", err)
	}
	if err := Validate(manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func Validate(manifest Manifest) error {
	if manifest.FormatVersion != CurrentFormatVersion {
		return fmt.Errorf("不支持的 artifact manifest 版本：%d", manifest.FormatVersion)
	}
	if manifest.ApplicationVersion == "" {
		return errors.New("artifact applicationVersion 不能为空")
	}
	if err := validateDigest(manifest.Worker.SHA256); err != nil {
		return fmt.Errorf("Worker artifact SHA-256 无效：%w", err)
	}
	if err := validateRelativePath(manifest.Worker.Path); err != nil {
		return fmt.Errorf("Worker artifact 路径无效：%w", err)
	}
	if err := validateRelativePath(manifest.AssetsDirectory); err != nil {
		return fmt.Errorf("Dashboard assets 目录无效：%w", err)
	}
	if manifest.Worker.Size <= 0 {
		return errors.New("Worker artifact 大小无效")
	}
	if manifest.Worker.MainModule == "" || manifest.Worker.MIMEType == "" {
		return errors.New("Worker artifact metadata 不完整")
	}
	if manifest.CompatibilityDate == "" {
		return errors.New("compatibilityDate 不能为空")
	}
	if manifest.Migration.Tag == "" || len(manifest.Migration.NewSQLiteClasses) == 0 {
		return errors.New("Durable Objects migration 不完整")
	}
	if len(manifest.Bindings) == 0 {
		return errors.New("Worker bindings 不能为空")
	}
	bindingNames := make(map[string]struct{}, len(manifest.Bindings))
	for _, binding := range manifest.Bindings {
		if binding.Name == "" || binding.Type == "" {
			return errors.New("Worker binding metadata 不完整")
		}
		if _, exists := bindingNames[binding.Name]; exists {
			return fmt.Errorf("Worker binding 名称重复：%s", binding.Name)
		}
		bindingNames[binding.Name] = struct{}{}
		if binding.Type == "durable_object_namespace" && binding.ClassName == "" {
			return fmt.Errorf("Durable Object binding 缺少 class name：%s", binding.Name)
		}
	}
	secretNames := make(map[string]struct{}, len(manifest.SecretNames))
	for _, name := range manifest.SecretNames {
		if _, exists := secretNames[name]; exists {
			return fmt.Errorf("secret 名称重复：%s", name)
		}
		secretNames[name] = struct{}{}
	}
	if len(secretNames) != len(requiredSecretNames) {
		return errors.New("artifact 必须声明七项 Worker secrets")
	}
	for _, name := range requiredSecretNames {
		if _, exists := secretNames[name]; !exists {
			return fmt.Errorf("artifact 缺少 Worker secret：%s", name)
		}
	}
	seen := make(map[string]struct{}, len(manifest.Assets))
	for _, asset := range manifest.Assets {
		if err := validateAssetPath(asset.Path); err != nil {
			return err
		}
		if _, exists := seen[asset.Path]; exists {
			return fmt.Errorf("Dashboard asset 路径重复：%s", asset.Path)
		}
		seen[asset.Path] = struct{}{}
		if err := validateDigest(asset.SHA256); err != nil {
			return fmt.Errorf("Dashboard asset %s SHA-256 无效：%w", asset.Path, err)
		}
		if err := validateUploadHash(asset.UploadHash); err != nil {
			return fmt.Errorf("Dashboard asset %s upload hash 无效：%w", asset.Path, err)
		}
		if asset.Size < 0 || asset.ContentType == "" {
			return fmt.Errorf("Dashboard asset metadata 无效：%s", asset.Path)
		}
	}
	return nil
}

func VerifyFiles(root string, manifest Manifest) error {
	if err := Validate(manifest); err != nil {
		return err
	}
	if err := ordinaryDirectory(root); err != nil {
		return fmt.Errorf("artifact root 校验失败：%w", err)
	}
	if err := verifyFile(root, manifest.Worker.Path, manifest.Worker.SHA256, manifest.Worker.Size); err != nil {
		return fmt.Errorf("Worker artifact 校验失败：%w", err)
	}
	assetsRoot := filepath.Join(root, filepath.FromSlash(manifest.AssetsDirectory))
	if err := ordinaryDirectory(assetsRoot); err != nil {
		return fmt.Errorf("Dashboard assets root 校验失败：%w", err)
	}
	for _, asset := range manifest.Assets {
		if err := verifyFile(assetsRoot, asset.Path, asset.SHA256, asset.Size); err != nil {
			return fmt.Errorf("Dashboard asset %s 校验失败：%w", asset.Path, err)
		}
	}
	return nil
}

func inspectWorker(path, relativePath, mainModule string) (Worker, error) {
	info, err := ordinaryFile(path)
	if err != nil {
		return Worker{}, fmt.Errorf("Worker artifact 无效：%w", err)
	}
	digest, err := fileSHA256(path)
	if err != nil {
		return Worker{}, err
	}
	if mainModule == "" {
		mainModule = "worker.js"
	}
	return Worker{
		Path:       filepath.ToSlash(relativePath),
		SHA256:     digest,
		Size:       info.Size(),
		MainModule: mainModule,
		MIMEType:   "application/javascript+module",
	}, nil
}

func inspectAssets(root string, uploadHashes map[string]string) ([]Asset, error) {
	if root == "" {
		return nil, errors.New("Dashboard assets 目录不能为空")
	}
	info, err := os.Lstat(root)
	if err != nil {
		return nil, fmt.Errorf("读取 Dashboard assets 目录失败：%w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, errors.New("Dashboard assets 目录必须是普通目录")
	}
	var assets []Asset
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("Dashboard assets 不允许 symlink：%s", path)
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		assetPath, err := normalizeAssetPath(relative)
		if err != nil {
			return err
		}
		uploadHash := uploadHashes[assetPath]
		if err := validateUploadHash(uploadHash); err != nil {
			return fmt.Errorf("Dashboard asset %s 缺少受信任的 Wrangler upload hash：%w", assetPath, err)
		}
		digest, err := fileSHA256(path)
		if err != nil {
			return err
		}
		contentType := mime.TypeByExtension(filepath.Ext(path))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		if strings.HasPrefix(contentType, "text/") && !strings.Contains(contentType, "charset=") {
			contentType += "; charset=utf-8"
		}
		assets = append(assets, Asset{
			Path:        assetPath,
			SHA256:      digest,
			UploadHash:  uploadHash,
			Size:        info.Size(),
			ContentType: contentType,
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("扫描 Dashboard assets 失败：%w", err)
	}
	sort.Slice(assets, func(i, j int) bool { return assets[i].Path < assets[j].Path })
	return assets, nil
}

func verifyFile(root, relativePath, expectedDigest string, expectedSize int64) error {
	relativePath = strings.TrimPrefix(relativePath, "/")
	if filepath.IsAbs(filepath.FromSlash(relativePath)) {
		return errors.New("artifact 路径不能是绝对路径")
	}
	path := filepath.Join(root, filepath.FromSlash(relativePath))
	info, err := ordinaryFile(path)
	if err != nil {
		return err
	}
	if info.Size() != expectedSize {
		return fmt.Errorf("大小不匹配：期望 %d，实际 %d", expectedSize, info.Size())
	}
	digest, err := fileSHA256(path)
	if err != nil {
		return err
	}
	if digest != expectedDigest {
		return fmt.Errorf("SHA-256 不匹配：期望 %s，实际 %s", expectedDigest, digest)
	}
	return nil
}

func ordinaryDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("不是普通目录：%s", path)
	}
	return nil
}

func ordinaryFile(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("不是普通文件：%s", path)
	}
	return info, nil
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("读取文件失败：%w", err)
	}
	defer file.Close()
	hash := sha256.New()
	buffer := make([]byte, 64*1024)
	for {
		read, err := file.Read(buffer)
		if read > 0 {
			_, _ = hash.Write(buffer[:read])
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return "", fmt.Errorf("计算 SHA-256 失败：%w", err)
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func validateDigest(value string) error {
	if len(value) != sha256.Size*2 {
		return errors.New("必须是 64 位十六进制字符串")
	}
	if _, err := hex.DecodeString(value); err != nil {
		return errors.New("必须是 64 位十六进制字符串")
	}
	return nil
}

func validateUploadHash(value string) error {
	if len(value) != 32 {
		return errors.New("必须是 Wrangler BLAKE3 截断 hash（32 位十六进制字符串）")
	}
	if _, err := hex.DecodeString(value); err != nil {
		return errors.New("必须是 Wrangler BLAKE3 截断 hash（32 位十六进制字符串）")
	}
	return nil
}

func normalizeAssetPath(value string) (string, error) {
	value = filepath.ToSlash(value)
	if value == "" || value == "." || strings.HasPrefix(value, "/") {
		return "", errors.New("Dashboard asset 路径无效")
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(value)))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(clean, ":") {
		return "", fmt.Errorf("Dashboard asset 路径越界：%s", value)
	}
	return "/" + clean, nil
}

func validateAssetPath(value string) error {
	if value == "" || !strings.HasPrefix(value, "/") || strings.Contains(value, "\\") {
		return fmt.Errorf("Dashboard asset 路径无效：%s", value)
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(value)))
	if clean != value || clean == "/" || strings.HasPrefix(clean, "/../") || strings.Contains(clean, ":") {
		return fmt.Errorf("Dashboard asset 路径越界：%s", value)
	}
	return nil
}

func validateRelativePath(value string) error {
	if value == "" || strings.Contains(value, "\\") || strings.Contains(value, ":") {
		return errors.New("必须是非空的跨平台相对路径")
	}
	if filepath.IsAbs(filepath.FromSlash(value)) {
		return errors.New("不能是绝对路径")
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(value)))
	if clean != value || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return errors.New("路径越出 artifact root")
	}
	return nil
}

func relativeWithin(root, target string) (string, error) {
	if root == "" || target == "" {
		return "", errors.New("路径不能为空")
	}
	resolvedRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	resolvedTarget, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(resolvedRoot, resolvedTarget)
	if err != nil {
		return "", err
	}
	if relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", errors.New("路径越出 root")
	}
	return relative, nil
}
