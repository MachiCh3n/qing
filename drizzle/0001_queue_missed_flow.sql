ALTER TABLE `tickets` ADD `queue_order` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `tickets` ADD `missed_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `tickets` ADD `missed_at` text;
--> statement-breakpoint
UPDATE `tickets` SET `queue_order` = rowid * 1000 WHERE `queue_order` = 0;
--> statement-breakpoint
CREATE INDEX `tickets_active_order_idx` ON `tickets` (`status`,`queue_order`);
