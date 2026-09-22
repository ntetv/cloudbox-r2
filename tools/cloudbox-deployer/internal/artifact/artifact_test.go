package artifact

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBuildAndVerifyManifest(t *testing.T) {
	root := t.TempDir()
	assetsRoot := filepath.Join(root, "assets")
	if err := os.Mkdir(assetsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	workerPath := filepath.Join(root, "worker.js")
	if err := os.WriteFile(workerPath, []byte("export default { fetch() { return new Response('ok') } };\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(assetsRoot, "index.html"), []byte("<html>cloudbox-r2</html>\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(assetsRoot, "app.js"), []byte("console.log('ok');\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	manifest, err := Build(BuildOptions{
		ArtifactRoot:       root,
		WorkerFile:         workerPath,
		AssetsDirectory:    assetsRoot,
		ApplicationVersion: "1.0.0-test",
		SourceCommit:       "abc123",
		CompatibilityDate:  "2024-11-06",
		MainModule:         "worker.js",
		Bindings: []Binding{
			{Name: "ASSETS", Type: "assets"},
			{Name: "BUCKET", Type: "r2_bucket"},
			{Name: "STORE", Type: "durable_object_namespace", ClassName: "Store"},
		},
		Migration: Migration{
			Tag:              "v1-cloudbox-r2",
			NewSQLiteClasses: []string{"AdminSessionStore"},
		},
		SecretNames: requiredSecretNames,
		UploadHashes: map[string]string{
			"/app.js":     "11111111111111111111111111111111",
			"/index.html": "22222222222222222222222222222222",
		},
	})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if err := Validate(manifest); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if manifest.Worker.Path != "worker.js" {
		t.Fatalf("Worker.Path = %q, want worker.js", manifest.Worker.Path)
	}
	if manifest.AssetsDirectory != "assets" {
		t.Fatalf("AssetsDirectory = %q, want assets", manifest.AssetsDirectory)
	}
	if len(manifest.Assets) != 2 {
		t.Fatalf("len(Assets) = %d, want 2", len(manifest.Assets))
	}
	if err := VerifyFiles(root, manifest); err != nil {
		t.Fatalf("VerifyFiles() error = %v", err)
	}

	if err := os.WriteFile(filepath.Join(assetsRoot, "index.html"), []byte("tampered\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyFiles(root, manifest); err == nil {
		t.Fatal("VerifyFiles() accepted tampered asset")
	}
}

func TestValidateRejectsTraversalAsset(t *testing.T) {
	manifest := Manifest{
		FormatVersion:      CurrentFormatVersion,
		ApplicationVersion: "1.0.0",
		AssetsDirectory:    "assets",
		Worker: Worker{
			Path:       "worker.js",
			SHA256:     "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			Size:       1,
			MainModule: "worker.js",
			MIMEType:   "application/javascript+module",
		},
		Assets: []Asset{{
			Path:        "/../secret",
			SHA256:      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			Size:        1,
			ContentType: "text/plain",
		}},
		CompatibilityDate: "2024-11-06",
		Bindings: []Binding{
			{Name: "ASSETS", Type: "assets"},
			{Name: "BUCKET", Type: "r2_bucket"},
			{Name: "STORE", Type: "durable_object_namespace", ClassName: "Store"},
		},
		SecretNames: requiredSecretNames,
		Migration:   Migration{Tag: "v1", NewSQLiteClasses: []string{"Store"}},
	}
	if err := Validate(manifest); err == nil {
		t.Fatal("Validate() accepted traversal asset")
	}
}

func TestBuildRejectsWorkerOutsideArtifactRoot(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "worker.js")
	if err := os.WriteFile(outside, []byte("worker"), 0o600); err != nil {
		t.Fatal(err)
	}
	assets := filepath.Join(root, "assets")
	if err := os.Mkdir(assets, 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := Build(BuildOptions{
		ArtifactRoot:       root,
		WorkerFile:         outside,
		AssetsDirectory:    assets,
		ApplicationVersion: "1.0.0",
		CompatibilityDate:  "2024-11-06",
		Migration:          Migration{Tag: "v1", NewSQLiteClasses: []string{"Store"}},
	})
	if err == nil {
		t.Fatal("Build() accepted Worker outside artifact root")
	}
}
