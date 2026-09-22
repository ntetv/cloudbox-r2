package console

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/ntetv/cloudbox-r2/tools/cloudbox-deployer/internal/config"
)

type Input struct {
	Reader io.Reader
	Writer io.Writer
	reader *bufio.Reader
}

func newInput(reader io.Reader, writer io.Writer) Input {
	buffered, ok := reader.(*bufio.Reader)
	if !ok {
		buffered = bufio.NewReader(reader)
	}
	return Input{Reader: reader, Writer: writer, reader: buffered}
}

func PromptDeploymentInput(reader io.Reader, writer io.Writer) (config.DeploymentInput, error) {
	if reader == nil || writer == nil {
		return config.DeploymentInput{}, errors.New("控制台输入输出不能为空")
	}
	input := newInput(reader, writer)
	fmt.Fprintln(writer, "安全提示：当前模式会在终端显示 API Token、管理入口和管理员密码；请勿在共享、录屏或审计终端执行。")
	apiToken, err := input.prompt("Cloudflare API Token：", "", config.ValidateAPIToken, "API Token 格式无效")
	if err != nil {
		return config.DeploymentInput{}, err
	}
	accountID, err := input.prompt("Cloudflare 账号 ID：", "", config.ValidateAccountID, "Cloudflare 账号 ID 格式无效")
	if err != nil {
		return config.DeploymentInput{}, err
	}
	workerName, err := input.prompt("新 Worker 名称（回车默认 cloudbox-r2）：", "cloudbox-r2", config.ValidateWorkerName, "Worker 名称格式无效")
	if err != nil {
		return config.DeploymentInput{}, err
	}
	bucketName, err := input.prompt("新 R2 bucket 名称（回车默认 cloudbox-r2）：", "cloudbox-r2", config.ValidateBucketName, "R2 bucket 名称格式无效")
	if err != nil {
		return config.DeploymentInput{}, err
	}
	adminPath, err := input.prompt("管理入口（5–12 字符）：", "", config.ValidateAdminPath, "管理入口必须是 5–12 个 ASCII 字符")
	if err != nil {
		return config.DeploymentInput{}, err
	}
	username, err := input.prompt("管理员用户名：", "", config.ValidateUsername, "管理员用户名不能为空且最多 256 UTF-8 字节")
	if err != nil {
		return config.DeploymentInput{}, err
	}
	password, err := input.prompt("管理员密码：", "", func(value string) error {
		return config.ValidatePassword(value, username)
	}, "管理员密码需 6–16 UTF-8 字节且不能等于用户名")
	if err != nil {
		return config.DeploymentInput{}, err
	}
	confirmation, err := input.read("再次输入管理员密码：")
	if err != nil {
		return config.DeploymentInput{}, err
	}
	if confirmation != password {
		return config.DeploymentInput{}, errors.New("两次管理员密码不一致")
	}
	return config.DeploymentInput{
		APIToken:   apiToken,
		AccountID:  accountID,
		WorkerName: workerName,
		BucketName: bucketName,
		AdminPath:  adminPath,
		Username:   username,
		Password:   password,
	}, nil
}

func (input Input) prompt(question, defaultValue string, validator func(string) error, message string) (string, error) {
	value, err := input.read(question)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(value) == "" && defaultValue != "" {
		value = defaultValue
	}
	if err := validator(value); err != nil {
		return "", errors.New(message)
	}
	return value, nil
}

func (input Input) read(question string) (string, error) {
	if _, err := io.WriteString(input.Writer, question); err != nil {
		return "", err
	}
	reader := input.reader
	if reader == nil {
		reader = bufio.NewReader(input.Reader)
	}
	line, err := reader.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	if errors.Is(err, io.EOF) && line == "" {
		return "", errors.New("输入已结束")
	}
	return strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r"), nil
}

func PrintSummary(writer io.Writer, input config.DeploymentInput, applicationVersion string) {
	fmt.Fprintln(writer, "\n部署摘要：")
	fmt.Fprintf(writer, "Cloudflare 账号 ID：%s\n", input.AccountID)
	fmt.Fprintf(writer, "Worker：%s\n", input.WorkerName)
	fmt.Fprintf(writer, "R2 bucket：%s\n", input.BucketName)
	fmt.Fprintf(writer, "应用版本：%s\n", applicationVersion)
	fmt.Fprintln(writer, "API Token、管理员密码和生成的 secrets 不会显示在摘要中。")
}

func Confirm(writer io.Writer, reader io.Reader) (bool, error) {
	input := newInput(reader, writer)
	value, err := input.read("确认继续？[y/N] ")
	if err != nil {
		return false, err
	}
	return strings.EqualFold(strings.TrimSpace(value), "y") || strings.EqualFold(strings.TrimSpace(value), "yes"), nil
}
