CREATE TABLE "machine_enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "machine_enrollments" ADD CONSTRAINT "machine_enrollments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "machine_enrollments_keyHash_idx" ON "machine_enrollments" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "machine_enrollments_userId_idx" ON "machine_enrollments" USING btree ("user_id");