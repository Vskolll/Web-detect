# bot.py — доступ по регистрации, выдача ссылки и срока, список в /admin
# Зависимости: python-telegram-bot >= 20, python-dotenv, aiohttp
# Установка: pip install python-telegram-bot==20.* python-dotenv aiohttp
# Запуск (polling): BOT_MODE=polling python bot.py
# На Render/сервере: выстави переменные:
#   TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_ID, ADMIN_API_SECRET, PUBLIC_BASE (например, https://cklick1link.com)
#   PORT (по умолчанию 10000) — на нём поднимется HTTP-сервер с /api/register-code
#
# Регистрация (как ты и хотел):
# curl -X POST "$PUBLIC_BASE/api/register-code" \
#  -H "Authorization: Bearer <ADMIN_API_SECRET>" \
#  -H "Content-Type: application/json" \
#  -d '{"code":"unkill","chatId":"1615766987"}'
#
# Поведение:
# /start  -> если есть запись (clients.user_id), показывает ссылку PUBLIC_BASE/{CODE} + сколько осталось
#          если нет — пишет, что не зарегистрирован (обращаться к админу).
# /status -> дублирует инфу по подписке (есть/нет, дата окончания, дни)
# /admin  -> ТОЛЬКО админ: таблица (код, user, до даты, осталось дней), отсортировано по сроку. Пагинация через аргумент: /admin 2 (вторая страница)
#
# HTTP API:
#   POST /api/register-code  (Authorization: Bearer <ADMIN_API_SECRET>)
#     body: { "code": "<str>", "chatId": "<int|string>", "days": <int optional, default 30> }
#     Правило: если у пользователя активная подписка — продлеваем от текущего expires_at; иначе — от now.
#     Возврат: { ok:true, code:"CODE", chatId:"...", expires_at:<unix> }
#
#   GET  /api/status?chatId=...  (Authorization: Bearer <ADMIN_API_SECRET>)
#     Возврат: { ok:true, exists:bool, code, expires_at, days_left }
#
# Хранилище: ./data/clients.db

import os
import json
import time
import sqlite3
import logging
import secrets
import asyncio
import threading
from dataclasses import dataclass
from typing import Optional, Tuple
from datetime import datetime, timezone

from dotenv import load_dotenv
from aiohttp import web
from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import (
    Application, CommandHandler, ContextTypes, MessageHandler,
    CallbackQueryHandler, filters
)

# ---------- ЛОГИ ----------
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("bot")

# ---------- КОНФИГ ----------
load_dotenv()

def _env_int(name: str, default: int) -> int:
    v = (os.getenv(name) or "").strip()
    try:
        return int(v)
    except Exception:
        return default

@dataclass
class Config:
    token: str
    admin_tid: int
    mode: str         # polling | webhook (polling по умолчанию)
    public_base: str  # напр. https://cklick1link.com
    port: int         # порт для HTTP API
    http_enabled: bool
    db_path: str      # путь к SQLite
    admin_api_secret: str

def load_cfg() -> Config:
    token = (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
    if not token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is required")

    admin_tid = _env_int("ADMIN_TELEGRAM_ID", 0)
    if not admin_tid:
        raise RuntimeError("ADMIN_TELEGRAM_ID is required (numeric)")

    mode = (os.getenv("BOT_MODE", "polling") or "polling").strip().lower()
    public_base = (os.getenv("PUBLIC_BASE") or os.getenv("RENDER_EXTERNAL_URL") or "").strip()
    port = _env_int("PORT", 10000)
    http_enabled = (os.getenv("BOT_HTTP_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"})
    db_path = (os.getenv("USERS_DB_PATH") or "data/clients.db").strip()
    admin_api_secret = (os.getenv("ADMIN_API_SECRET") or "").strip()
    if not admin_api_secret:
        raise RuntimeError("ADMIN_API_SECRET is required for /api/register-code")

    return Config(
        token=token,
        admin_tid=admin_tid,
        mode=mode,
        public_base=public_base,
        port=port,
        http_enabled=http_enabled,
        db_path=db_path,
        admin_api_secret=admin_api_secret,
    )

CFG = load_cfg()

# ---------- БАЗА ДАННЫХ ----------
def db_init():
    os.makedirs(os.path.dirname(CFG.db_path) or ".", exist_ok=True)
    with sqlite3.connect(CFG.db_path) as con:
        con.execute("""
        CREATE TABLE IF NOT EXISTS clients (
            user_id    INTEGER PRIMARY KEY,
            code       TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_clients_exp ON clients(expires_at)")
        con.commit()

def _now_unix() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())

def db_get_client(user_id: int) -> Optional[Tuple[int, str, int]]:
    with sqlite3.connect(CFG.db_path) as con:
        cur = con.execute("SELECT user_id, code, expires_at FROM clients WHERE user_id = ?", (user_id,))
        row = cur.fetchone()
        if not row:
            return None
        return int(row[0]), str(row[1]), int(row[2])

def db_set_or_extend(user_id: int, code_upper: str, delta_days: int = 30) -> int:
    """Если активна — продлеваем от текущего expires_at, иначе — от now. Возвращает новый expires_at."""
    now = _now_unix()
    with sqlite3.connect(CFG.db_path) as con:
        cur = con.execute("SELECT expires_at FROM clients WHERE user_id = ?", (user_id,))
        row = cur.fetchone()
        if row:
            current = int(row[0])
            base = current if current > now else now
            new_exp = base + delta_days * 86400
            con.execute(
                "UPDATE clients SET code = ?, expires_at = ?, updated_at = ? WHERE user_id = ?",
                (code_upper, new_exp, now, user_id)
            )
        else:
            new_exp = now + delta_days * 86400
            con.execute(
                "INSERT INTO clients (user_id, code, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (user_id, code_upper, new_exp, now, now)
            )
        con.commit()
        return new_exp

def db_list_clients(limit: int = 50, offset: int = 0):
    with sqlite3.connect(CFG.db_path) as con:
        cur = con.execute("""
            SELECT user_id, code, expires_at
            FROM clients
            ORDER BY expires_at ASC
            LIMIT ? OFFSET ?
        """, (limit, offset))
        return [(int(r[0]), str(r[1]), int(r[2])) for r in cur.fetchall()]

# ---------- УТИЛИТЫ ----------
def fmt_dt(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

def days_left(ts: int) -> int:
    n = _now_unix()
    return max(0, (ts - n) // 86400)

def link_for_code(code: str) -> Optional[str]:
    base = CFG.public_base.rstrip("/") if CFG.public_base else ""
    if not base:
        return None
    return f"{base}/{code}"

def chunk_rows(rows, n):
    buf = []
    for r in rows:
        buf.append(r)
        if len(buf) == n:
            yield buf
            buf = []
    if buf:
        yield buf

# ---------- TELEGRAM ХЕНДЛЕРЫ ----------
async def cmd_start(update: Update, _: ContextTypes.DEFAULT_TYPE):
    if not update.effective_user:
        return
    uid = update.effective_user.id
    rec = db_get_client(uid)

    if not rec:
        await update.message.reply_text(
            "🔒 Ты ещё не зарегистрирован.\n"
            "Напиши админу, чтобы он добавил тебя (регистрация через /api/register-code)."
        )
        return

    _, code, exp = rec
    left = days_left(exp)
    link = link_for_code(code)
    if link:
        await update.message.reply_text(
            "✅ У тебя активирован доступ.\n\n"
            f"🔗 Ссылка: {link}\n"
            f"🆔 Код: {code}\n"
            f"⏳ Действует до: *{fmt_dt(exp)}*  (осталось *{left}* дн.)",
            parse_mode="Markdown"
        )
    else:
        await update.message.reply_text(
            "✅ У тебя активирован доступ.\n\n"
            f"🆔 Код: *{code}*\n"
            f"⏳ Действует до: *{fmt_dt(exp)}*  (осталось *{left}* дн.)\n\n"
            "_(PUBLIC_BASE не задан — ссылку собрать нельзя)_",
            parse_mode="Markdown"
        )

async def cmd_status(update: Update, _: ContextTypes.DEFAULT_TYPE):
    if not update.effective_user:
        return
    uid = update.effective_user.id
    rec = db_get_client(uid)
    if not rec:
        await update.message.reply_text("🔒 Нет активной подписки. Обратитесь к админу.")
        return
    _, code, exp = rec
    left = days_left(exp)
    link = link_for_code(code)
    txt = [
        "🔐 *Статус доступа*",
        f"Код: *{code}*",
        f"До: *{fmt_dt(exp)}*",
        f"Осталось: *{left}* дн."
    ]
    if link:
        txt.insert(1, f"Ссылка: {link}")
    await update.message.reply_text("\n".join(txt), parse_mode="Markdown")

async def cmd_admin(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.effective_user:
        return
    uid = update.effective_user.id
    if uid != CFG.admin_tid:
        await update.message.reply_text("⛔ Нет прав.")
        return

    # Пагинация: /admin <page>, страница с 1
    page = 1
    if context.args and len(context.args) >= 1:
        try:
            page = max(1, int(context.args[0]))
        except Exception:
            page = 1

    PAGE_SIZE = 30
    offset = (page - 1) * PAGE_SIZE
    rows = db_list_clients(limit=PAGE_SIZE, offset=offset)

    if not rows:
        await update.message.reply_text(f"Пусто (страница {page}).")
        return

    lines = [f"📋 Зарегистрированные (стр. {page}) — ближайшие сверху:"]
    for user_id, code, exp in rows:
        left = days_left(exp)
        lines.append(f"• {code} — user_id {user_id} — до {fmt_dt(exp)} — осталось {left} дн.")
    await update.message.reply_text("\n".join(lines))

# ---------- HTTP API (aiohttp) ----------
# Лёгкий сервер для регистрации / статуса под твою curl-схему
async def _auth_ok(request: web.Request) -> bool:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return False
    token = auth.split(" ", 1)[1].strip()
    return token == CFG.admin_api_secret

async def api_register_code(request: web.Request):
    if not await _auth_ok(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    try:
        data = await request.json()
        code = str(data.get("code", "")).strip()
        chat_id_raw = str(data.get("chatId", "")).strip()
        days = int(data.get("days", 30))
        if not code or not chat_id_raw:
            return web.json_response({"ok": False, "error": "code/chatId required"}, status=400)
        # chatId может прийти строкой — приведём к int
        try:
            user_id = int(chat_id_raw)
        except Exception:
            return web.json_response({"ok": False, "error": "chatId must be integer"}, status=400)

        code_up = code.upper()
        new_exp = db_set_or_extend(user_id, code_up, delta_days=days)
        return web.json_response({"ok": True, "code": code_up, "chatId": str(user_id), "expires_at": new_exp})
    except Exception as e:
        log.exception("api_register_code error: %s", e)
        return web.json_response({"ok": False, "error": str(e)}, status=500)

async def api_status(request: web.Request):
    if not await _auth_ok(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    chat_id_raw = request.query.get("chatId", "") or ""
    if not chat_id_raw:
        return web.json_response({"ok": False, "error": "chatId required"}, status=400)
    try:
        user_id = int(chat_id_raw)
    except Exception:
        return web.json_response({"ok": False, "error": "chatId must be integer"}, status=400)

    rec = db_get_client(user_id)
    if not rec:
        return web.json_response({"ok": True, "exists": False, "chatId": str(user_id)})
    _, code, exp = rec
    return web.json_response({
        "ok": True,
        "exists": True,
        "chatId": str(user_id),
        "code": code,
        "expires_at": exp,
        "days_left": days_left(exp),
    })

def start_http_server_in_thread():
    """Поднимаем aiohttp-сервер в отдельном потоке, чтобы не мешал run_polling()."""
    app = web.Application()
    app.add_routes([
        web.post("/api/register-code", api_register_code),
        web.get("/api/status", api_status),
        web.get("/health", lambda _: web.json_response({"ok": True, "mode": os.getenv("BOT_MODE", "polling")})),
    ])

    def _run():
        # web.run_app блокирующий — поэтому в отдельном потоке
        web.run_app(app, host="0.0.0.0", port=CFG.port, handle_signals=False)

    th = threading.Thread(target=_run, daemon=True)
    th.start()
    log.info(f"[http] started on 0.0.0.0:{CFG.port}")

# ---------- MAIN ----------
def make_telegram_app() -> Application:
    db_init()
    app = Application.builder().token(CFG.token).build()

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("admin", cmd_admin))

    return app

def main():
    # HTTP API (в этом проекте обычно не нужен: основной API обслуживает Node server/index.js)
    if CFG.http_enabled:
        start_http_server_in_thread()
    else:
        log.info("[http] disabled (set BOT_HTTP_ENABLED=1 to enable)")

    # Telegram
    tg = make_telegram_app()
    # Python 3.14: создаём loop явно перед run_polling()/run_webhook()
    asyncio.set_event_loop(asyncio.new_event_loop())
    if CFG.mode == "webhook":
        # Webhook-режим (если захочешь) — адресом будет PUBLIC_BASE + секретный путь
        if not CFG.public_base:
            raise RuntimeError("PUBLIC_BASE обязателен для webhook")
        secret_path = f"/tg/webhook/{secrets.token_hex(16)}"
        url = f"{CFG.public_base.rstrip('/')}{secret_path}"
        log.info(f"[webhook] {url}")
        tg.run_webhook(
            listen="0.0.0.0",
            port=CFG.port,              # тот же порт: aiohttp уже слушает; чтобы не конфликтовало — для webhook лучше отдельный процесс
            url_path=secret_path,
            webhook_url=url,
            drop_pending_updates=True,
            allowed_updates=None,
        )
    else:
        log.info("[polling] bot started")
        tg.run_polling(allowed_updates=None)

if __name__ == "__main__":
    main()
