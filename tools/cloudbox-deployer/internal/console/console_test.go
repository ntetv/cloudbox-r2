package console

import (
	"strings"
	"testing"
)

func TestPromptDeploymentInputUsesDefaultsAndVisibleWarning(t *testing.T) {
	input := strings.NewReader(strings.Join([]string{
		"token",
		"0123456789abcdef0123456789abcdef",
		"",
		"",
		"admin1",
		"user",
		"password",
		"password",
	}, "\n") + "\n")
	var output strings.Builder
	deployment, err := PromptDeploymentInput(input, &output)
	if err != nil {
		t.Fatalf("PromptDeploymentInput() error = %v", err)
	}
	if deployment.WorkerName != "cloudbox-r2" || deployment.BucketName != "cloudbox-r2" {
		t.Fatalf("defaults = %#v", deployment)
	}
	if !strings.Contains(output.String(), "API Token") || !strings.Contains(output.String(), "安全提示") {
		t.Fatalf("visible warning missing: %q", output.String())
	}
	if strings.Contains(output.String(), "token") || strings.Contains(output.String(), "password") {
		t.Fatalf("prompt output leaked sensitive values: %q", output.String())
	}
}

func TestPromptDeploymentInputRejectsPasswordMismatch(t *testing.T) {
	input := strings.NewReader(strings.Join([]string{
		"token",
		"0123456789abcdef0123456789abcdef",
		"worker",
		"bucket",
		"admin1",
		"user",
		"password",
		"different",
	}, "\n") + "\n")
	var output strings.Builder
	if _, err := PromptDeploymentInput(input, &output); err == nil {
		t.Fatal("PromptDeploymentInput() accepted mismatched passwords")
	}
}

func TestConfirmAcceptsYesOnly(t *testing.T) {
	confirmed, err := Confirm(&strings.Builder{}, strings.NewReader("yes\n"))
	if err != nil || !confirmed {
		t.Fatalf("Confirm(yes) = %t, error = %v", confirmed, err)
	}
	confirmed, err = Confirm(&strings.Builder{}, strings.NewReader("no\n"))
	if err != nil || confirmed {
		t.Fatalf("Confirm(no) = %t, error = %v", confirmed, err)
	}
}
