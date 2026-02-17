-- Add output_schema column to tasks for structured output support
-- Stores a JSON Schema that the SDK uses as outputFormat to produce validated structured output
ALTER TABLE "tasks" ADD COLUMN "output_schema" jsonb;
