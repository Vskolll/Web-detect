# bot.py — простая воронка оплаты с чеками и автопривязкой кода
# python-telegram-bot v20+, aiohttp, python-dotenv
# Логика:
# /start → кнопка "Оплатить доступ" → реквизиты + кнопка "Загрузить чек"
# Пользователь присылает чек (фото/док) → уходит админу на подтверждение
# Админ жмет ✅ → генерится код, бот РЕГИСТРИРУЕТ код на Node (/api/register-code),
# сообщает код пользователю и админу. Далее фронт шлет отчеты с ?code=XXXXXX,
# а сервер по этому коду шлет фото именно этому пользователю.

import os
import re
import json
import secrets
import string
import logging
from dataclasses import dataclass
from typing import Optional
from datetime import datetime, timezone

from aiohttp import ClientSession, ClientTimeout, web
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
TIMEOUT = ClientTimeout(total=20)

@dataclass
class Config:
    token: str
    admin_secret: str
    api_base: str
    public_base: str
    admin_tid: int
    mode: str  # polling | webhook
    public_url: Optional[str]
    port: int

def env_int(name: str, default: int) -> int:
    v = os.getenv(name, "").strip()
    return int(v) if v.isdigit() else default

def get_cfg() -> Config:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    admin_secret = os.getenv("ADMIN_API_SECRET", "").strip()
    api_base = (os.getenv("API_BASE", "").strip() or "https://example-node.onrender.com").rstrip("/")
    public_base = (os.getenv("PUBLIC_BASE", "").strip() or "https://cick.one").rstrip("/")
    admin_tid = env_int("ADMIN_TELEGRAM_ID", 0)
    mode = (os.getenv("BOT_MODE", "polling").strip() or "polling").lower()
    public_url = os.getenv("PUBLIC_URL", os.getenv("RENDER_EXTERNAL_URL", "")).strip() or None
    port = env_int("PORT", 10000)

    if not token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is required")
    if not admin_secret:
        raise RuntimeError("ADMIN_API_SECRET is required (shared with Node server)")
    if not admin_tid:
        raise RuntimeError("ADMIN_TELEGRAM_ID is required (numeric)")

    return Config(
        token=token,
        admin_secret=admin_secret,
        api_base=api_base,
        public_base=public_base,
        admin_tid=admin_tid,
        mode=mode,
        public_url=public_url,
        port=port,
    )

CFG = get_cfg()

# ---------- УТИЛИТЫ ----------
def gen_bind_code(n: int = 6) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))

async def api_register_code(session: ClientSession, code: str, chat_id: int) -> dict:
    """POST /api/register-code {code, chatId} c админским секретом"""
    url = f"{CFG.api_base}/api/register-code"
    payload = {"code": code, "chatId": str(chat_id)}
    headers = {
        "Authorization": f"Bearer {CFG.admin_secret}",
        "Content-Type": "application/json",
    }
    async with session.post(url, json=payload, headers=headers, timeout=TIMEOUT) as r:
        text = await r.text()
        try:
            data = json.loads(text) if text.strip() else {}
        except Exception:
            data = {"raw": text}
        if not r.ok or not data.get("ok"):
            raise RuntimeError(f"register-code failed: HTTP {r.status} {text[:200]}")
        return data

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
        "Здесь ты оформляешь доступ. Нажми кнопку ниже, оплати и пришли чек — мы быстро проверим.",
        reply_markup=main_menu_kb(),
    )

async def ping(update: Update, _: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("pong")

async def buy_flow(update: Update, context: ContextTypes.DEFAULT_TYPE, is_callback: bool = False):
    text = (
        f"💳 *Оплата доступа*\n\n"
        f"Сумма: *{PAY_AMOUNT_RUB} ₽*\n"
        f"Карта: *{PAY_CARD}*\n\n"
        f"После оплаты нажми «📤 Загрузить чек» и прикрепи фото/скрин.\n"
        f"_Подтвердим вручную. Если что — напиши администратору._"
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
        await msg.reply_text("🧾 Чек получен. Ждём подтверждения администратора.")
    except Exception as e:
        log.exception("Ошибка пересылки чека админу: %s", e)
        await msg.reply_text("⚠️ Не удалось отправить чек админу. Попробуй ещё раз /buy")

async def callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    data = q.data or ""
    uid = q.from_user.id

    # Кнопка "Оплатить доступ"
    if data == "buy":
        # Разрешим нажимать кому угодно, это просто инфо
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

        # Генерим код и регистрируем его на Node
        code = gen_bind_code(6)
        try:
            async with ClientSession(timeout=TIMEOUT) as s:
                await api_register_code(s, code, target_id)
        except Exception as e:
            log.exception("register-code failed: %s", e)
            await q.message.reply_text(f"⚠️ Не удалось зарегистрировать код: {e}")
            return

        # Сообщаем пользователю
        try:
            await context.bot.send_message(
                chat_id=target_id,
                text=(
                    "✅ Оплата подтверждена!\n\n"
                    f"Твой персональный код: *{code}*\n"
                    "Передай его администратору (если ещё не передал) и используй ссылку на сайт с этим кодом.\n\n"
                    f"Пример: {CFG.public_base}/index.html?code={code}"
                ),
                parse_mode="Markdown"
            )
        except Exception as e:
            log.warning("notify user failed: %s", e)

        # Отметка в админском сообщении + подсказка
        try:
            if q.message and q.message.caption:
                await q.edit_message_caption((q.message.caption or "") + f"\n\n✅ Подтверждено. Код: {code}")
            else:
                await q.message.reply_text(f"✅ Подтверждено. Код: {code}")
            await context.bot.send_message(
                chat_id=CFG.admin_tid,
                text=(
                    f"🔗 Код *{code}* привязан к user_id *{target_id}*.\n"
                    f"Проверь: {CFG.api_base}/health\n"
                    f"Фронт: {CFG.public_base}/index.html?code={code}"
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
    app = Application.builder().token(CFG.token).build()

    # Команды
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("buy", buy_cmd))
    app.add_handler(CommandHandler("ping", ping))

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
