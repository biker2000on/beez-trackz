CREATE TABLE "oidc_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"display_name" text,
	"email" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_login_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_identities_issuer_subject" UNIQUE("issuer","subject")
);
--> statement-breakpoint
ALTER TABLE "user_settings" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" DROP COLUMN "oidc_subject";--> statement-breakpoint
ALTER TABLE "user_settings" DROP COLUMN "oidc_issuer";