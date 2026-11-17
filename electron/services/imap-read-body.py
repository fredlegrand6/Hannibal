#!/usr/bin/env python3
"""Fetch the full text body of a specific email by IMAP UID.

Usage: python3 imap-read-body.py <uid>

Reads creds from the environment (same as imap-mail.py):
  ZOHO_IMAP_HOST, ZOHO_EMAIL, ZOHO_APP_PW
Prints one JSON line: {"from": <display name>, "from_email": <address>, "subject": ..., "date": ..., "body": "..."}
or {"error": "..."} with a non-zero exit.
Uses a UID (stable, unlike a sequence number) and BODY.PEEK so the message
stays unread.
"""
import os, sys, json, imaplib, email
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime

HOST = os.environ.get("ZOHO_IMAP_HOST", "imap.zoho.eu")
USER = os.environ.get("ZOHO_EMAIL", "")
PW   = os.environ.get("ZOHO_APP_PW", "")


def out(obj, code=0):
    print(json.dumps(obj))
    sys.exit(code)


def dec(s):
    if not s:
        return ""
    try:
        return str(make_header(decode_header(s)))
    except Exception:
        return s


def extract_text(msg):
    """Walk the MIME tree and return the best plain-text body."""
    # Try plain text first, fall back to HTML stripped of tags
    plain = None
    html = None
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            disp = str(part.get("Content-Disposition", ""))
            if "attachment" in disp:
                continue
            payload = part.get_payload(decode=True)
            if not payload:
                continue
            charset = part.get_content_charset() or "utf-8"
            try:
                text = payload.decode(charset, errors="replace")
            except Exception:
                text = payload.decode("utf-8", errors="replace")
            if ct == "text/plain" and not plain:
                plain = text
            elif ct == "text/html" and not html:
                html = text
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or "utf-8"
            try:
                text = payload.decode(charset, errors="replace")
            except Exception:
                text = payload.decode("utf-8", errors="replace")
            if msg.get_content_type() == "text/html":
                html = text
            else:
                plain = text

    if plain:
        return plain.strip()

    if html:
        import re
        # Basic HTML → text: strip tags, decode common entities
        text = re.sub(r"<br\s*/?>", "\n", html, flags=re.I)
        text = re.sub(r"</(p|div|tr|li|h[1-6])>", "\n", text, flags=re.I)
        text = re.sub(r"<[^>]+>", " ", text)
        text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        text = text.replace("&nbsp;", " ").replace("&quot;", '"').replace("&#39;", "'")
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n\s*\n\s*\n", "\n\n", text)
        return text.strip()

    return "(no readable body)"


if len(sys.argv) < 2:
    out({"error": "Usage: imap-read-body.py <uid>"}, 1)

if not USER or not PW:
    out({"error": "ZOHO_EMAIL or ZOHO_APP_PW not set"}, 1)

uid = sys.argv[1]

try:
    M = imaplib.IMAP4_SSL(HOST, 993)
    M.login(USER, PW)
    M.select("INBOX", readonly=True)

    # Fetch full message by UID using BODY.PEEK (no side effects)
    typ, data = M.uid("FETCH", uid, "(BODY.PEEK[])")
    if typ != "OK" or not data or not data[0]:
        M.logout()
        out({"error": f"Could not fetch message uid {uid}"}, 1)

    raw = b""
    for part in data:
        if isinstance(part, tuple) and len(part) > 1:
            raw = part[1] or b""
    if not raw:
        M.logout()
        out({"error": "Empty message body"}, 1)

    msg = email.message_from_bytes(raw)
    name, addr = parseaddr(msg.get("From", ""))
    frm = dec(name) or addr or "(unknown)"
    from_email = addr or ""
    subj = dec(msg.get("Subject", "")) or "(no subject)"
    date_str = ""
    try:
        dt = parsedate_to_datetime(msg.get("Date", ""))
        if dt:
            date_str = dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        pass

    body = extract_text(msg)
    # Truncate very long emails to keep LLM context manageable
    if len(body) > 4000:
        body = body[:4000] + "\n\n[... truncated ...]"

    M.logout()
    out({"from": frm, "from_email": from_email, "subject": subj, "date": date_str, "body": body})

except imaplib.IMAP4.error as e:
    out({"error": "IMAP error: " + str(e)}, 1)
except Exception as e:
    out({"error": str(e)}, 1)
