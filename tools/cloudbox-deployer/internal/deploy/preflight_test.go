package deploy

import (
	"context"
	"testing"

	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/artifact"
	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/config"
)

type fakeRemote struct {
	workerExists bool
	bucketExists bool
}

func (remote fakeRemote) WorkerExists(context.Context, string) (bool, error) {
	return remote.workerExists, nil
}

func (remote fakeRemote) BucketExists(context.Context, string) (bool, error) {
	return remote.bucketExists, nil
}

func TestCheckRemoteRejectsExistingResource(t *testing.T) {
	result, err := CheckRemote(context.Background(), fakeRemote{bucketExists: true}, "worker", "bucket")
	if err == nil {
		t.Fatal("CheckRemote() returned nil error")
	}
	if !result.BucketExists || result.WorkerExists {
		t.Fatalf("result = %#v", result)
	}
}

func TestCheckRemoteAcceptsMissingResources(t *testing.T) {
	result, err := CheckRemote(context.Background(), fakeRemote{}, "worker", "bucket")
	if err != nil {
		t.Fatalf("CheckRemote() error = %v", err)
	}
	if result.WorkerExists || result.BucketExists {
		t.Fatalf("result = %#v", result)
	}
}

func TestValidateLocalRejectsInvalidManifest(t *testing.T) {
	err := ValidateLocal(
		DeploymentInputForTest(),
		artifact.Manifest{},
		t.TempDir(),
	)
	if err == nil {
		t.Fatal("ValidateLocal() accepted invalid manifest")
	}
}

func DeploymentInputForTest() config.DeploymentInput {
	return config.DeploymentInput{
		APIToken:   "token",
		AccountID:  "0123456789abcdef0123456789abcdef",
		WorkerName: "worker",
		BucketName: "bucket",
		AdminPath:  "admin1",
		Username:   "user",
		Password:   "password",
	}
}
