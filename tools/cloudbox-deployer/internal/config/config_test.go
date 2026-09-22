package config

import (
	"strings"
	"testing"
)

func validInput() DeploymentInput {
	return DeploymentInput{
		APIToken:   "token-value",
		AccountID:  "0123456789abcdef0123456789abcdef",
		WorkerName: "cloudbox-r2-test",
		BucketName: "cloudbox-r2-test",
		AdminPath:  "admin_1",
		Username:   "administrator",
		Password:   "safe-pass",
	}
}

func TestValidateInputAcceptsValidValues(t *testing.T) {
	if err := ValidateInput(validInput()); err != nil {
		t.Fatalf("ValidateInput() error = %v", err)
	}
}

func TestValidateInputRejectsInvalidValues(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*DeploymentInput)
	}{
		{"account ID", func(input *DeploymentInput) { input.AccountID = "bad" }},
		{"worker name", func(input *DeploymentInput) { input.WorkerName = "Cloudbox" }},
		{"bucket name", func(input *DeploymentInput) { input.BucketName = "ab" }},
		{"admin path", func(input *DeploymentInput) { input.AdminPath = "admin/path" }},
		{"username", func(input *DeploymentInput) { input.Username = "" }},
		{"password", func(input *DeploymentInput) { input.Password = "short" }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			input := validInput()
			test.mutate(&input)
			if err := ValidateInput(input); err == nil {
				t.Fatal("ValidateInput() unexpectedly accepted invalid input")
			}
		})
	}
}

func TestGenerateSecretsAllowsAdminPathToMatchCredentials(t *testing.T) {
	input := validInput()
	input.Username = "admin01"
	input.AdminPath = input.Username
	if _, err := GenerateSecrets(input); err != nil {
		t.Fatalf("GenerateSecrets() rejected matching admin path: %v", err)
	}
}

func TestGenerateSecretsReturnsSevenDistinctSecurityValues(t *testing.T) {
	secrets, err := GenerateSecrets(validInput())
	if err != nil {
		t.Fatalf("GenerateSecrets() error = %v", err)
	}
	if len(secrets) != len(SecretNames) {
		t.Fatalf("GenerateSecrets() returned %d values, want %d", len(secrets), len(SecretNames))
	}
	seen := map[string]bool{}
	for _, name := range SecretNames {
		value, ok := secrets[name]
		if !ok || value == "" {
			t.Fatalf("missing secret %q", name)
		}
		if seen[value] {
			t.Fatalf("duplicate secret value for %q", name)
		}
		seen[value] = true
	}
	for _, name := range SecretNames[3:] {
		if len(secrets[name]) != 64 || strings.Trim(secrets[name], "0123456789abcdef") != "" {
			t.Fatalf("generated secret %q is not lowercase hex", name)
		}
	}
}
