package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/biker2000on/beez-trackz/backend/internal/brand"
	"github.com/biker2000on/beez-trackz/backend/internal/config"
)

func TestMCPInitializeUsesDeploymentBrandTitleAndStableName(t *testing.T) {
	deployment := brand.Default()
	deployment.DisplayName = "Orchard Ledger"
	server := &Server{cfg: &config.Config{Brand: deployment}}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/mcp",
		strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`))
	response := httptest.NewRecorder()
	server.mcpPost(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	var result struct {
		Result struct {
			ServerInfo struct {
				Name  string `json:"name"`
				Title string `json:"title"`
			} `json:"serverInfo"`
		} `json:"result"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Result.ServerInfo.Name != "beez-trackz" {
		t.Fatalf("machine name changed to %q", result.Result.ServerInfo.Name)
	}
	if result.Result.ServerInfo.Title != "Orchard Ledger" {
		t.Fatalf("title = %q", result.Result.ServerInfo.Title)
	}
}
