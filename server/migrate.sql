-- создаём таблицу получателей (многие-к-одной ссылке)
CREATE TABLE IF NOT EXISTS link_recipients (
  slug     TEXT NOT NULL,
  chat_id  TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (slug, chat_id)
);

-- переносим текущих владельцев ссылок как первых получателей
INSERT OR IGNORE INTO link_recipients(slug, chat_id, added_at)
SELECT slug, chat_id, strftime('%s','now')*1000 FROM links WHERE disabled = 0;
