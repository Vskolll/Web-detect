# bot.py — простая воронка оплаты с ручным подтверждением и 30-дневным доступом
# python-telegram-bot v20+, python-dotenv, стандартная sqlite3
# Логика:
# /start → кнопка "Оплатить доступ" → реквизиты + кнопка "Загрузить чек"
# Пользователь присылает чек (фото/док) → уходит админу на подтверждение
# Админ жмет ✅ → в БД записывается срок действия на 30 дней (если доступ активен — продление от текущего окончания)
# Пользователь может посмотреть /status. Никаких ссылок и кодов бот не создает.

import os
import re
import json
import secrets
import string
import logging
import sqlite3
from dataclasses import dataclass
from typing import Optional, Tuple
from datetime import datetime, timezone, timedelta

from aiohttp import web
from dotenv import load_dotenv
from telegram import (
    Update, InlineKeyboardMarkup, InlineKeyboardButton, Message, ReplyKeyboardRemove
)
from telegram.ext import (
    Application, CommandHandler, ContextTypes, MessageHandler,
    CallbackQueryHandler, filters
)

# ---------- ЛОГИ ----------
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("bot")

# ---------- КОНФИГ ----------
load_dotenv()
PAY_AMOUNT_RUB = int(os.getenv("PAY_AMOUNT_RUB", "5000"))
PAY_CARD = os.getenv("PAY_CARD", "4323 3473 6843 0150")

@dataclass
class Config:
    token: str
    admin_tid: int
    mode: str  # polling | webhook
    public_url: Optional[str]
    port: int
    db_path: str

def env_int(name: str, default: int) -> int:
    v = os.getenv(name, "").strip()
    return int(v) if v.isdigit() else default

def get_cfg() -> Config:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    admin_tid = env_int("ADMIN_TELEGRAM_ID", 0)
    mode = (os.getenv("BOT_MODE", "polling").strip() or "polling").lower()
    public_url = os.getenv("PUBLIC_URL", os.getenv("RENDER_EXTERNAL_URL", "")).strip() or None
    port = env_int("PORT", 10000)
    db_path = os.getenv("USERS_DB_PATH", "data.db").strip()

    if not token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is required")
    if not admin_tid:
        raise RuntimeError("ADMIN_TELEGRAM_ID is required (numeric)")

    return Config(
        token=token,
        admin_tid=admin_tid,
        mode=mode,
        public_url=public_url,
        port=port,
        db_path=db_path,
    )

CFG = get_cfg()

# ---------- ХРАНИЛИЩЕ (SQLite) ----------
def db_init():
    os.makedirs(os.path.dirname(CFG.db_path) or ".", exist_ok=True)
    with sqlite3.connect(CFG.db_path) as con:
        con.execute("""
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            expires_at INTEGER,      -- unix timestamp (UTC)
            created_at INTEGER       -- unix timestamp (UTC)
        )
        """)
        con.commit()

def db_get_expiry(user_id: int) -> Optional[int]:
    with sqlite3.connect(CFG.db_path) as con:
        cur = con.execute("SELECT expires_at FROM users WHERE user_id = ?", (user_id,))
        row = cur.fetchone()
        return row[0] if row and row[0] is not None else None

def db_set_or_extend(user_id: int, delta_days: int = 30) -> int:
    """
    Если у пользователя уже есть активный доступ в будущем — продлеваем от текущей даты окончания.
    Если нет или просрочен — выставляем от текущего времени.
    Возвращает новый expires_at (unix).
    """
    now = int(datetime.now(timezone.utc).timestamp())
    current = db_get_expiry(user_id)
    base = current if (current and current > now) else now
    new_exp = base + delta_days * 24 * 60 * 60

    with sqlite3.connect(CFG.db_path) as con:
        if current is None:
            con.execute(
                "INSERT INTO users (user_id, expires_at, created_at) VALUES (?, ?, ?)",
                (user_id, new_exp, now)
            )
        else:
            con.execute(
                "UPDATE users SET expires_at = ? WHERE user_id = ?",
                (new_exp, user_id)
            )
        con.commit()
    return new_exp

# ---------- УТИЛИТЫ ----------
def format_dt_utc(ts_unix: int) -> str:
    dt = datetime.fromtimestamp(ts_unix, tz=timezone.utc)
    # Выводим локально понятную дату (UTC метка + ISO)
    return dt.strftime("%Y-%m-%d %H:%M UTC")

def days_left(ts_unix: int) -> int:
    now = int(datetime.now(timezone.utc).timestamp())
    if ts_unix <= now:
        return 0
    return (ts_unix - now) // (24 * 60 * 60)

def main_menu_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton("💳 Оплатить доступ", callback_data="buy")]]
    )

def after_buy_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton("📤 Загрузить чек", callback_data="upload")]]
    )

def approve_kb(user_id: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[
            InlineKeyboardButton("✅ Подтвердить", callback_data=f"approve:{user_id}"),
            InlineKeyboardButton("❌ Отклонить", callback_data=f"reject:{user_id}"),
        ]]
    )

# ---------- ХЕНДЛЕРЫ ----------
async def start(update: Update, _: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 Привет!\n\n"
        "Здесь ты оформляешь доступ. Нажми кнопку ниже, оплати и пришли чек — мы быстро проверим.\n\n"
        "Команда /status — покажет, до какой даты активен доступ.",
        reply_markup=main_menu_kb(),
    )

async def ping(update: Update, _: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("pong")

async def status_cmd(update: Update, _: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    exp = db_get_expiry(user.id)
    if not exp:
        await update.message.reply_text("🔒 Доступ не активирован. Оформи оплату и пришли чек. /buy")
        return
    left = days_left(exp)
    await update.message.reply_text(
        f"🔐 Доступ активен до: *{format_dt_utc(exp)}*  \n"
        f"Осталось: *{left}* дн.",
        parse_mode="Markdown"
    )

async def buy_flow(update: Update, context: ContextTypes.DEFAULT_TYPE, is_callback: bool = False):
    text = (
        f"💳 *Оплата доступа*\n\n"
        f"Сумма: *{PAY_AMOUNT_RUB} ₽*\n"
        f"Карта: *{PAY_CARD}*\n\n"
        f"После оплаты нажми «📤 Загрузить чек» и прикрепи фото/скрин.\n"
        f"_Подтвердим вручную. Для проверки статуса: /status_"
    )
    parse = "Markdown"
    if is_callback and update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.reply_text(text, parse_mode=parse, reply_markup=after_buy_kb())
    else:
        await update.message.reply_text(text, parse_mode=parse, reply_markup=after_buy_kb())

async def buy_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await buy_flow(update, context, is_callback=False)

async def on_upload_click(update: Update, _: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    await q.message.reply_text(
        "📤 Пришли сюда *фото* или *файл* с чеком. Мы проверим и ответим.",
        parse_mode="Markdown",
        reply_markup=ReplyKeyboardRemove()
    )

async def handle_receipt(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Ловим любой чек (фото/док) и пересылаем админу с кнопками."""
    user = update.effective_user
    msg: Message = update.message
    caption = f"🧾 Чек от @{user.username or 'user'} (ID {user.id}). Проверить?"
    kb = approve_kb(user.id)

    try:
        if msg.photo:
            # Берём самое большое фото
            await context.bot.send_photo(
                chat_id=CFG.admin_tid,
                photo=msg.photo[-1].file_id,
                caption=caption,
                reply_markup=kb
            )
        elif msg.document:
            await context.bot.send_document(
                chat_id=CFG.admin_tid,
                document=msg.document.file_id,
                caption=caption,
                reply_markup=kb
            )
        else:
            # На всякий — просто форвард
            await context.bot.forward_message(
                chat_id=CFG.admin_tid,
                from_chat_id=msg.chat_id,
                message_id=msg.message_id
            )
            await context.bot.send_message(chat_id=CFG.admin_tid, text=caption, reply_markup=kb)
        await msg.reply_text("🧾 Чек получен. Ждём подтверждения администратора. /status")
    except Exception as e:
        log.exception("Ошибка пересылки чека админу: %s", e)
        await msg.reply_text("⚠️ Не удалось отправить чек админу. Попробуй ещё раз /buy")

async def callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    data = q.data or ""
    uid = q.from_user.id

    # Кнопка "Оплатить доступ"
    if data == "buy":
        await buy_flow(update, context, is_callback=True)
        return

    if data == "upload":
        await on_upload_click(update, context)
        return

    # Подтверждение/отклонение — только у админа
    if (data.startswith("approve:") or data.startswith("reject:")) and uid != CFG.admin_tid:
        await q.answer("Нет прав.", show_alert=True)
        return

    if data.startswith("approve:"):
        await q.answer()
        target_id_str = data.split(":", 1)[1]
        if not target_id_str.isdigit():
            await q.message.reply_text("❌ Некорректный user_id")
            return
        target_id = int(target_id_str)

        try:
            new_exp = db_set_or_extend(target_id, delta_days=30)
        except Exception as e:
            log.exception("DB set/extend failed: %s", e)
            await q.message.reply_text(f"⚠️ Не удалось активировать доступ: {e}")
            return

        # Сообщаем пользователю
        try:
            left = days_left(new_exp)
            await context.bot.send_message(
                chat_id=target_id,
                text=(
                    "✅ Оплата подтверждена!\n\n"
                    f"🔐 Доступ активен до: *{format_dt_utc(new_exp)}*\n"
                    f"Осталось: *{left}* дн.\n\n"
                    "Проверить статус: /status"
                ),
                parse_mode="Markdown"
            )
        except Exception as e:
            log.warning("notify user failed: %s", e)

        # Отметка в админском сообщении + подсказка
        try:
            note = f"\n\n✅ Подтверждено. Доступ до {format_dt_utc(new_exp)}"
            if q.message and q.message.caption:
                await q.edit_message_caption((q.message.caption or "") + note)
            else:
                await q.message.reply_text("✅ Подтверждено." + note)
            await context.bot.send_message(
                chat_id=CFG.admin_tid,
                text=(
                    f"👤 user_id *{target_id}* активирован/продлён до *{format_dt_utc(new_exp)}*.\n"
                    "Без ссылок: пользователь сам их получит и использует в нужном месте."
                ),
                parse_mode="Markdown"
            )
        except Exception:
            pass
        return

    if data.startswith("reject:"):
        await q.answer()
        target_id_str = data.split(":", 1)[1]
        if not target_id_str.isdigit():
            await q.message.reply_text("❌ Некорректный user_id")
            return
        target_id = int(target_id_str)

        try:
            await context.bot.send_message(chat_id=target_id, text="❌ Чек отклонён. Попробуй ещё раз. /buy")
        except Exception:
            pass
        try:
            if q.message and q.message.caption:
                await q.edit_message_caption((q.message.caption or "") + "\n\n❌ Отклонено.")
            else:
                await q.message.reply_text("❌ Отклонено.")
        except Exception:
            pass
        return

# ---------- HEALTH (для webhook-режима при желании) ----------
async def _health(_: web.Request):
    return web.json_response({"ok": True, "mode": os.getenv("BOT_MODE", "polling")})

# ---------- MAIN ----------
def make_application() -> Application:
    db_init()

    app = Application.builder().token(CFG.token).build()

    # Команды
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("buy", buy_cmd))
    app.add_handler(CommandHandler("ping", ping))
    app.add_handler(CommandHandler("status", status_cmd))

    # Клики по инлайн-кнопкам
    app.add_handler(CallbackQueryHandler(callback_handler))

    # Чеки: фото/док
    app.add_handler(MessageHandler(filters.PHOTO | filters.Document.ALL, handle_receipt))

    return app

def main():
    application = make_application()

    if CFG.mode == "webhook":
        # Webhook режим (нужен PUBLIC_URL)
        if not CFG.public_url:
            raise RuntimeError("PUBLIC_URL (или RENDER_EXTERNAL_URL) обязателен для webhook")
        path_secret = secrets.token_hex(16)
        hook_path = f"/tg/webhook/{path_secret}"
        log.info(f"[webhook] {CFG.public_url}{hook_path}  port={CFG.port}")
        application.run_webhook(
            listen="0.0.0.0",
            port=CFG.port,
            url_path=hook_path,
            webhook_url=f"{CFG.public_url}{hook_path}",
            allowed_updates=None,
            drop_pending_updates=True,
        )
        # Если хочешь полноценный /health — нужно поднимать aiohttp-сервер отдельно.
    else:
        # Простой и надёжный режим для Render — polling
        log.info("[polling] bot started")
        application.run_polling(allowed_updates=None)

if __name__ == "__main__":
    main()
