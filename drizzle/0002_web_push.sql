CREATE TABLE `push_subscriptions` (
  `ticket_id` text NOT NULL,
  `endpoint` text NOT NULL,
  `p256dh` text NOT NULL,
  `auth` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`ticket_id`, `endpoint`)
);
--> statement-breakpoint
CREATE INDEX `push_subscriptions_ticket_idx` ON `push_subscriptions` (`ticket_id`);
--> statement-breakpoint
CREATE TABLE `push_logs` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `ticket_id` text NOT NULL,
  `endpoint` text NOT NULL,
  `status_code` integer NOT NULL,
  `sent_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `push_logs_ticket_idx` ON `push_logs` (`ticket_id`,`sent_at`);
