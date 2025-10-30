-- ===== migrate.sql (новая схема code -> chat_id) =====

-- 1) Таблица привязок кода к Telegram chat_id
CREATE TABLE IF NOT EXISTS user_codes (
  code       TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 2) Индексы (ускоряют выборку по chat_id и created_at)
CREATE INDEX IF NOT EXISTS idx_user_codes_chat_id ON user_codes(chat_id);
CREATE INDEX IF NOT EXISTS idx_user_codes_created_at ON user_codes(created_at);

-- 3) Миграция данных со старой схемы, если она есть
--    Переносим всех получателей ссылок: slug -> code
INSERT OR IGNORE INTO user_codes (code, chat_id, created_at)
SELECT
  UPPER(slug)          AS code,
  CAST(chat_id AS TEXT) AS chat_id,
  COALESCE(added_at, strftime('%s','now')*1000) AS created_at
FROM link_recipients
WHERE slug IS NOT NULL
  AND chat_id IS NOT NULL;

-- 4) Дополняем владельцами ссылок (на случай, если не было записей в link_recipients)
INSERT OR IGNORE INTO user_codes (code, chat_id, created_at)
SELECT
  UPPER(slug)                               AS code,
  CAST(chat_id AS TEXT)                     AS chat_id,
  COALESCE(created_at, strftime('%s','now')*1000) AS created_at
FROM links
WHERE slug IS NOT NULL
  AND chat_id IS NOT NULL
  AND (disabled IS NULL OR disabled = 0);

-- ===== Необязательно: чистка старых таблиц =====
-- ВНИМАНИЕ: раскомментируй ТОЛЬКО когда убедишься, что всё перенеслось ОК.
-- DROP TABLE IF EXISTS link_recipients;
-- DROP TABLE IF EXISTS links;

-- Готово.
