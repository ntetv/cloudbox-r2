package artifact

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBuildRejectsAssetSymlink(t *testing.T) {
	root := t.TempDir()
	assets := filepath.Join(root, "assets")
	if err := os.Mkdir(assets, 0o755); err != nil {
		t.Fatal(err)
	}
	worker := filepath.Join(root, "worker.js")
	if err := os.WriteFile(worker, []byte("worker"), 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(assets, "target.txt")
	if err := os.WriteFile(target, []byte("target"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(assets, "link.txt")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	_, err := Build(BuildOptions{
		ArtifactRoot:       root,
		WorkerFile:         worker,
		AssetsDirectory:    assets,
		ApplicationVersion: "1.0.0",
		CompatibilityDate:  "2024-11-06",
		Migration:          Migration{Tag: "v1", NewSQLiteClasses: []string{"Store"}},
	})
	if err == nil {
		t.Fatal("Build() accepted Dashboard asset symlink")
	}
}
