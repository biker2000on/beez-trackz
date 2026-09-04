package notify

import (
	"strings"
	"testing"

	"github.com/biker2000on/beez-trackz/backend/internal/brand"
)

func TestNotificationBodiesUseDeploymentBrand(t *testing.T) {
	deployment := brand.Default()
	deployment.DisplayName = "Orchard Ledger"
	for _, eventType := range []string{"sale.recorded", "harvest_entry.added"} {
		message, ok := messageForDomainEvent(deployment, eventType)
		if !ok {
			t.Fatalf("%s did not produce a notification", eventType)
		}
		if !strings.Contains(message.Title, deployment.DisplayName) ||
			!strings.Contains(message.Body, deployment.DisplayName) {
			t.Fatalf("%s notification did not use deployment brand: %#v", eventType, message)
		}
	}
}

func TestNotificationBodyFallsBackToProductBrand(t *testing.T) {
	message, ok := messageForDomainEvent(brand.Brand{}, "sale.recorded")
	if !ok || !strings.Contains(message.Body, brand.Product) {
		t.Fatalf("default notification = %#v, ok=%v", message, ok)
	}
}
