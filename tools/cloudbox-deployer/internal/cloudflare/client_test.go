package cloudflare

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testAccountID = "0123456789abcdef0123456789abcdef"
const testToken = "token-that-must-not-leak"

func newTestClient(t *testing.T, handler http.Handler) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := New(testAccountID, testToken, server.URL+"/client/v4", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func writeEnvelope(t *testing.T, writer http.ResponseWriter, status int, success bool, result any, messages []apiMessage) {
	t.Helper()
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(map[string]any{
		"success":  success,
		"errors":   messages,
		"messages": []apiMessage{},
		"result":   result,
	})
}

func TestListBucketsAndScripts(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+testToken {
			t.Fatalf("Authorization = %q", request.Header.Get("Authorization"))
		}
		switch request.URL.Path {
		case "/client/v4/accounts/" + testAccountID + "/r2/buckets":
			writeEnvelope(t, writer, http.StatusOK, true, map[string]any{
				"buckets": []map[string]string{{"name": "existing-bucket"}},
			}, nil)
		case "/client/v4/accounts/" + testAccountID + "/workers/scripts":
			writeEnvelope(t, writer, http.StatusOK, true, []map[string]string{{"id": "existing-worker"}}, nil)
		default:
			http.NotFound(writer, request)
		}
	}))

	buckets, err := client.ListBuckets(context.Background())
	if err != nil {
		t.Fatalf("ListBuckets() error = %v", err)
	}
	if len(buckets) != 1 || buckets[0].Name != "existing-bucket" {
		t.Fatalf("ListBuckets() = %#v", buckets)
	}
	workerExists, err := client.WorkerExists(context.Background(), "existing-worker")
	if err != nil {
		t.Fatalf("WorkerExists() error = %v", err)
	}
	if !workerExists {
		t.Fatal("WorkerExists() = false, want true")
	}
	bucketExists, err := client.BucketExists(context.Background(), "missing-bucket")
	if err != nil {
		t.Fatalf("BucketExists() error = %v", err)
	}
	if bucketExists {
		t.Fatal("BucketExists() = true, want false")
	}
}

func TestRedirectDoesNotForwardTokenToAnotherHost(t *testing.T) {
	crossHostCalled := make(chan struct{}, 1)
	crossHost := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		crossHostCalled <- struct{}{}
		writeEnvelope(t, writer, http.StatusOK, true, map[string]any{}, nil)
	}))
	defer crossHost.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, crossHost.URL, http.StatusFound)
	}))
	defer redirect.Close()
	client, err := New(testAccountID, testToken, redirect.URL, redirect.Client())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ListBuckets(context.Background())
	if err == nil {
		t.Fatal("ListBuckets() returned nil error for redirect response")
	}
	select {
	case <-crossHostCalled:
		t.Fatal("client followed redirect to another host")
	default:
	}
}

func TestReadRetries429And5xx(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusBadGateway} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			attempts := 0
			client := newTestClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				attempts++
				if attempts < 2 {
					writeEnvelope(t, writer, status, false, nil, []apiMessage{{Code: 1000, Message: "temporary"}})
					return
				}
				writeEnvelope(t, writer, http.StatusOK, true, map[string]any{
					"buckets": []map[string]string{{"name": "after-retry"}},
				}, nil)
			}))
			client.RetryDelay = 0
			buckets, err := client.ListBuckets(context.Background())
			if err != nil {
				t.Fatalf("ListBuckets() error = %v", err)
			}
			if attempts != 2 || len(buckets) != 1 || buckets[0].Name != "after-retry" {
				t.Fatalf("attempts=%d buckets=%#v", attempts, buckets)
			}
		})
	}
}

func TestWriteDoesNotRetryServerError(t *testing.T) {
	attempts := 0
	client := newTestClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		attempts++
		writeEnvelope(t, writer, http.StatusInternalServerError, false, nil, []apiMessage{{Code: 1000, Message: "temporary"}})
	}))
	if err := client.CreateBucket(context.Background(), "write-once"); err == nil {
		t.Fatal("CreateBucket() returned nil error")
	}
	if attempts != 1 {
		t.Fatalf("write attempts = %d, want 1", attempts)
	}
}

func TestReadRetryHonorsContextCancellation(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writeEnvelope(t, writer, http.StatusTooManyRequests, false, nil, []apiMessage{{Code: 1000, Message: "temporary"}})
	}))
	client.RetryDelay = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := client.ListBuckets(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("ListBuckets() error = %v, want context.Canceled", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestReadRetriesNetworkError(t *testing.T) {
	attempts := 0
	client, err := New(testAccountID, testToken, "http://127.0.0.1", &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		attempts++
		if attempts == 1 {
			return nil, errors.New("temporary network error")
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"success":true,"result":{"buckets":[]}}`)),
			Request:    request,
		}, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	client.RetryDelay = 0
	buckets, err := client.ListBuckets(context.Background())
	if err != nil || attempts != 2 || len(buckets) != 0 {
		t.Fatalf("attempts=%d buckets=%#v error=%v", attempts, buckets, err)
	}
}

func TestReadRetryExhaustsTimeout(t *testing.T) {
	attempts := 0
	client, err := New(testAccountID, testToken, "http://127.0.0.1", &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		attempts++
		return nil, context.DeadlineExceeded
	})})
	if err != nil {
		t.Fatal(err)
	}
	client.RetryDelay = 0
	if _, err := client.ListBuckets(context.Background()); err == nil || attempts != 3 {
		t.Fatalf("attempts=%d error=%v", attempts, err)
	}
}

func TestResponseLimitAndMalformedJSON(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte("not-json"))
	}))
	if _, err := client.ListBuckets(context.Background()); err == nil {
		t.Fatal("ListBuckets() accepted malformed JSON")
	}

	large := newTestClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(strings.Repeat("x", 64)))
	}))
	large.MaxResponseBytes = 16
	if _, err := large.ListBuckets(context.Background()); err == nil || !strings.Contains(err.Error(), "超过大小上限") {
		t.Fatalf("large response error = %v", err)
	}
}

func TestDeploymentContainsVersion(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writeEnvelope(t, writer, http.StatusOK, true, map[string]any{
			"deployments": []map[string]any{{
				"id":       "deployment-1",
				"versions": []map[string]any{{"version_id": "version-1", "percentage": 100}},
			}},
		}, nil)
	}))
	found, err := client.DeploymentContainsVersion(context.Background(), "worker", "version-1")
	if err != nil || !found {
		t.Fatalf("found=%t error=%v", found, err)
	}
	found, err = client.DeploymentContainsVersion(context.Background(), "worker", "missing")
	if err != nil || found {
		t.Fatalf("missing found=%t error=%v", found, err)
	}
}

func TestCreateBucketSendsExpectedJSON(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			t.Fatalf("method = %s", request.Method)
		}
		if request.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("Content-Type = %q", request.Header.Get("Content-Type"))
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != `{"name":"new-bucket"}` {
			t.Fatalf("body = %s", body)
		}
		writeEnvelope(t, writer, http.StatusOK, true, map[string]any{}, nil)
	}))
	if err := client.CreateBucket(context.Background(), "new-bucket"); err != nil {
		t.Fatalf("CreateBucket() error = %v", err)
	}
}

func TestAPIErrorRedactsToken(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writeEnvelope(t, writer, http.StatusForbidden, false, nil, []apiMessage{{
			Code:    9109,
			Message: "invalid token " + testToken,
		}})
	}))
	_, err := client.ListBuckets(context.Background())
	if err == nil {
		t.Fatal("ListBuckets() returned nil error")
	}
	if strings.Contains(err.Error(), testToken) {
		t.Fatalf("error leaked token: %v", err)
	}
	if !strings.Contains(err.Error(), "[REDACTED]") {
		t.Fatalf("error did not redact token: %v", err)
	}
}

func TestCreateWorkerVersionSendsMultipartMetadataAndWorker(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || !strings.HasSuffix(request.URL.Path, "/versions") {
			t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		mediaType, params, err := mimeMultipart(request.Header.Get("Content-Type"))
		if err != nil {
			t.Fatal(err)
		}
		reader, err := multipart.NewReader(request.Body, params["boundary"]).ReadForm(1024 * 1024)
		if err != nil {
			t.Fatal(err)
		}
		metadata := reader.Value["metadata"]
		if len(metadata) != 1 || metadata[0] != `{"main_module":"worker.js"}` {
			t.Fatalf("metadata = %#v", metadata)
		}
		files := reader.File["worker.js"]
		if len(files) != 1 {
			t.Fatalf("worker files = %#v", files)
		}
		file, err := files[0].Open()
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		fileBody, err := io.ReadAll(file)
		if err != nil {
			t.Fatal(err)
		}
		if string(fileBody) != "export default 1;" {
			t.Fatalf("worker body = %q", fileBody)
		}
		_ = mediaType
		writeEnvelope(t, writer, http.StatusOK, true, map[string]string{"id": "version-1"}, nil)
	}))
	version, err := client.CreateWorkerVersion(
		context.Background(),
		"new-worker",
		[]byte(`{"main_module":"worker.js"}`),
		"worker.js",
		"application/javascript+module",
		strings.NewReader("export default 1;"),
		17,
	)
	if err != nil {
		t.Fatalf("CreateWorkerVersion() error = %v", err)
	}
	if version.ID != "version-1" {
		t.Fatalf("version.ID = %q", version.ID)
	}
}

func mimeMultipart(contentType string) (string, map[string]string, error) {
	mediaType, params, err := mime.ParseMediaType(contentType)
	return mediaType, params, err
}

func TestUploadAssetBucketAllowsIntermediateEmptyJWT(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writeEnvelope(t, writer, http.StatusOK, true, map[string]any{}, nil)
	}))
	jwt, err := client.UploadAssetBucket(context.Background(), "upload-jwt", []AssetUpload{{
		Hash: "hash-1", Content: []byte("content"), ContentType: "text/plain",
	}})
	if err != nil || jwt != "" {
		t.Fatalf("jwt=%q error=%v", jwt, err)
	}
}

func TestEnableWorkerSubdomain(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || !strings.HasSuffix(request.URL.Path, "/subdomain") {
			t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Cloudflare-Workers-Script-Api-Date") != "2025-08-01" {
			t.Fatalf("script API date = %q", request.Header.Get("Cloudflare-Workers-Script-Api-Date"))
		}
		var payload map[string]any
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload["enabled"] != true || payload["previews_enabled"] != false {
			t.Fatalf("payload = %#v", payload)
		}
		writeEnvelope(t, writer, http.StatusOK, true, map[string]any{"enabled": true}, nil)
	}))
	enabled, err := client.EnableWorkerSubdomain(context.Background(), "worker")
	if err != nil || !enabled {
		t.Fatalf("enabled=%t error=%v", enabled, err)
	}
}

func TestUploadWorkerUsesNonVersionedEndpoint(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPut || !strings.HasSuffix(request.URL.Path, "/workers/scripts/worker") {
			t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		_, params, err := mimeMultipart(request.Header.Get("Content-Type"))
		if err != nil {
			t.Fatal(err)
		}
		form, err := multipart.NewReader(request.Body, params["boundary"]).ReadForm(1024 * 1024)
		if err != nil {
			t.Fatal(err)
		}
		if form.Value["metadata"][0] != `{"migrations":{"new_tag":"v1"}}` {
			t.Fatalf("metadata = %#v", form.Value["metadata"])
		}
		writeEnvelope(t, writer, http.StatusOK, true, map[string]any{}, nil)
	}))
	if err := client.UploadWorker(context.Background(), "worker", []byte(`{"migrations":{"new_tag":"v1"}}`), "worker.js", "application/javascript+module", strings.NewReader("export default 1;"), 17); err != nil {
		t.Fatalf("UploadWorker() error = %v", err)
	}
}

func TestAssetsSecretsDeploymentAndSubdomainAPI(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case strings.HasSuffix(request.URL.Path, "/assets-upload-session"):
			if request.Header.Get("Authorization") != "Bearer "+testToken {
				t.Fatalf("asset session authorization = %q", request.Header.Get("Authorization"))
			}
			writeEnvelope(t, writer, http.StatusOK, true, AssetsUploadSession{
				Buckets: [][]string{{"hash-1"}},
				JWT:     "upload-jwt",
			}, nil)
		case strings.HasSuffix(request.URL.Path, "/workers/assets/upload"):
			if request.Header.Get("Authorization") != "Bearer upload-jwt" {
				t.Fatalf("asset upload authorization = %q", request.Header.Get("Authorization"))
			}
			_, params, err := mimeMultipart(request.Header.Get("Content-Type"))
			if err != nil {
				t.Fatal(err)
			}
			form, err := multipart.NewReader(request.Body, params["boundary"]).ReadForm(1024 * 1024)
			if err != nil {
				t.Fatal(err)
			}
			files := form.File["hash-1"]
			if len(files) != 1 {
				t.Fatalf("uploaded asset files = %#v", files)
			}
			file, err := files[0].Open()
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			encoded, err := io.ReadAll(file)
			if err != nil {
				t.Fatal(err)
			}
			if string(encoded) != "Y29udGVudA==" {
				t.Fatalf("encoded asset = %q", encoded)
			}
			writeEnvelope(t, writer, http.StatusOK, true, map[string]string{"jwt": "completion-jwt"}, nil)
		case strings.HasSuffix(request.URL.Path, "/deployments"):
			var payload struct {
				Strategy string `json:"strategy"`
				Versions []struct {
					VersionID  string  `json:"version_id"`
					Percentage float64 `json:"percentage"`
				} `json:"versions"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if payload.Strategy != "percentage" || len(payload.Versions) != 1 || payload.Versions[0].VersionID != "version-1" || payload.Versions[0].Percentage != 100 {
				t.Fatalf("deployment payload = %#v", payload)
			}
			writeEnvelope(t, writer, http.StatusOK, true, map[string]any{}, nil)
		case strings.HasSuffix(request.URL.Path, "/secrets"):
			var payload struct {
				Name string `json:"name"`
				Text string `json:"text"`
				Type string `json:"type"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if payload.Name != "ADMIN_USERNAME" || payload.Text != "user" || payload.Type != "secret_text" {
				t.Fatalf("secret payload = %#v", payload)
			}
			writeEnvelope(t, writer, http.StatusOK, true, map[string]any{}, nil)
		case strings.HasSuffix(request.URL.Path, "/workers/subdomain"):
			writeEnvelope(t, writer, http.StatusOK, true, map[string]string{"subdomain": "example"}, nil)
		default:
			http.NotFound(writer, request)
		}
	}))

	session, err := client.StartAssetsUploadSession(context.Background(), "worker", map[string]AssetManifestEntry{
		"/index.html": {Hash: "hash-1", Size: 7},
	})
	if err != nil || session.JWT != "upload-jwt" || len(session.Buckets) != 1 {
		t.Fatalf("StartAssetsUploadSession() = %#v, error = %v", session, err)
	}
	completion, err := client.UploadAssetBucket(context.Background(), session.JWT, []AssetUpload{{
		Hash:        "hash-1",
		Content:     []byte("content"),
		ContentType: "text/plain",
	}})
	if err != nil || completion != "completion-jwt" {
		t.Fatalf("UploadAssetBucket() = %q, error = %v", completion, err)
	}
	if err := client.PutSecret(context.Background(), "worker", "ADMIN_USERNAME", "user"); err != nil {
		t.Fatalf("PutSecret() error = %v", err)
	}
	if err := client.DeployVersion(context.Background(), "worker", "version-1", "test"); err != nil {
		t.Fatalf("DeployVersion() error = %v", err)
	}
	subdomain, err := client.WorkersDevSubdomain(context.Background())
	if err != nil || subdomain != "example" {
		t.Fatalf("WorkersDevSubdomain() = %q, error = %v", subdomain, err)
	}
}
