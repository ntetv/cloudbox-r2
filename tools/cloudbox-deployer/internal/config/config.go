package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
)

var (
	namePattern      = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	adminPathPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{5,12}$`)
	accountIDPattern = regexp.MustCompile(`^[a-fA-F0-9]{32}$`)
)

var SecretNames = []string{
	"CLOUDBOX_R2_ADMIN_PATH",
	"ADMIN_USERNAME",
	"ADMIN_PASSWORD",
	"ADMIN_SESSION_SECRET",
	"PUBLIC_ACCESS_SESSION_SECRET",
	"PUBLIC_ACCESS_PASSWORD_PEPPER",
	"TRANSFER_SESSION_SECRET",
}

type DeploymentInput struct {
	APIToken   string
	AccountID  string
	WorkerName string
	BucketName string
	AdminPath  string
	Username   string
	Password   string
}

func ValidateAPIToken(value string) error {
	if value == "" || regexp.MustCompile(`\s`).MatchString(value) {
		return errors.New("Cloudflare API Token 格式无效")
	}
	if len([]byte(value)) > 512 {
		return errors.New("Cloudflare API Token 超过 512 字节")
	}
	return nil
}

func ValidateAccountID(value string) error {
	if !accountIDPattern.MatchString(value) {
		return errors.New("Cloudflare 账号 ID 必须是 32 位十六进制字符串")
	}
	return nil
}

func ValidateWorkerName(value string) error {
	if !namePattern.MatchString(value) {
		return errors.New("Worker 名称格式无效")
	}
	return nil
}

func ValidateBucketName(value string) error {
	if !namePattern.MatchString(value) || len(value) < 3 {
		return errors.New("R2 bucket 名称格式无效")
	}
	return nil
}

func ValidateAdminPath(value string) error {
	if !adminPathPattern.MatchString(value) {
		return errors.New("管理入口必须是 5–12 个 ASCII 字符")
	}
	return nil
}

func ValidateUsername(value string) error {
	if len([]byte(value)) == 0 || len([]byte(value)) > 256 {
		return errors.New("管理员用户名不能为空且最多 256 UTF-8 字节")
	}
	return nil
}

func ValidatePassword(value, username string) error {
	length := len([]byte(value))
	if length < 6 || length > 16 || value == username {
		return errors.New("管理员密码需 6–16 UTF-8 字节且不能等于用户名")
	}
	return nil
}

func ValidateInput(input DeploymentInput) error {
	checks := []struct {
		name  string
		value string
		check func(string) error
	}{
		{"API Token", input.APIToken, ValidateAPIToken},
		{"Cloudflare 账号 ID", input.AccountID, ValidateAccountID},
		{"Worker 名称", input.WorkerName, ValidateWorkerName},
		{"R2 bucket 名称", input.BucketName, ValidateBucketName},
		{"管理入口", input.AdminPath, ValidateAdminPath},
		{"管理员用户名", input.Username, ValidateUsername},
	}
	for _, item := range checks {
		if err := item.check(item.value); err != nil {
			return fmt.Errorf("%s：%w", item.name, err)
		}
	}
	return ValidatePassword(input.Password, input.Username)
}

func GenerateSecrets(input DeploymentInput) (map[string]string, error) {
	if err := ValidateInput(input); err != nil {
		return nil, err
	}
	secrets := map[string]string{
		"CLOUDBOX_R2_ADMIN_PATH": input.AdminPath,
		"ADMIN_USERNAME":         input.Username,
		"ADMIN_PASSWORD":         input.Password,
	}
	for _, name := range SecretNames[3:] {
		value, err := randomSecret()
		if err != nil {
			return nil, fmt.Errorf("生成 %s 失败：%w", name, err)
		}
		secrets[name] = value
	}
	seen := map[string]struct{}{
		input.Username: {},
		input.Password: {},
	}
	for _, name := range SecretNames[3:] {
		value := secrets[name]
		if _, exists := seen[value]; exists {
			return nil, errors.New("生成的 secrets 存在重复值")
		}
		seen[value] = struct{}{}
	}
	return secrets, nil
}

func randomSecret() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}
