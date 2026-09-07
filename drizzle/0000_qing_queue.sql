CREATE TABLE `tickets` (
  `id` text PRIMARY KEY NOT NULL,
  `date_key` text NOT NULL,
  `number` text NOT NULL,
  `store_id` text NOT NULL,
  `name` text NOT NULL,
  `phone` text NOT NULL,
  `status` text DEFAULT 'waiting' NOT NULL,
  `current_number` text DEFAULT 'A000' NOT NULL,
  `ahead` integer DEFAULT 0 NOT NULL,
  `estimated_minutes` integer DEFAULT 25 NOT NULL,
  `estimated_entry_at` text NOT NULL,
  `joined_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `called_at` text,
  `seated_at` text,
  `cancelled_at` text,
  `reminder_sent_at` text,
  `reminder_provider` text,
  `reminder_provider_id` text,
  `reminder_error` text,
  `call_message_sent_at` text,
  `call_message_provider` text,
  `call_message_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_date_number_unique` ON `tickets` (`date_key`,`number`);
--> statement-breakpoint
CREATE INDEX `tickets_status_joined_idx` ON `tickets` (`status`,`joined_at`);
--> statement-breakpoint
CREATE TABLE `settings` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sms_logs` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `ticket_id` text NOT NULL,
  `event` text NOT NULL,
  `recipient` text NOT NULL,
  `message` text NOT NULL,
  `provider` text NOT NULL,
  `provider_id` text,
  `sent_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sms_logs_ticket_idx` ON `sms_logs` (`ticket_id`,`sent_at`);
