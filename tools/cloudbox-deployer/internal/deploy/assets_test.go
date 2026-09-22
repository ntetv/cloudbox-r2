package deploy

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/artifact"
	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/cloudflare"
)

type batchUploadAPI struct {
	workflowFakeAPI
	buckets   [][]string
	calls     int
	failCall  int
	emptyCall int
}

func (api *batchUploadAPI) StartAssetsUploadSession(context.Context, string, map[string]cloudflare.AssetManifestEntry) (cloudflare.AssetsUploadSession, error) {
	return cloudflare.AssetsUploadSession{Buckets: api.buckets, JWT: "session-jwt"}, nil
}

func (api *batchUploadAPI) UploadAssetBucket(_ context.Context, jwt string, assets []cloudflare.AssetUpload) (string, error) {
	api.calls++
	if jwt != "session-jwt" {
		return "", io.ErrUnexpectedEOF
	}
	if api.failCall == api.calls {
		return "", io.ErrUnexpectedEOF
	}
	for _, asset := range assets {
		api.uploaded = append(api.uploaded, asset.Hash)
	}
	if api.emptyCall == api.calls {
		return "", nil
	}
	return "completion-jwt", nil
}

func TestUploadAssetsSupportsMultipleBatches(t *testing.T) {
	root := t.TempDir()
	assetsRoot := filepath.Join(root, "assets")
	if err := os.Mkdir(assetsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{"one.txt": "one", "two.txt": "two"}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(assetsRoot, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// This test only exercises batch orchestration; hashes are fixed independent test values.
	manifest := artifact.Manifest{
		AssetsDirectory: "assets",
		Assets: []artifact.Asset{
			{Path: "/one.txt", UploadHash: "11111111111111111111111111111111", Size: 3, ContentType: "text/plain"},
			{Path: "/two.txt", UploadHash: "22222222222222222222222222222222", Size: 3, ContentType: "text/plain"},
		},
	}
	api := &batchUploadAPI{buckets: [][]string{{manifest.Assets[0].UploadHash}, {manifest.Assets[1].UploadHash}}}
	jwt, err := uploadAssets(context.Background(), api, root, manifest, "worker")
	if err != nil {
		t.Fatalf("uploadAssets() error = %v", err)
	}
	if jwt != "completion-jwt" || api.calls != 2 || len(api.uploaded) != 2 {
		t.Fatalf("jwt=%q calls=%d uploaded=%#v", jwt, api.calls, api.uploaded)
	}
}

func TestUploadAssetsKeepsEarlierCompletionJWT(t *testing.T) {
	root := t.TempDir()
	assetsRoot := filepath.Join(root, "assets")
	if err := os.Mkdir(assetsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"one.txt": "one", "two.txt": "two"} {
		if err := os.WriteFile(filepath.Join(assetsRoot, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	manifest := artifact.Manifest{
		AssetsDirectory: "assets",
		Assets: []artifact.Asset{
			{Path: "/one.txt", UploadHash: "11111111111111111111111111111111", Size: 3, ContentType: "text/plain"},
			{Path: "/two.txt", UploadHash: "22222222222222222222222222222222", Size: 3, ContentType: "text/plain"},
		},
	}
	api := &batchUploadAPI{
		buckets:   [][]string{{manifest.Assets[0].UploadHash}, {manifest.Assets[1].UploadHash}},
		emptyCall: 2,
	}
	jwt, err := uploadAssets(context.Background(), api, root, manifest, "worker")
	if err != nil || jwt != "completion-jwt" || api.calls != 2 {
		t.Fatalf("jwt=%q calls=%d error=%v", jwt, api.calls, err)
	}
}

func TestUploadAssetsStopsOnBatchFailure(t *testing.T) {
	root := t.TempDir()
	assetsRoot := filepath.Join(root, "assets")
	if err := os.Mkdir(assetsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(assetsRoot, "one.txt"), []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := artifact.Manifest{
		AssetsDirectory: "assets",
		Assets:          []artifact.Asset{{Path: "/one.txt", UploadHash: "11111111111111111111111111111111", Size: 3, ContentType: "text/plain"}},
	}
	api := &batchUploadAPI{buckets: [][]string{{manifest.Assets[0].UploadHash}}, failCall: 1}
	if _, err := uploadAssets(context.Background(), api, root, manifest, "worker"); err == nil {
		t.Fatal("uploadAssets() accepted failed batch")
	}
	if api.calls != 1 {
		t.Fatalf("calls=%d, want 1", api.calls)
	}
}
