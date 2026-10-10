package sales

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Consignment pricing: what a store's shelf price is, and what the operator
// is owed per unit sold there. Settlement (ApplySettlement) and every read
// that previews it (the shelf's owedPrice, the store's price sheet) call the
// functions below, so the number on screen is the number a report records.
//
// Prices are resolved at settlement time and frozen into sale_items, so
// changing a store's terms or prices only affects reports recorded later.

// ConsignmentTerms is a consignee's price basis.
type ConsignmentTerms struct {
	Basis         string
	CommissionBPS *int
	PriceListID   *uuid.UUID
}

// ConsignmentSKUPrices is everything that can price one SKU at one store.
type ConsignmentSKUPrices struct {
	Label string
	// ListPriceCents is the SKU's own default price; 0 when it has none.
	ListPriceCents int64
	IsProduct      bool
	// The store's own prices (consignment_location_prices); nil when unset.
	StoreShelfCents     *int64
	StoreWholesaleCents *int64
	// PriceListCents is the store's wholesale price list item for this jar;
	// nil when the store has no list or the list does not price the jar.
	// Price lists never price catalog products.
	PriceListCents *int64
}

// DefaultShelfCents is the shelf price a report line falls back to when it
// names none: the store's shelf price, else the SKU's list price.
func (p ConsignmentSKUPrices) DefaultShelfCents() int64 {
	if p.StoreShelfCents != nil {
		return *p.StoreShelfCents
	}
	return p.ListPriceCents
}

// ConsignmentUnitSplit divides one unit sold at shelfCents into what the
// operator is owed and what the store keeps, in exact integer cents. A
// non-empty problem is an operator-facing reason the unit cannot be priced.
//
//   - retail: the operator is owed the whole shelf price.
//   - commission: the store keeps commission_bps of the shelf price, rounded
//     half away from zero so the halves add back up to the shelf price.
//   - wholesale_list: the store's own wholesale price when set — owed as is,
//     not capped at the shelf price and needing no shelf price at all; the
//     store's margin is whatever the shelf price adds on top, never below
//     zero. Otherwise the store's price list item, capped at the shelf price
//     (the operator is never owed more than the store collected).
func ConsignmentUnitSplit(
	terms ConsignmentTerms, prices ConsignmentSKUPrices, shelfCents int64,
) (owed, commission int64, problem string) {
	if terms.Basis == "wholesale_list" && prices.StoreWholesaleCents != nil {
		owed = *prices.StoreWholesaleCents
		if shelfCents > owed {
			commission = shelfCents - owed
		}
		return owed, commission, ""
	}
	if shelfCents <= 0 {
		return 0, 0, prices.Label + ": unit price is required"
	}
	switch terms.Basis {
	case "commission":
		if terms.CommissionBPS == nil {
			return shelfCents, 0, ""
		}
		commission = (shelfCents*int64(*terms.CommissionBPS) + 5000) / 10000
		return shelfCents - commission, commission, ""
	case "wholesale_list":
		if prices.PriceListCents == nil || prices.IsProduct {
			return 0, 0, "no wholesale price for " + prices.Label + " — set it in the store's prices"
		}
		owed = *prices.PriceListCents
		if owed > shelfCents {
			owed = shelfCents
		}
		return owed, shelfCents - owed, ""
	default:
		return shelfCents, 0, ""
	}
}

// ConsignmentQuerier is the read surface the price book needs; both a pool
// and a unit of work satisfy it.
type ConsignmentQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// ConsignmentStorePrice is one row of a store's own prices.
type ConsignmentStorePrice struct {
	WholesaleCents *int64
	ShelfCents     *int64
}

// ConsignmentPriceBook is one store's prices: its own per-SKU overrides and
// its wholesale price list, read once and consulted per SKU.
type ConsignmentPriceBook struct {
	Jars      map[uuid.UUID]ConsignmentStorePrice
	Products  map[uuid.UUID]ConsignmentStorePrice
	PriceList map[uuid.UUID]int64
}

// LoadConsignmentPriceBook reads a store's prices. locationID is the ledger
// location id (inventory_locations.id); priceListID may be nil.
func LoadConsignmentPriceBook(
	ctx context.Context, q ConsignmentQuerier, locationID uuid.UUID, priceListID *uuid.UUID,
) (ConsignmentPriceBook, error) {
	book := ConsignmentPriceBook{
		Jars:      map[uuid.UUID]ConsignmentStorePrice{},
		Products:  map[uuid.UUID]ConsignmentStorePrice{},
		PriceList: map[uuid.UUID]int64{},
	}
	rows, err := q.Query(ctx, `
		SELECT jar_size_id, product_id, wholesale_price_cents, shelf_price_cents
		FROM consignment_location_prices WHERE location_id=$1`, locationID)
	if err != nil {
		return book, err
	}
	for rows.Next() {
		var jar, product *uuid.UUID
		var price ConsignmentStorePrice
		if err := rows.Scan(&jar, &product, &price.WholesaleCents, &price.ShelfCents); err != nil {
			rows.Close()
			return book, err
		}
		if jar != nil {
			book.Jars[*jar] = price
		} else if product != nil {
			book.Products[*product] = price
		}
	}
	storeErr := rows.Err()
	rows.Close()
	if storeErr != nil {
		return book, storeErr
	}
	if priceListID == nil {
		return book, nil
	}
	listRows, err := q.Query(ctx, `
		SELECT jar_size_id, unit_price_cents FROM wholesale_price_list_items
		WHERE price_list_id=$1`, *priceListID)
	if err != nil {
		return book, err
	}
	defer listRows.Close()
	for listRows.Next() {
		var jar uuid.UUID
		var cents int64
		if err := listRows.Scan(&jar, &cents); err != nil {
			return book, err
		}
		book.PriceList[jar] = cents
	}
	return book, listRows.Err()
}

// SKU assembles one SKU's prices at this store. Exactly one of jar/product is
// expected; listPriceCents is the SKU's default price (0 when unset).
func (b ConsignmentPriceBook) SKU(
	jar, product *uuid.UUID, label string, listPriceCents int64,
) ConsignmentSKUPrices {
	prices := ConsignmentSKUPrices{Label: label, ListPriceCents: listPriceCents}
	var store ConsignmentStorePrice
	var found bool
	if jar != nil {
		store, found = b.Jars[*jar]
		if cents, ok := b.PriceList[*jar]; ok {
			value := cents
			prices.PriceListCents = &value
		}
	} else if product != nil {
		prices.IsProduct = true
		store, found = b.Products[*product]
	}
	if found {
		prices.StoreShelfCents = store.ShelfCents
		prices.StoreWholesaleCents = store.WholesaleCents
	}
	return prices
}
