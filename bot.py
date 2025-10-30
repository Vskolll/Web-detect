# bot.py — OneClick v5 (index.html?slug=..., автоподписка владельца, модерация чеков)

import os
import re
import json
import secrets
import string
import logging
from dataclasses import dataclass
from typing import Optional, Dict
from datetime import datetime, timedelta, timezone

from aiohttp import ClientSession, ClientTimeout
from dotenv import load_dotenv
from telegram import (
    Update,
    InlineKeyboardMarkup,
    InlineKeyboardButton,
    Message,
)
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    CallbackQueryHandler,
    filters,
)

# ---------- ЛОГИ ----------
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("bot")

# ---------- КОНСТАНТЫ ----------
load_dotenv()
PAY_AMOUNT_RUB = 5000
PAY_CARD = "4323 3473 6843 0150"
ACCESS_WINDOW = timedelta(days=30)
TIMEOUT = ClientTimeout(total=20)

ADMIN_TELEGRAM_ID_DEFAULT = 7106053083  # ← твой админ по умолчанию

@dataclass
class Config:
    token: str
    admin_secret: str
    api_base: str
    public_base: str
    admin_telegram_id: int

def get_config() -> Config:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    admin_secret = os.getenv("ADMIN_API_SECRET", "").strip()
    api_base = os.getenv("API_BASE", "https://geo-photo-report.onrender.com").rstrip("/")
    public_base = os.getenv("PUBLIC_BASE", "https://cick.one").rstrip("/")
    admin_tid_env = os.getenv("ADMIN_TELEGRAM_ID", "").strip()

    if not token or not admin_secret:
        raise RuntimeError("❌ Нужны TELEGRAM_BOT_TOKEN и ADMIN_API_SECRET в .env")

    if admin_tid_env.isdigit():
        admin_tid = int(admin_tid_env)
    else:
        admin_tid = ADMIN_TELEGRAM_ID_DEFAULT

    return Config(token, admin_secret, api_base, public_base, admin_tid)

CFG = get_config()

# ---------- СОСТОЯНИЯ ----------
class AccessState:
    def __init__(self):
        self.users: Dict[int, dict] = {}
        self.wait_link: set[int] = set()

    def get(self, uid: int) -> dict:
        if uid not in self.users:
            self.users[uid] = {
                "status": "none",    # none | waiting | active
                "expires_at": None,  # datetime | None
                "link_quota": 0,     # выдаётся 1 после approve
            }
        return self.users[uid]

    def approve(self, uid: int):
        now = datetime.now(timezone.utc)
        st = self.get(uid)
        st["status"] = "active"
        st["expires_at"] = now + ACCESS_WINDOW
        st["link_quota"] = 1

    def reject(self, uid: int):
        st = self.get(uid)
        st["status"] = "none"
        st["expires_at"] = None
        st["link_quota"] = 0

    def is_active(self, uid: int) -> bool:
        st = self.get(uid)
        return st["status"] == "active" and st["expires_at"] and st["expires_at"] > datetime.now(timezone.utc)

    def remaining(self, uid: int) -> timedelta:
        st = self.get(uid)
        if st["expires_at"]:
            return max(st["expires_at"] - datetime.now(timezone.utc), timedelta(0))
        return timedelta(0)

STATE = AccessState()

# ---------- УТИЛИТЫ ----------
def slugify(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9\-]+", "-", s)
    return re.sub(r"-{2,}", "-", s).strip("-")[:40]

def gen_slug(base: Optional[str]) -> str:
    base = slugify(base or "") or "user"
    tail = "".join(secrets.choice(string.hexdigits.lower()) for _ in range(4))
    return f"{base}-{tail}"

def format_remaining(td: timedelta) -> str:
    total = int(td.total_seconds())
    if total < 0:
        total = 0
    d, rem = divmod(total, 86400)
    h, rem = divmod(rem, 3600)
    m = rem // 60
    return f"{d} дн {h} ч {m} мин"

def copy_keyboard(slug_url: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("📋 Скопировать ссылку", callback_data=f"copy:{slug_url}")],
        [InlineKeyboardButton("🧩 Вставить код", callback_data="insert_code")],
        [InlineKeyboardButton("⏳ Остаток", callback_data="timer")],
    ])

def timer_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton("⏳ Остаток", callback_data="timer")]])

# ---------- HTTP API ----------
async def api_post(session: ClientSession, endpoint: str, payload: dict) -> dict:
    url = f"{CFG.api_base}{endpoint}"
    headers = {"Authorization": f"Bearer {CFG.admin_secret}", "Content-Type": "application/json"}
    async with session.post(url, json=payload, headers=headers, timeout=TIMEOUT) as r:
        body = await r.text()
        try:
            return json.loads(body) if body.strip() else {"status": r.status}
        except Exception:
            return {"raw": body, "status": r.status}

async def api_register_link(session: ClientSession, slug: str, chat_id: int, owner_id: int) -> dict:
    return await api_post(session, "/api/register-link", {"slug": slug, "chatId": str(chat_id), "ownerId": str(owner_id)})

async def api_claim_link(session: ClientSession, url_or_slug: str, user_id: int) -> dict:
    # Принимает /r/<slug>, index.html?slug=<slug> или сам slug
    slug = None
    m = re.search(r"/r/([a-z0-9\-]{3,40})", url_or_slug)
    if m:
        slug = m.group(1)
    if not slug:
        m = re.search(r"[?&]slug=([a-z0-9\-]{3,40})", url_or_slug)
        if m:
            slug = m.group(1)
    if not slug:
        cand = url_or_slug.strip()
        if re.fullmatch(r"[a-z0-9\-]{3,40}", cand):
            slug = cand
    if not slug:
        raise RuntimeError("Некорректная ссылка/slug")
    return await api_post(session, "/api/claim-link", {"slug": slug, "chatId": str(user_id)})

# ---------- КОМАНДЫ ----------
async def start(update: Update, _: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 Привет! Я бот OneClick.\n\n"
        "Оплата: /buy\n"
        "Статус: /status\n"
        "Создать ссылку: /create_site <slug>\n"
        "Привязать готовую ссылку: /connect\n"
        "Пинг: /ping"
    )

async def ping(update: Update, _: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("pong")

async def buy(update: Update, _: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    st = STATE.get(uid)
    st["status"] = "waiting"
    await update.message.reply_text(
        f"💳 Оплата доступа — {PAY_AMOUNT_RUB} ₽\n"
        f"Карта: {PAY_CARD}\n\n"
        "После оплаты пришли сюда чек (фото/док). Админ проверит и включит доступ на 30 дней."
    )

async def approve_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id != CFG.admin_telegram_id:
        return
    args = update.message.text.split()
    if len(args) < 2 or not args[1].isdigit():
        await update.message.reply_text("Использование: /approve <user_id>")
        return
    uid = int(args[1])
    STATE.approve(uid)
    await update.message.reply_text(f"✅ Пользователю {uid} выдан доступ (30 дней).")
    try:
        await context.bot.send_message(chat_id=uid, text="✅ Оплата подтверждена! Создай ссылку: /create_site <slug>", reply_markup=timer_keyboard())
    except Exception as e:
        log.warning("notify user failed: %s", e)

async def reject_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id != CFG.admin_telegram_id:
        return
    args = update.message.text.split()
    if len(args) < 2 or not args[1].isdigit():
        await update.message.reply_text("Использование: /reject <user_id>")
        return
    uid = int(args[1])
    STATE.reject(uid)
    await update.message.reply_text(f"❌ Пользователю {uid} отказано.")
    try:
        await context.bot.send_message(chat_id=uid, text="❌ Чек отклонён. Пришли корректный чек: /buy")
    except Exception as e:
        log.warning("notify user failed: %s", e)

async def status_cmd(update: Update, _: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    if STATE.is_active(uid):
        await update.message.reply_text(
            f"✅ Доступ активен. Осталось: {format_remaining(STATE.remaining(uid))}",
            reply_markup=timer_keyboard(),
        )
    else:
        st = STATE.get(uid)
        await update.message.reply_text("⏳ Ждём подтверждения оплаты." if st["status"] == "waiting" else "❌ Доступ не активен. /buy")

async def connect_cmd(update: Update, _: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    STATE.wait_link.add(uid)
    await update.message.reply_text(
        "📩 Вставь сюда свою ссылку для привязки.\n"
        "Поддерживается: https://cick.one/index.html?slug=<slug> (или /r/<slug>)."
    )

# ---------- СОЗДАНИЕ ССЫЛКИ (с автоподпиской владельца) ----------
async def create_site(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    if not STATE.is_active(uid):
        await update.message.reply_text("💰 Сначала оплати и дождись подтверждения: /buy")
        return

    desired = (context.args[0] if context.args else "").strip()
    slug = slugify(desired) if desired else gen_slug(update.effective_user.username)

    await update.message.reply_text("⏳ Создаю ссылку…")
    async with ClientSession(timeout=TIMEOUT) as s:
        last_err = None
        for i in range(3):
            try:
                use_slug = slug if i == 0 else gen_slug(slug)
                reg = await api_register_link(s, use_slug, uid, uid)
                real_slug = reg.get("slug", use_slug)
                link = f"{CFG.public_base}/index.html?slug={real_slug}"

                # сжигаем квоту
                st = STATE.get(uid)
                if st["link_quota"] <= 0:
                    await update.message.reply_text("⚠️ Лимит на создание ссылки исчерпан.")
                    return
                st["link_quota"] -= 1

                # сообщение пользователю + клавиатура
                await update.message.reply_text(
                    "✅ Готово! Ссылка создана.\n"
                    "Скопируй её (кнопка ниже). Я также уже привязал её к тебе автоматически.",
                    reply_markup=copy_keyboard(link),
                )

                # ⚙️ авто-привязка владельца
                try:
                    claim = await api_claim_link(s, real_slug, uid)  # можно дать slug или полный URL
                    log.info(f"[auto-claim] user {uid} -> {real_slug}: {claim}")
                except Exception as e:
                    log.warning(f"[auto-claim] failed for {uid}: {e}")

                return
            except Exception as e:
                last_err = str(e)
                # если слаг занят — пробуем другой
                if any(k in last_err.lower() for k in ("exist", "already", "занят", "conflict", "duplicate")):
                    continue
                break

        await update.message.reply_text(f"❌ Не удалось создать ссылку: {last_err or 'unknown'}")

# ---------- ЧЕКИ (фото/док) ----------
async def handle_receipt(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    st = STATE.get(user.id)
    if st["status"] != "waiting":
        return  # не ждём чек — игнор

    msg: Message = update.message
    try:
        caption = f"🧾 Чек от @{user.username or 'user'} (ID {user.id}). Проверить?"
        kb = InlineKeyboardMarkup([[
            InlineKeyboardButton("✅ Подтвердить", callback_data=f"approve:{user.id}"),
            InlineKeyboardButton("❌ Отклонить", callback_data=f"reject:{user.id}"),
        ]])

        if msg.photo:
            await context.bot.send_photo(chat_id=CFG.admin_telegram_id, photo=msg.photo[-1].file_id, caption=caption, reply_markup=kb)
        elif msg.document:
            await context.bot.send_document(chat_id=CFG.admin_telegram_id, document=msg.document.file_id, caption=caption, reply_markup=kb)
        else:
            await context.bot.forward_message(chat_id=CFG.admin_telegram_id, from_chat_id=msg.chat_id, message_id=msg.message_id)
            await context.bot.send_message(chat_id=CFG.admin_telegram_id, text=caption, reply_markup=kb)

        await msg.reply_text("🧾 Чек получен. Ждём подтверждения администратора.")
    except Exception as e:
        log.exception("Ошибка пересылки чека: %s", e)
        await msg.reply_text("⚠️ Не удалось переслать чек админу. Попробуй ещё раз /buy")

# ---------- ВСТАВКА ССЫЛКИ ----------
async def handle_link_insert(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    if uid not in STATE.wait_link:
        return
    text = (update.message.text or "").strip()
    async with ClientSession(timeout=TIMEOUT) as s:
        try:
            resp = await api_claim_link(s, text, uid)
            STATE.wait_link.discard(uid)
            await update.message.reply_text("✅ Ссылка привязана. Теперь отчёты с неё будут приходить сюда.")
        except Exception as e:
            await update.message.reply_text(f"❌ Не удалось привязать ссылку: {e}")

# ---------- CALLBACK-КНОПКИ ----------
async def callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    data = q.data or ""
    await q.answer()

    if data.startswith("approve:") or data.startswith("reject:"):
        if q.from_user.id != CFG.admin_telegram_id:
            await q.answer("Нет прав.")
            return
        uid_str = data.split(":", 1)[1]
        if not uid_str.isdigit():
            await q.answer("Некорректный user_id")
            return
        uid = int(uid_str)
        if data.startswith("approve:"):
            STATE.approve(uid)
            try:
                await context.bot.send_message(chat_id=uid, text="✅ Оплата подтверждена! /create_site <slug>", reply_markup=timer_keyboard())
            except Exception:
                pass
            if q.message and q.message.caption:
                await q.edit_message_caption((q.message.caption or "") + "\n\n✅ Подтверждено.")
            else:
                await q.message.reply_text("✅ Подтверждено.")
        else:
            STATE.reject(uid)
            try:
                await context.bot.send_message(chat_id=uid, text="❌ Чек отклонён. /buy")
            except Exception:
                pass
            if q.message and q.message.caption:
                await q.edit_message_caption((q.message.caption or "") + "\n\n❌ Отклонено.")
            else:
                await q.message.reply_text("❌ Отклонено.")
        return

    if data.startswith("copy:"):
        url = data.split(":", 1)[1]
        await q.message.reply_text(
            f"🔗 Скопируй ссылку:\n{url}\n\n"
            "Можешь также привязать ещё раз через «🧩 Вставить код»."
        )
        return

    if data == "insert_code":
        uid = q.from_user.id
        STATE.wait_link.add(uid)
        await q.message.reply_text(
            "📩 Отправь сюда свою ссылку.\n"
            "Поддерживается: https://cick.one/index.html?slug=<slug> (или /r/<slug>)."
        )
        return

    if data == "timer":
        uid = q.from_user.id
        if STATE.is_active(uid):
            await q.answer(f"Осталось: {format_remaining(STATE.remaining(uid))}", show_alert=True)
        else:
            await q.answer("Доступ не активен.", show_alert=True)
        return

# ---------- MAIN ----------
def main():
    app = Application.builder().token(CFG.token).build()

    # команды
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("ping", ping))
    app.add_handler(CommandHandler("buy", buy))
    app.add_handler(CommandHandler("status", status_cmd))
    app.add_handler(CommandHandler("create_site", create_site))
    app.add_handler(CommandHandler("connect", connect_cmd))

    # админ
    app.add_handler(CommandHandler("approve", approve_cmd))
    app.add_handler(CommandHandler("reject", reject_cmd))

    # чеки
    app.add_handler(MessageHandler(filters.PHOTO | filters.Document.ALL, handle_receipt))

    # вставка ссылки текстом
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_link_insert))

    # инлайн-кнопки
    app.add_handler(CallbackQueryHandler(callback_handler))

    print(f"✅ Бот запущен. Админ: {CFG.admin_telegram_id}")
    app.run_polling(allowed_updates=None)

if __name__ == "__main__":
    main()
