import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const tickets = sqliteTable("tickets", {
  id: text("id").primaryKey(),
  dateKey: text("date_key").notNull(),
  number: text("number").notNull(),
  storeId: text("store_id").notNull(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  status: text("status").notNull().default("waiting"),
  currentNumber: text("current_number").notNull().default("A000"),
  ahead: integer("ahead").notNull().default(0),
  estimatedMinutes: integer("estimated_minutes").notNull().default(25),
  estimatedEntryAt: text("estimated_entry_at").notNull(),
  joinedAt: text("joined_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  calledAt: text("called_at"),
  seatedAt: text("seated_at"),
  cancelledAt: text("cancelled_at"),
  reminderSentAt: text("reminder_sent_at"),
  reminderProvider: text("reminder_provider"),
  reminderProviderId: text("reminder_provider_id"),
  reminderError: text("reminder_error"),
  callMessageSentAt: text("call_message_sent_at"),
  callMessageProvider: text("call_message_provider"),
  callMessageError: text("call_message_error")
}, table => [
  uniqueIndex("tickets_date_number_unique").on(table.dateKey, table.number),
  index("tickets_status_joined_idx").on(table.status, table.joinedAt)
]);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const smsLogs = sqliteTable("sms_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticketId: text("ticket_id").notNull(),
  event: text("event").notNull(),
  recipient: text("recipient").notNull(),
  message: text("message").notNull(),
  provider: text("provider").notNull(),
  providerId: text("provider_id"),
  sentAt: text("sent_at").notNull()
}, table => [index("sms_logs_ticket_idx").on(table.ticketId, table.sentAt)]);
