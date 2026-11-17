#!/usr/bin/env python3
"""Fetch Zoho inbox summary over IMAP for Hannibal's Mail panel.

Reads creds from the environment (set by electron/main.js):
  ZOHO_IMAP_HOST (default imap.zoho.eu), ZOHO_EMAIL, ZOHO_APP_PW, MAIL_COUNT (default 5)
Prints one JSON line: {"unread": N, "messages": [{from, subject, time, unread}, ...]}
or {"error": "..."} with a non-zero exit. Uses only the stdlib (imaplib/email) —
no dependencies. BODY.PEEK keeps messages unread (no \\Seen side effect).
"""
import os, sys, json, imaplib, email
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime
from datetime import datetime

HOST = os.environ.get("ZOHO_IMAP_HOST", "imap.zoho.eu")
USER = os.environ.get("ZOHO_EMAIL", "")
PW   = os.environ.get("ZOHO_APP_PW", "")
N    = int(os.environ.get("MAIL_COUNT", "5"))


def out(obj, code=0):
    print(json.dumps(obj))
    sys.exit(code)


def dec(s):
    """Decode a possibly MIME-encoded (=?UTF-8?…?=) header to plain text."""
    if not s:
        return ""
    try:
        return str(make_header(decode_header(s)))
    except Exception:
        return s


if not USER or not PW:
    out({"error": "ZOHO_EMAIL or ZOHO_APP_PW not set"}, 1)

try:
    M = imaplib.IMAP4_SSL(HOST, 993)
    M.login(USER, PW)
    M.select("INBOX", readonly=True)

    # Work in UIDs, not sequence numbers: a UID is stable for the life of the
    # mailbox, so the id the panel hands back on click still points at the same
    # message even if mail arrived or was deleted in between. UID SEARCH returns
    # UIDs in ascending (arrival) order, so the newest N are still the tail.
    typ, data = M.uid("SEARCH", None, "UNSEEN")
    unseen_list = data[0].split() if data and data[0] else []
    unseen = set(unseen_list)

    typ, data = M.uid("SEARCH", None, "ALL")
    ids = data[0].split() if data and data[0] else []

    # Show the N newest messages by arrival (read + unread) so the panel reflects
    # recent activity, not stale unread mail. Unread ones get flagged below for the
    # gold border; the badge still counts *all* unread, not just what's shown.
    recent = ids[-N:][::-1]

    messages = []
    for i in recent:
        typ, d = M.uid("FETCH", i, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
        hdr = b""
        for part in d:
            if isinstance(part, tuple) and len(part) > 1:
                hdr = part[1] or b""
        msg = email.message_from_bytes(hdr)
        name, addr = parseaddr(msg.get("From", ""))
        frm = dec(name) or addr or "(unknown)"
        subj = dec(msg.get("Subject", "")) or "(no subject)"
        time = ""
        try:
            dt = parsedate_to_datetime(msg.get("Date", ""))
            if dt:
                local = dt.astimezone()
                now = datetime.now(local.tzinfo)
                time = local.strftime("%H:%M") if local.date() == now.date() else local.strftime("%d %b")
        except Exception:
            pass
        messages.append({"from": frm, "subject": subj, "time": time, "unread": i in unseen, "uid": i.decode() if isinstance(i, bytes) else str(i)})

    M.logout()
    out({"unread": len(unseen), "messages": messages})
except imaplib.IMAP4.error as e:
    out({"error": "IMAP login/select failed: " + str(e)}, 1)
except Exception as e:
    out({"error": str(e)}, 1)
