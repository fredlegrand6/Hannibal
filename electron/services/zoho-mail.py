#!/usr/bin/env python3
"""Hannibal works Fred's Zoho inbox: triage, reply, write, mark read.

  zoho-mail.py triage [days=3] [limit=20]   unread mail with a short preview
  zoho-mail.py reply                         stdin {uid, to, body}  → sends a threaded reply
  zoho-mail.py write                         stdin {to, subject, body} → sends a new mail
  zoho-mail.py seen <uid>                    mark one message read

Env: ZOHO_EMAIL, ZOHO_APP_PW, ZOHO_IMAP_HOST (imap.zoho.eu), ZOHO_SMTP_HOST
(smtp.zoho.eu), ZOHO_FROM_NAME (Fred Legrand), ZOHO_SIGNATURE (optional).
Prints one JSON line; {"error": "..."} with a non-zero exit. Stdlib only.

Sending is only ever reached through Hannibal's confirmation gate (Fred says
yes by voice or taps Yes on his phone). A reply goes ONLY to the address in
`to`, and only if that is the original sender (Reply-To or From): what Fred
approved is exactly who gets it.
"""
import os, sys, json, re, imaplib, smtplib, ssl, time, email
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.utils import parseaddr, parsedate_to_datetime, formataddr, make_msgid, formatdate, getaddresses
from datetime import datetime, timedelta

IMAP_HOST = os.environ.get("ZOHO_IMAP_HOST", "imap.zoho.eu")
SMTP_HOST = os.environ.get("ZOHO_SMTP_HOST", "smtp.zoho.eu")
USER = os.environ.get("ZOHO_EMAIL", "")
PW = os.environ.get("ZOHO_APP_PW", "")
FROM_NAME = os.environ.get("ZOHO_FROM_NAME", "Fred Legrand")
SIGNATURE = os.environ.get("ZOHO_SIGNATURE", "").replace("\\n", "\n")


def out(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(code)


def dec(s):
    if not s:
        return ""
    try:
        return str(make_header(decode_header(s)))
    except Exception:
        return s


def text_of(msg):
    """Best plain-text body (HTML stripped as a fallback)."""
    plain = html = None
    parts = msg.walk() if msg.is_multipart() else [msg]
    for part in parts:
        if part.is_multipart() or "attachment" in str(part.get("Content-Disposition", "")):
            continue
        payload = part.get_payload(decode=True)
        if not payload:
            continue
        try:
            t = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        except Exception:
            t = payload.decode("utf-8", errors="replace")
        ct = part.get_content_type()
        if ct == "text/plain" and plain is None:
            plain = t
        elif ct == "text/html" and html is None:
            html = t
    if plain is not None:
        return plain.strip()
    if html is not None:
        t = re.sub(r"(?is)<(script|style).*?</\1>", " ", html)
        t = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|li|h[1-6])>", "\n", t)
        t = re.sub(r"<[^>]+>", " ", t)
        for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&nbsp;", " "), ("&quot;", '"'), ("&#39;", "'")):
            t = t.replace(a, b)
        t = re.sub(r"[ \t]+", " ", t)
        return re.sub(r"\n\s*\n+", "\n\n", t).strip()
    return ""


def preview(body, n=300):
    """The new part of a mail: drop quoted history and signatures-ish tails."""
    lines = []
    for ln in body.splitlines():
        s = ln.strip()
        if s.startswith(">"):
            continue
        if re.match(r"^(On .+wrote:|Op .+schreef.*:|Le .+a écrit\s*:|El .+escribió:|-----\s*Original Message|From: .+)$", s, re.I):
            break
        lines.append(s)
    t = re.sub(r"\s+", " ", " ".join(lines)).strip()
    return t[:n] + ("…" if len(t) > n else "")


def reply_target(msg):
    """Who a reply goes to: Reply-To if set, else From."""
    rt = getaddresses([msg.get("Reply-To", "")])
    addr = next((a for _, a in rt if a), "") or parseaddr(msg.get("From", ""))[1]
    return addr.strip().lower()


def build_reply(orig, body, from_addr, from_name=FROM_NAME, signature=SIGNATURE):
    """A reply that threads in every mail client (In-Reply-To + References)."""
    subj = dec(orig.get("Subject", "")).strip()
    if not re.match(r"^(re|aw|antw)\s*:", subj, re.I):
        subj = "Re: " + subj if subj else "Re:"
    m = EmailMessage()
    m["From"] = formataddr((from_name, from_addr))
    m["To"] = reply_target(orig)
    m["Subject"] = subj
    m["Date"] = formatdate(localtime=True)
    m["Message-ID"] = make_msgid(domain=from_addr.split("@")[-1] if "@" in from_addr else None)
    mid = (orig.get("Message-ID") or "").strip()
    if mid:
        m["In-Reply-To"] = mid
        refs = (orig.get("References") or "").split()
        m["References"] = " ".join(refs + [mid]) if mid not in refs else " ".join(refs)
    when = ""
    try:
        when = parsedate_to_datetime(orig.get("Date", "")).strftime("%d %b %Y %H:%M")
    except Exception:
        pass
    who = dec(parseaddr(orig.get("From", ""))[0]) or parseaddr(orig.get("From", ""))[1]
    quoted = "\n".join("> " + ln for ln in text_of(orig).splitlines()[:60])
    text = body.rstrip() + ("\n\n" + signature if signature else "") + f"\n\nOn {when}, {who} wrote:\n{quoted}\n"
    m.set_content(text)
    return m


def build_new(to, subject, body, from_addr, from_name=FROM_NAME, signature=SIGNATURE):
    m = EmailMessage()
    m["From"] = formataddr((from_name, from_addr))
    m["To"] = to
    m["Subject"] = subject or ""
    m["Date"] = formatdate(localtime=True)
    m["Message-ID"] = make_msgid(domain=from_addr.split("@")[-1] if "@" in from_addr else None)
    m.set_content(body.rstrip() + ("\n\n" + signature if signature else "") + "\n")
    return m


VALID_ADDR = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")


def imap():
    M = imaplib.IMAP4_SSL(IMAP_HOST, 993)
    M.login(USER, PW)
    return M


def fetch(M, uid):
    typ, data = M.uid("FETCH", str(uid), "(BODY.PEEK[])")
    raw = b"".join(p[1] for p in (data or []) if isinstance(p, tuple) and len(p) > 1 and p[1])
    if typ != "OK" or not raw:
        raise RuntimeError(f"message {uid} not found")
    return email.message_from_bytes(raw)


def sent_folder(M):
    typ, boxes = M.list()
    for b in boxes or []:
        s = b.decode(errors="replace")
        if "\\Sent" in s:
            return s.split(' "/" ')[-1].strip().strip('"')
    return "Sent"


def send(M, msg):
    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL(SMTP_HOST, 465, context=ctx, timeout=30) as s:
        s.login(USER, PW)
        s.send_message(msg)
    try:   # keep a copy in Sent, like any mail client
        M.append(sent_folder(M), "\\Seen", imaplib.Time2Internaldate(time.time()), msg.as_bytes())
    except Exception:
        pass


def cmd_triage(days, limit):
    M = imap()
    M.select("INBOX", readonly=True)
    since = (datetime.now() - timedelta(days=days)).strftime("%d-%b-%Y")
    typ, data = M.uid("SEARCH", None, "UNSEEN", "SINCE", since)
    uids = (data[0].split() if data and data[0] else [])[::-1]
    typ, alld = M.uid("SEARCH", None, "UNSEEN")
    total = len(alld[0].split()) if alld and alld[0] else 0
    items = []
    for u in uids[:limit]:
        m = fetch(M, u.decode())
        name, addr = parseaddr(m.get("From", ""))
        date = ""
        try:
            date = parsedate_to_datetime(m.get("Date", "")).astimezone().strftime("%a %d %b %H:%M")
        except Exception:
            pass
        to_me = USER.lower() in (m.get("To", "") or "").lower()
        items.append({"uid": u.decode(), "from": dec(name) or addr, "from_email": reply_target(m),
                      "subject": dec(m.get("Subject", "")) or "(no subject)", "date": date,
                      "to_me_directly": to_me, "newsletter": bool(m.get("List-Unsubscribe") or m.get("List-Id")),
                      "preview": preview(text_of(m))})
    M.logout()
    return {"ok": True, "unread_total": total, "days": days, "messages": items}


def cmd_reply(req):
    uid, to, body = str(req.get("uid") or ""), str(req.get("to") or "").strip().lower(), str(req.get("body") or "")
    if not uid or not body.strip():
        raise ValueError("need uid and body")
    M = imap()
    M.select("INBOX")
    orig = fetch(M, uid)
    target = reply_target(orig)
    if not to or to != target:
        raise ValueError(f"reply would go to {target}, not {to or '(nobody)'} — not sent")
    msg = build_reply(orig, body, USER)
    send(M, msg)
    try:
        M.uid("STORE", uid, "+FLAGS", "(\\Answered \\Seen)")
    except Exception:
        pass
    M.logout()
    return {"ok": True, "sent_to": target, "subject": msg["Subject"]}


def cmd_write(req):
    to, subject, body = str(req.get("to") or "").strip(), str(req.get("subject") or ""), str(req.get("body") or "")
    if not VALID_ADDR.match(to):
        raise ValueError(f"not one valid email address: {to!r}")
    if not body.strip():
        raise ValueError("empty body")
    M = imap()
    msg = build_new(to, subject, body, USER)
    send(M, msg)
    M.logout()
    return {"ok": True, "sent_to": to, "subject": subject}


def cmd_seen(uid):
    M = imap()
    M.select("INBOX")
    M.uid("STORE", str(uid), "+FLAGS", "(\\Seen)")
    M.logout()
    return {"ok": True}


if __name__ == "__main__":
    if not USER or not PW:
        out({"error": "ZOHO_EMAIL or ZOHO_APP_PW not set"}, 1)
    a = sys.argv[1:] or ["triage"]
    try:
        if a[0] == "triage":
            out(cmd_triage(int(a[1]) if len(a) > 1 else 3, int(a[2]) if len(a) > 2 else 20))
        elif a[0] in ("reply", "write"):
            req = json.loads(sys.stdin.read() or "{}")
            out(cmd_reply(req) if a[0] == "reply" else cmd_write(req))
        elif a[0] == "seen" and len(a) > 1:
            out(cmd_seen(a[1]))
        else:
            out({"error": "usage: zoho-mail.py triage|reply|write|seen"}, 1)
    except Exception as e:
        out({"error": str(e)}, 1)
