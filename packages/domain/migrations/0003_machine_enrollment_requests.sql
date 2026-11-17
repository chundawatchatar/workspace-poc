ALTER TABLE "machine_enrollments" ADD COLUMN "request_machine_id" text;--> statement-breakpoint
ALTER TABLE "machine_enrollments" ADD COLUMN "request_name" text;--> statement-breakpoint
ALTER TABLE "machine_enrollments" ADD COLUMN "requested_at" timestamp;