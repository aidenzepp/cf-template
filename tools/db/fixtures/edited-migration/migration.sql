CREATE TABLE `note_quota` (
	`max` integer NOT NULL,
	`owner_id` text PRIMARY KEY,
	`used` integer NOT NULL,
	CONSTRAINT "note_quota_used_le_max" CHECK("used" <= "max")
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`body` text NOT NULL DEFAULT '',
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`updated_at` integer NOT NULL
);
