package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/artifact"
	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/cloudflare"
	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/config"
)

type workflowFakeAPI struct {
	workerExists            bool
	bucketExists            bool
	created                 []string
	uploaded                []string
	metadata                []byte
	versionID               string
	deployed                bool
	createBucketErr         error
	bucketExistsAfterCreate bool
	deployErr               error
	deploymentConfirmed     bool
}

func (api *workflowFakeAPI) WorkerExists(context.Context, string) (bool, error) {
	return api.workerExists, nil
}

func (api *workflowFakeAPI) BucketExists(context.Context, string) (bool, error) {
	return api.bucketExists || (api.bucketExistsAfterCreate && strings.Contains(strings.Join(api.created, ","), "bucket")), nil
}

func (api *workflowFakeAPI) CreateBucket(context.Context, string) error {
	api.created = append(api.created, "bucket")
	return api.createBucketErr
}

func (api *workflowFakeAPI) StartAssetsUploadSession(_ context.Context, _ string, manifest map[string]cloudflare.AssetManifestEntry) (cloudflare.AssetsUploadSession, error) {
	api.created = append(api.created, "assets-session")
	for _, entry := range manifest {
		return cloudflare.AssetsUploadSession{Buckets: [][]string{{entry.Hash}}, JWT: "session-jwt"}, nil
	}
	return cloudflare.AssetsUploadSession{JWT: "session-jwt"}, nil
}

func (api *workflowFakeAPI) UploadAssetBucket(_ context.Context, jwt string, assets []cloudflare.AssetUpload) (string, error) {
	if jwt != "session-jwt" || len(assets) != 1 || string(assets[0].Content) != "<html>ok</html>\n" {
		return "", io.ErrUnexpectedEOF
	}
	api.uploaded = append(api.uploaded, assets[0].Hash)
	return "completion-jwt", nil
}

func (api *workflowFakeAPI) UploadWorker(_ context.Context, _ string, metadata []byte, _ string, _ string, worker io.Reader, _ int64) error {
	content, err := io.ReadAll(worker)
	if err != nil || string(content) != "export default 1;\n" {
		return io.ErrUnexpectedEOF
	}
	api.metadata = append([]byte(nil), metadata...)
	api.created = append(api.created, "migration")
	api.deployed = true
	return nil
}

func (api *workflowFakeAPI) PutSecret(_ context.Context, _ string, name, value string) error {
	if name == "" || value == "" {
		return errors.New("empty secret")
	}
	api.created = append(api.created, "secret:"+name)
	return nil
}

func (api *workflowFakeAPI) CreateWorkerVersion(_ context.Context, _ string, metadata []byte, _ string, _ string, worker io.Reader, _ int64) (cloudflare.WorkerVersion, error) {
	content, err := io.ReadAll(worker)
	if err != nil || string(content) != "export default 1;\n" {
		return cloudflare.WorkerVersion{}, io.ErrUnexpectedEOF
	}
	api.metadata = append([]byte(nil), metadata...)
	api.created = append(api.created, "version")
	return cloudflare.WorkerVersion{ID: "version-1"}, nil
}

func (api *workflowFakeAPI) DeployVersion(context.Context, string, string, string) error {
	api.deployed = true
	api.created = append(api.created, "deployment")
	return api.deployErr
}

func (api *workflowFakeAPI) DeploymentContainsVersion(context.Context, string, string) (bool, error) {
	return api.deploymentConfirmed, nil
}

func (api *workflowFakeAPI) EnableWorkerSubdomain(context.Context, string) (bool, error) {
	return true, nil
}

func (api *workflowFakeAPI) WorkersDevSubdomain(context.Context) (string, error) {
	return "example", nil
}

func TestRunWorkflowUsesFixedStagesAndDoesNotLogSecrets(t *testing.T) {
	root := t.TempDir()
	assets := filepath.Join(root, "assets")
	if err := os.Mkdir(assets, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "worker.js"), []byte("export default 1;\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(assets, "index.html"), []byte("<html>ok</html>\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest, err := artifact.Build(artifact.BuildOptions{
		ArtifactRoot:       root,
		WorkerFile:         filepath.Join(root, "worker.js"),
		AssetsDirectory:    assets,
		ApplicationVersion: "1.0.0-test",
		CompatibilityDate:  "2024-11-06",
		MainModule:         "worker.js",
		Bindings: []artifact.Binding{
			{Name: "ASSETS", Type: "assets"},
			{Name: "BUCKET", Type: "r2_bucket"},
			{Name: "STORE", Type: "durable_object_namespace", ClassName: "Store"},
		},
		Migration: artifact.Migration{
			Tag:              "v1-cloudbox-r2",
			NewSQLiteClasses: []string{"Store"},
		},
		SecretNames: config.SecretNames,
		UploadHashes: map[string]string{
			"/index.html": "33333333333333333333333333333333",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	input := config.DeploymentInput{
		APIToken:   "token",
		AccountID:  "0123456789abcdef0123456789abcdef",
		WorkerName: "worker",
		BucketName: "bucket",
		AdminPath:  "admin1",
		Username:   "user",
		Password:   "password",
	}
	secrets, err := config.GenerateSecrets(input)
	if err != nil {
		t.Fatal(err)
	}
	api := &workflowFakeAPI{}
	var stages []string
	result, err := Run(context.Background(), api, root, manifest, input, secrets, func(workerName, bucketName, version string) bool {
		return workerName == "worker" && bucketName == "bucket" && version == "1.0.0-test"
	}, func(stage string) {
		stages = append(stages, stage)
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != "deployed" || result.URL != "https://worker.example.workers.dev" {
		t.Fatalf("result = %#v", result)
	}
	if !api.deployed || !strings.Contains(strings.Join(api.created, ","), "bucket,assets-session,migration") || !strings.Contains(strings.Join(api.created, ","), "secret:") {
		t.Fatalf("created = %#v, deployed = %t", api.created, api.deployed)
	}
	if len(api.uploaded) != 1 || api.uploaded[0] != manifest.Assets[0].UploadHash {
		t.Fatalf("uploaded = %#v", api.uploaded)
	}
	var metadata map[string]any
	if err := json.Unmarshal(api.metadata, &metadata); err != nil {
		t.Fatal(err)
	}
	encodedMetadata := string(api.metadata)
	if strings.Contains(encodedMetadata, "ADMIN_USERNAME") || strings.Contains(encodedMetadata, "password") {
		t.Fatalf("metadata leaked secret values: %s", encodedMetadata)
	}
	if !strings.Contains(encodedMetadata, "completion-jwt") {
		t.Fatalf("metadata missing assets completion JWT")
	}
	if len(stages) < 4 {
		t.Fatalf("stages = %#v", stages)
	}
}

func newWorkflowFixture(t *testing.T) (string, artifact.Manifest, config.DeploymentInput, map[string]string) {
	t.Helper()
	root := t.TempDir()
	assets := filepath.Join(root, "assets")
	if err := os.Mkdir(assets, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "worker.js"), []byte("export default 1;\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(assets, "index.html"), []byte("<html>ok</html>\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest, err := artifact.Build(artifact.BuildOptions{
		ArtifactRoot:       root,
		WorkerFile:         filepath.Join(root, "worker.js"),
		AssetsDirectory:    assets,
		ApplicationVersion: "1.0.0-test",
		CompatibilityDate:  "2024-11-06",
		MainModule:         "worker.js",
		Bindings: []artifact.Binding{
			{Name: "ASSETS", Type: "assets"},
			{Name: "BUCKET", Type: "r2_bucket"},
			{Name: "STORE", Type: "durable_object_namespace", ClassName: "Store"},
		},
		Migration:   artifact.Migration{Tag: "v1-cloudbox-r2", NewSQLiteClasses: []string{"Store"}},
		SecretNames: config.SecretNames,
		UploadHashes: map[string]string{
			"/index.html": "33333333333333333333333333333333",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	input := config.DeploymentInput{
		APIToken: "token", AccountID: "0123456789abcdef0123456789abcdef",
		WorkerName: "worker", BucketName: "bucket", AdminPath: "admin1",
		Username: "user", Password: "password",
	}
	secrets, err := config.GenerateSecrets(input)
	if err != nil {
		t.Fatal(err)
	}
	return root, manifest, input, secrets
}

func TestRunResolvesUnknownBucketCreateByQuery(t *testing.T) {
	root, manifest, input, secrets := newWorkflowFixture(t)
	api := &workflowFakeAPI{
		createBucketErr:         context.DeadlineExceeded,
		bucketExistsAfterCreate: true,
	}
	result, err := Run(context.Background(), api, root, manifest, input, secrets, func(string, string, string) bool { return true }, nil)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != "deployed" || !api.deployed {
		t.Fatalf("result = %#v, deployed = %t", result, api.deployed)
	}
}

func TestRunMigrationUsesNonVersionedUpload(t *testing.T) {
	root, manifest, input, secrets := newWorkflowFixture(t)
	api := &workflowFakeAPI{}
	result, err := Run(context.Background(), api, root, manifest, input, secrets, func(string, string, string) bool { return true }, nil)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != "deployed" || result.VersionID != "" || !api.deployed {
		t.Fatalf("result = %#v deployed=%t", result, api.deployed)
	}
	created := strings.Join(api.created, ",")
	if !strings.HasPrefix(created, "bucket,assets-session,migration") || !strings.Contains(created, "secret:") {
		t.Fatalf("created = %#v", api.created)
	}
}

func TestCheckHomeAcceptsExpectedPage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte("<html>Cloudbox R2</html>"))
	}))
	defer server.Close()
	if err := CheckHome(context.Background(), server.URL+"/"); err != nil {
		t.Fatalf("CheckHome() error = %v", err)
	}
}

func TestCheckHomeReturnsWarningForMissingMarker(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte("<html>other</html>"))
	}))
	defer server.Close()
	if err := CheckHome(context.Background(), server.URL+"/"); err == nil {
		t.Fatal("CheckHome() accepted page without marker")
	}
}

func TestRunWithHomeCheckKeepsDeploymentOnWarning(t *testing.T) {
	root, manifest, input, secrets := newWorkflowFixture(t)
	api := &workflowFakeAPI{}
	result, err := RunWithHomeCheck(context.Background(), api, root, manifest, input, secrets, func(string, string, string) bool { return true }, nil, func(context.Context, string) error {
		return errors.New("首页验证未找到预期页面标记")
	})
	if err != nil {
		t.Fatalf("RunWithHomeCheck() error = %v", err)
	}
	if result.Status != "deployed" || result.HomeCheckError == "" {
		t.Fatalf("result = %#v", result)
	}
}

func TestRunWorkflowCancellationDoesNotWrite(t *testing.T) {
	api := &workflowFakeAPI{}
	result, err := Run(context.Background(), api, t.TempDir(), artifact.Manifest{}, config.DeploymentInput{}, nil, func(string, string, string) bool {
		return false
	}, nil)
	if err == nil {
		t.Fatal("Run() returned nil error for invalid local preflight")
	}
	if result.Status != "preflight_failed" || len(api.created) != 0 {
		t.Fatalf("result = %#v, created = %#v", result, api.created)
	}
}
