CREATE TABLE "machines" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_opened_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "machines_userId_machineId_idx" ON "machines" USING btree ("user_id","machine_id");--> statement-breakpoint
CREATE INDEX "machines_userId_idx" ON "machines" USING btree ("user_id");