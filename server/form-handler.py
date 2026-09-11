#!/usr/bin/env python3
"""Приём заявок с welding66.ru и отправка их письмом через SMTP.

Только стандартная библиотека — на сервере ничего доустанавливать не нужно.
Слушает 127.0.0.1, наружу торчит через nginx (см. nginx.conf.snippet).
Доступы берутся из окружения, в репозитории их быть не должно.
"""

import base64
import json
import os
import re
import smtplib
import ssl
import sys
import time
from collections import deque
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("BIND_HOST", "127.0.0.1")
PORT = int(os.environ.get("BIND_PORT", "8081"))

SMTP_HOST = os.environ.get("SMTP_HOST", "mail.hosting.reg.ru")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
MAIL_TO = os.environ.get("MAIL_TO", SMTP_USER)

MAX_FIELD = 2000
MAX_BODY = 8192
RATE_WINDOW = 600
RATE_LIMIT = 5

_hits = {}


def _clean(value, limit=MAX_FIELD):
    """Схлопывает управляющие символы: они не нужны в письме и опасны в заголовках."""
    text = str(value or "")[:limit]
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text).strip()


def _one_line(value, limit=200):
    return re.sub(r"\s+", " ", _clean(value, limit))


def _rate_ok(ip):
    now = time.time()
    seen = _hits.setdefault(ip, deque())
    while seen and now - seen[0] > RATE_WINDOW:
        seen.popleft()
    if len(seen) >= RATE_LIMIT:
        return False
    seen.append(now)
    if len(_hits) > 5000:
        _hits.clear()
    return True


def check_credentials():
    """Возвращает текст проблемы с доступами или None, если всё в порядке."""
    if not SMTP_USER or not SMTP_PASS:
        return "SMTP_USER/SMTP_PASS не заданы в /etc/welding66/form.env"
    return None


def _is_ascii(value):
    try:
        value.encode("ascii")
        return True
    except UnicodeEncodeError:
        return False


def _login(smtp):
    """Авторизация, переживающая нелатинские пароли.

    smtplib кодирует логин и пароль в ASCII и падает на кириллице, хотя
    SASL PLAIN по RFC 4616 — это UTF-8. Поэтому в таком случае отправляем
    команду AUTH сами.
    """
    if _is_ascii(SMTP_USER) and _is_ascii(SMTP_PASS):
        smtp.login(SMTP_USER, SMTP_PASS)
        return

    smtp.ehlo_or_helo_if_needed()
    if not smtp.has_extn("auth"):
        raise smtplib.SMTPNotSupportedError("сервер не предлагает AUTH")

    token = base64.b64encode(f"\0{SMTP_USER}\0{SMTP_PASS}".encode("utf-8")).decode("ascii")
    code, resp = smtp.docmd("AUTH", "PLAIN " + token)
    if code not in (235, 503):
        raise smtplib.SMTPAuthenticationError(code, resp)


def send_mail(name, tel, task):
    problem = check_credentials()
    if problem:
        raise RuntimeError(problem)

    msg = EmailMessage()
    # Имя попадает в тему, поэтому переводы строк из него уже вырезаны — иначе
    # можно было бы дописать произвольные заголовки.
    msg["Subject"] = f"Заявка с сайта — {name or 'без имени'}"
    msg["From"] = SMTP_USER
    msg["To"] = MAIL_TO
    msg.set_content(
        f"Имя: {name or '—'}\n"
        f"Телефон: {tel}\n\n"
        f"Что нужно сварить:\n{task or '—'}\n\n"
        f"— отправлено формой на welding66.ru\n"
    )

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context, timeout=20) as smtp:
        _login(smtp)
        smtp.send_message(msg)


class Handler(BaseHTTPRequestHandler):
    server_version = "w66form"
    sys_version = ""

    def _reply(self, code, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        if self.path.rstrip("/") not in ("/api/request", "/request"):
            return self._reply(404, {"ok": False, "error": "not found"})

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._reply(400, {"ok": False, "error": "bad length"})
        if length <= 0 or length > MAX_BODY:
            return self._reply(400, {"ok": False, "error": "bad length"})

        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError
        except Exception:
            return self._reply(400, {"ok": False, "error": "bad json"})

        # Скрытое поле, которого не видно человеку: заполнено — почти наверняка бот.
        # Отвечаем успехом, чтобы он не подбирал обход, но ничего не отправляем.
        if _clean(data.get("hp"), 100):
            return self._reply(200, {"ok": True})

        tel = _one_line(data.get("tel"), 60)
        if len(re.sub(r"\D", "", tel)) < 6:
            return self._reply(400, {"ok": False, "error": "Укажите телефон для связи."})

        name = _one_line(data.get("name"), 120)
        task = _clean(data.get("task"))

        # Лимит считается только по реальным отправкам: иначе несколько опечаток
        # в телефоне заблокировали бы живого человека. Поток запросов режет nginx.
        ip = self.headers.get("X-Real-IP") or self.client_address[0]
        if not _rate_ok(ip):
            return self._reply(429, {"ok": False, "error": "Слишком много заявок. Позвоните нам."})

        try:
            send_mail(name, tel, task)
        except Exception as err:
            # Текст ошибки — в лог, наружу только общая фраза: она может
            # содержать адреса и детали SMTP.
            print(f"[form] ошибка отправки: {type(err).__name__}: {err}", file=sys.stderr, flush=True)
            return self._reply(502, {"ok": False, "error": "Не удалось отправить. Позвоните нам."})

        print(f"[form] заявка принята: {tel}", flush=True)
        return self._reply(200, {"ok": True})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    problem = check_credentials()
    if problem:
        print(f"ВНИМАНИЕ: {problem} — отправка работать не будет", file=sys.stderr, flush=True)
    print(f"[form] слушаю {HOST}:{PORT}, письма на {MAIL_TO}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
