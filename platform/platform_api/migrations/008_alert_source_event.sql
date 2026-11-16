ALTER TABLE platform_alerts ADD COLUMN source_event text;
ALTER TABLE platform_alerts ADD CONSTRAINT platform_alerts_unique_source UNIQUE (tenant_id, source_event);
