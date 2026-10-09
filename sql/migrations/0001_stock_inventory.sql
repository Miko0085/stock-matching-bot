-- Runtime stock table synchronized daily/manually from the "Stock Inventory"
-- Google Sheet. This is the ONLY source realtime matching reads from.
CREATE TABLE IF NOT EXISTS matching.stock_inventory (
  stock_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  transaction_type TEXT NOT NULL,
  city TEXT,
  area TEXT,
  project_community TEXT,
  building TEXT,
  bedrooms INTEGER,
  bedrooms_label TEXT,
  bathrooms NUMERIC,
  property_type TEXT,
  selling_price NUMERIC,
  annual_rent NUMERIC,
  size_sqft NUMERIC,
  plot_size_sqft NUMERIC,
  furnishing TEXT,
  view TEXT,
  broker TEXT,
  broker_contact TEXT,
  telegram_post TEXT,
  whatsapp_post TEXT,
  notes TEXT,
  source_updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pilot realtime search defaults to status = 'ACTIVE' AND transaction_type = 'SALE'.
CREATE INDEX IF NOT EXISTS idx_stock_inventory_active_sale
  ON matching.stock_inventory (status, transaction_type, area);

CREATE INDEX IF NOT EXISTS idx_stock_inventory_building
  ON matching.stock_inventory (building);
