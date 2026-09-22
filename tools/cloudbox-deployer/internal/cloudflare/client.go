package cloudflare

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"path"
	"strings"
	"time"
)

const DefaultAPIBaseURL = "https://api.cloudflare.com/client/v4"
const defaultMaxResponseBytes int64 = 2 << 20
const defaultReadAttempts = 3
const defaultRetryDelay = 25 * time.Millisecond

type Client struct {
	AccountID        string
	Token            string
	BaseURL          *url.URL
	HTTPClient       *http.Client
	MaxResponseBytes int64
	ReadAttempts     int
	RetryDelay       time.Duration
}

type APIError struct {
	Status  int
	Code    int
	Message string
}

func (e *APIError) Error() string {
	if e.Code != 0 {
		return fmt.Sprintf("Cloudflare API 请求失败（HTTP %d，错误码 %d）：%s", e.Status, e.Code, e.Message)
	}
	return fmt.Sprintf("Cloudflare API 请求失败（HTTP %d）：%s", e.Status, e.Message)
}

type envelope[T any] struct {
	Success  bool         `json:"success"`
	Errors   []apiMessage `json:"errors"`
	Messages []apiMessage `json:"messages"`
	Result   T            `json:"result"`
}

type apiMessage struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type Bucket struct {
	Name         string `json:"name"`
	CreationDate string `json:"creation_date"`
	Location     string `json:"location"`
	StorageClass string `json:"storage_class"`
}

type Script struct {
	ID           string `json:"id"`
	ETag         string `json:"etag"`
	CreatedOn    string `json:"created_on"`
	ModifiedOn   string `json:"modified_on"`
	MigrationTag string `json:"migration_tag"`
	UsageModel   string `json:"usage_model"`
}

type Version struct {
	ID string `json:"id"`
}

type Deployment struct {
	ID       string `json:"id"`
	Versions []struct {
		VersionID  string  `json:"version_id"`
		Percentage float64 `json:"percentage"`
	} `json:"versions"`
}

type AssetsUploadSession struct {
	Buckets [][]string `json:"buckets"`
	JWT     string     `json:"jwt"`
}

type WorkerVersion struct {
	ID string `json:"id"`
}

func New(accountID, token, baseURL string, httpClient *http.Client) (*Client, error) {
	if accountID == "" {
		return nil, errors.New("Cloudflare account ID 不能为空")
	}
	if token == "" || strings.IndexAny(token, " \t\r\n") >= 0 {
		return nil, errors.New("Cloudflare API Token 格式无效")
	}
	if baseURL == "" {
		baseURL = DefaultAPIBaseURL
	}
	parsed, err := url.Parse(strings.TrimRight(baseURL, "/") + "/")
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return nil, errors.New("Cloudflare API base URL 无效")
	}
	if parsed.User != nil {
		return nil, errors.New("Cloudflare API base URL 不允许凭据")
	}
	if parsed.Scheme == "http" && !isLocalTestHost(parsed.Hostname()) {
		return nil, errors.New("Cloudflare API 生产地址必须使用 HTTPS")
	}
	if parsed.Scheme == "https" && parsed.Hostname() != "api.cloudflare.com" {
		return nil, errors.New("Cloudflare API 地址不是受信任的 api.cloudflare.com")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 120 * time.Second}
	}
	clientCopy := *httpClient
	previousRedirect := clientCopy.CheckRedirect
	clientCopy.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) > 0 {
			previous := via[len(via)-1].URL
			if request.URL.Host != previous.Host || request.URL.Scheme != previous.Scheme {
				return http.ErrUseLastResponse
			}
		}
		if previousRedirect != nil {
			return previousRedirect(request, via)
		}
		return nil
	}
	return &Client{
		AccountID:        accountID,
		Token:            token,
		BaseURL:          parsed,
		HTTPClient:       &clientCopy,
		MaxResponseBytes: defaultMaxResponseBytes,
		ReadAttempts:     defaultReadAttempts,
		RetryDelay:       defaultRetryDelay,
	}, nil
}

func isLocalTestHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (c *Client) endpoint(parts ...string) *url.URL {
	copyURL := *c.BaseURL
	segments := make([]string, 0, len(parts)+1)
	basePath := strings.Trim(c.BaseURL.Path, "/")
	if basePath != "" {
		segments = append(segments, basePath)
	}
	segments = append(segments, parts...)
	copyURL.Path = "/" + path.Join(segments...)
	copyURL.RawPath = ""
	return &copyURL
}

func (c *Client) request(ctx context.Context, method string, endpoint *url.URL, body io.Reader, contentType string) (*http.Response, error) {
	return c.requestWithTokenHeaders(ctx, method, endpoint, c.Token, body, contentType, nil)
}

func (c *Client) requestWithToken(ctx context.Context, method string, endpoint *url.URL, token string, body io.Reader, contentType string) (*http.Response, error) {
	return c.requestWithTokenHeaders(ctx, method, endpoint, token, body, contentType, nil)
}

func (c *Client) requestWithTokenHeaders(ctx context.Context, method string, endpoint *url.URL, token string, body io.Reader, contentType string, headers map[string]string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	return c.HTTPClient.Do(req)
}

func (c *Client) doJSON(ctx context.Context, method string, endpoint *url.URL, payload any, result any) error {
	return c.doJSONWithHeaders(ctx, method, endpoint, payload, result, nil)
}

func (c *Client) doJSONWithHeaders(ctx context.Context, method string, endpoint *url.URL, payload any, result any, headers map[string]string) error {
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("编码 Cloudflare API 请求失败：%w", err)
		}
		body = bytes.NewReader(data)
	}
	return c.doWithHeaders(ctx, method, endpoint, c.Token, body, "application/json", result, headers)
}

func (c *Client) doJSONRead(ctx context.Context, endpoint *url.URL, result any) error {
	return c.doWithReadRetry(ctx, http.MethodGet, endpoint, nil, "application/json", result)
}

func (c *Client) doWithReadRetry(ctx context.Context, method string, endpoint *url.URL, body io.Reader, contentType string, result any) error {
	attempts := c.ReadAttempts
	if attempts <= 0 {
		attempts = defaultReadAttempts
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		lastErr = c.do(ctx, method, endpoint, body, contentType, result)
		if lastErr == nil || !isRetryableReadError(lastErr) || attempt == attempts-1 {
			return lastErr
		}
		if err := waitRetry(ctx, c.RetryDelay, attempt); err != nil {
			return err
		}
	}
	return lastErr
}

func waitRetry(ctx context.Context, baseDelay time.Duration, attempt int) error {
	if baseDelay <= 0 {
		return nil
	}
	delay := baseDelay * time.Duration(1<<attempt)
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func isRetryableReadError(err error) bool {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.Status == http.StatusTooManyRequests || apiErr.Status >= 500
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	return errors.Is(err, context.DeadlineExceeded) || isNetworkError(err)
}

func isNetworkError(err error) bool {
	var urlErr *url.Error
	return errors.As(err, &urlErr)
}

func (c *Client) do(ctx context.Context, method string, endpoint *url.URL, body io.Reader, contentType string, result any) error {
	return c.doWithHeaders(ctx, method, endpoint, c.Token, body, contentType, result, nil)
}

func (c *Client) doWithToken(ctx context.Context, method string, endpoint *url.URL, token string, body io.Reader, contentType string, result any) error {
	return c.doWithHeaders(ctx, method, endpoint, token, body, contentType, result, nil)
}

func (c *Client) doWithHeaders(ctx context.Context, method string, endpoint *url.URL, token string, body io.Reader, contentType string, result any, headers map[string]string) error {
	response, err := c.requestWithTokenHeaders(ctx, method, endpoint, token, body, contentType, headers)
	if err != nil {
		return fmt.Errorf("Cloudflare API 网络请求失败：%w", err)
	}
	defer response.Body.Close()
	limit := c.responseLimit()
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return fmt.Errorf("读取 Cloudflare API 响应失败：%w", err)
	}
	if int64(len(data)) > limit {
		return errors.New("Cloudflare API 响应超过大小上限")
	}
	var envelopeData envelope[json.RawMessage]
	if err := json.Unmarshal(data, &envelopeData); err != nil {
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return &APIError{Status: response.StatusCode, Message: http.StatusText(response.StatusCode)}
		}
		return errors.New("Cloudflare API 返回无法解析的 JSON")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || !envelopeData.Success {
		return apiErrorFromEnvelope(response.StatusCode, envelopeData.Errors, token)
	}
	if result != nil && len(envelopeData.Result) > 0 && string(envelopeData.Result) != "null" {
		if err := json.Unmarshal(envelopeData.Result, result); err != nil {
			return fmt.Errorf("解析 Cloudflare API result 失败：%w", err)
		}
	}
	return nil
}

func (c *Client) responseLimit() int64 {
	if c.MaxResponseBytes <= 0 {
		return defaultMaxResponseBytes
	}
	return c.MaxResponseBytes
}

func apiErrorFromEnvelope(status int, messages []apiMessage, token string) error {
	if len(messages) == 0 {
		return &APIError{Status: status, Message: http.StatusText(status)}
	}
	message := messages[0]
	message.Message = strings.ReplaceAll(message.Message, token, "[REDACTED]")
	return &APIError{Status: status, Code: message.Code, Message: message.Message}
}

func (c *Client) ListBuckets(ctx context.Context) ([]Bucket, error) {
	var result struct {
		Buckets []Bucket `json:"buckets"`
	}
	if err := c.doJSONRead(ctx, c.endpoint("accounts", c.AccountID, "r2", "buckets"), &result); err != nil {
		return nil, err
	}
	return result.Buckets, nil
}

func (c *Client) BucketExists(ctx context.Context, name string) (bool, error) {
	buckets, err := c.ListBuckets(ctx)
	if err != nil {
		return false, err
	}
	for _, bucket := range buckets {
		if bucket.Name == name {
			return true, nil
		}
	}
	return false, nil
}

func (c *Client) CreateBucket(ctx context.Context, name string) error {
	return c.doJSON(ctx, http.MethodPost, c.endpoint("accounts", c.AccountID, "r2", "buckets"), map[string]string{"name": name}, nil)
}

func (c *Client) ListScripts(ctx context.Context) ([]Script, error) {
	var result []Script
	if err := c.doJSONRead(ctx, c.endpoint("accounts", c.AccountID, "workers", "scripts"), &result); err != nil {
		return nil, err
	}
	return result, nil
}

func (c *Client) WorkerExists(ctx context.Context, name string) (bool, error) {
	scripts, err := c.ListScripts(ctx)
	if err != nil {
		return false, err
	}
	for _, script := range scripts {
		if script.ID == name {
			return true, nil
		}
	}
	return false, nil
}

func (c *Client) ListDeployments(ctx context.Context, name string) ([]Deployment, error) {
	var result struct {
		Deployments []Deployment `json:"deployments"`
	}
	if err := c.doJSONRead(ctx, c.endpoint("accounts", c.AccountID, "workers", "scripts", name, "deployments"), &result); err != nil {
		return nil, err
	}
	return result.Deployments, nil
}

func (c *Client) DeploymentContainsVersion(ctx context.Context, name, versionID string) (bool, error) {
	deployments, err := c.ListDeployments(ctx, name)
	if err != nil {
		return false, err
	}
	for _, deployment := range deployments {
		for _, version := range deployment.Versions {
			if version.VersionID == versionID && version.Percentage > 0 {
				return true, nil
			}
		}
	}
	return false, nil
}

func IsOutcomeUnknown(err error) bool {
	if err == nil {
		return false
	}
	if isNetworkError(err) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var apiErr *APIError
	return errors.As(err, &apiErr) && (apiErr.Status == http.StatusTooManyRequests || apiErr.Status >= 500)
}

func workerMultipart(metadata []byte, workerName, workerContentType string, worker io.Reader, workerSize int64) ([]byte, string, error) {
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	if err := form.WriteField("metadata", string(metadata)); err != nil {
		return nil, "", fmt.Errorf("写入 Worker metadata 失败：%w", err)
	}
	if workerContentType == "" {
		workerContentType = "application/javascript+module"
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, workerName, workerName))
	header.Set("Content-Type", workerContentType)
	part, err := form.CreatePart(header)
	if err != nil {
		return nil, "", fmt.Errorf("创建 Worker multipart part 失败：%w", err)
	}
	if _, err := io.CopyN(part, worker, workerSize); err != nil {
		return nil, "", fmt.Errorf("写入 Worker multipart part 失败：%w", err)
	}
	if err := form.Close(); err != nil {
		return nil, "", fmt.Errorf("完成 Worker multipart 请求失败：%w", err)
	}
	return body.Bytes(), form.FormDataContentType(), nil
}

func (c *Client) CreateWorkerVersion(ctx context.Context, name string, metadata []byte, workerName, workerContentType string, worker io.Reader, workerSize int64) (WorkerVersion, error) {
	var result WorkerVersion
	body, contentType, err := workerMultipart(metadata, workerName, workerContentType, worker, workerSize)
	if err != nil {
		return result, err
	}
	if err := c.do(ctx, http.MethodPost, c.endpoint("accounts", c.AccountID, "workers", "scripts", name, "versions"), bytes.NewReader(body), contentType, &result); err != nil {
		return result, err
	}
	return result, nil
}

func (c *Client) UploadWorker(ctx context.Context, name string, metadata []byte, workerName, workerContentType string, worker io.Reader, workerSize int64) error {
	body, contentType, err := workerMultipart(metadata, workerName, workerContentType, worker, workerSize)
	if err != nil {
		return err
	}
	return c.do(ctx, http.MethodPut, c.endpoint("accounts", c.AccountID, "workers", "scripts", name), bytes.NewReader(body), contentType, nil)
}

type AssetUpload struct {
	Hash        string
	Content     []byte
	ContentType string
}

type AssetManifestEntry struct {
	Hash string `json:"hash"`
	Size int64  `json:"size"`
}

func (c *Client) StartAssetsUploadSession(ctx context.Context, name string, manifest map[string]AssetManifestEntry) (AssetsUploadSession, error) {
	var result AssetsUploadSession
	payload := struct {
		Manifest any `json:"manifest"`
	}{Manifest: manifest}
	if err := c.doJSON(
		ctx,
		http.MethodPost,
		c.endpoint("accounts", c.AccountID, "workers", "scripts", name, "assets-upload-session"),
		payload,
		&result,
	); err != nil {
		return result, err
	}
	return result, nil
}

func (c *Client) UploadAssetBucket(ctx context.Context, jwt string, assets []AssetUpload) (string, error) {
	if jwt == "" {
		return "", errors.New("Assets upload JWT 不能为空")
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	for _, asset := range assets {
		if asset.Hash == "" {
			return "", errors.New("Assets upload hash 不能为空")
		}
		contentType := asset.ContentType
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, asset.Hash, asset.Hash))
		header.Set("Content-Type", contentType)
		part, err := form.CreatePart(header)
		if err != nil {
			return "", fmt.Errorf("创建 Assets multipart part 失败：%w", err)
		}
		encoded := make([]byte, base64.StdEncoding.EncodedLen(len(asset.Content)))
		base64.StdEncoding.Encode(encoded, asset.Content)
		if _, err := part.Write(encoded); err != nil {
			return "", fmt.Errorf("写入 Assets multipart part 失败：%w", err)
		}
	}
	if err := form.Close(); err != nil {
		return "", fmt.Errorf("完成 Assets multipart 请求失败：%w", err)
	}
	endpoint := c.endpoint("accounts", c.AccountID, "workers", "assets", "upload")
	query := endpoint.Query()
	query.Set("base64", "true")
	endpoint.RawQuery = query.Encode()
	var result struct {
		JWT string `json:"jwt"`
	}
	if err := c.doWithToken(ctx, http.MethodPost, endpoint, jwt, bytes.NewReader(body.Bytes()), form.FormDataContentType(), &result); err != nil {
		return "", err
	}
	// 中间批次可以不返回 JWT；调用方保留此前成功上传返回的 completion JWT。
	return result.JWT, nil
}

func (c *Client) DeployVersion(ctx context.Context, name, versionID, message string) error {
	payload := struct {
		Strategy string `json:"strategy"`
		Versions []struct {
			VersionID  string  `json:"version_id"`
			Percentage float64 `json:"percentage"`
		} `json:"versions"`
		Annotations map[string]string `json:"annotations,omitempty"`
	}{
		Strategy: "percentage",
		Versions: []struct {
			VersionID  string  `json:"version_id"`
			Percentage float64 `json:"percentage"`
		}{{VersionID: versionID, Percentage: 100}},
		Annotations: map[string]string{"workers/message": message},
	}
	return c.doJSON(ctx, http.MethodPost, c.endpoint("accounts", c.AccountID, "workers", "scripts", name, "deployments"), payload, nil)
}

func (c *Client) PutSecret(ctx context.Context, name, secretName, value string) error {
	if secretName == "" || value == "" {
		return errors.New("Worker secret 名称和值不能为空")
	}
	payload := struct {
		Name string `json:"name"`
		Text string `json:"text"`
		Type string `json:"type"`
	}{Name: secretName, Text: value, Type: "secret_text"}
	return c.doJSON(ctx, http.MethodPut, c.endpoint("accounts", c.AccountID, "workers", "scripts", name, "secrets"), payload, nil)
}

func (c *Client) EnableWorkerSubdomain(ctx context.Context, name string) (bool, error) {
	var result struct {
		Enabled bool `json:"enabled"`
	}
	if err := c.doJSONWithHeaders(ctx, http.MethodPost, c.endpoint("accounts", c.AccountID, "workers", "scripts", name, "subdomain"), map[string]any{
		"enabled":          true,
		"previews_enabled": false,
	}, &result, map[string]string{
		"Cloudflare-Workers-Script-Api-Date": "2025-08-01",
	}); err != nil {
		return false, err
	}
	return result.Enabled, nil
}

func (c *Client) WorkersDevSubdomain(ctx context.Context) (string, error) {
	var result struct {
		Subdomain string `json:"subdomain"`
	}
	if err := c.doJSONRead(ctx, c.endpoint("accounts", c.AccountID, "workers", "subdomain"), &result); err != nil {
		return "", err
	}
	return result.Subdomain, nil
}
