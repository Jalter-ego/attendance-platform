ALTER TABLE platform_scans ADD COLUMN operation_id uuid REFERENCES operations(id);
ALTER TABLE platform_scans ADD COLUMN target text;
ALTER TABLE platform_scans ADD COLUMN finding_count integer;
ALTER TABLE platform_scans ADD CONSTRAINT platform_scans_unique_operation UNIQUE (operation_id, scanner);
