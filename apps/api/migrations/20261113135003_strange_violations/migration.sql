CREATE TABLE `note_index` (
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`notebook_id` text NOT NULL,
	`note_id` text NOT NULL,
	`seq` integer NOT NULL,
	`stream` text NOT NULL,
	CONSTRAINT `note_index_pk` PRIMARY KEY(`stream`, `seq`)
);
