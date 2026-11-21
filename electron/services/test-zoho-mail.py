# python3 electron/services/test-zoho-mail.py
import importlib.util, email, os, sys
spec = importlib.util.spec_from_file_location("zm", os.path.join(os.path.dirname(__file__), "zoho-mail.py"))
zm = importlib.util.module_from_spec(spec); spec.loader.exec_module(zm)
n = 0
def t(name, cond):
    global n
    assert cond, name; n += 1; print("✓", name)

orig = email.message_from_string(
    "From: Jan de Vries <jan@hts.nl>\nReply-To: Jan <jan.devries@hts.nl>\nTo: fred@revalisgroup.com\n"
    "Subject: Contract HTS\nMessage-ID: <abc@hts.nl>\nReferences: <x1@hts.nl>\nDate: Fri, 20 Nov 2026 10:00:00 +0100\n\n"
    "Hi Fred,\nCan we sign Monday?\n\nOp do 19 nov schreef Fred:\n> old stuff\n")
r = zm.build_reply(orig, "Monday works. Fred", "fred@revalisgroup.com", signature="")
t("reply goes to Reply-To", r["To"] == "jan.devries@hts.nl")
t("subject gets Re:", r["Subject"] == "Re: Contract HTS")
t("threads: In-Reply-To + References", r["In-Reply-To"] == "<abc@hts.nl>" and r["References"] == "<x1@hts.nl> <abc@hts.nl>")
t("quotes the original", "> Can we sign Monday?" in r.get_content())
t("no double Re:", zm.build_reply(email.message_from_string("From: a@b.nl\nSubject: RE: x\n\nhi"), "ok", "f@r.com")["Subject"] == "RE: x")
t("preview drops quoted history", zm.preview(zm.text_of(orig)) == "Hi Fred, Can we sign Monday?")
t("html mail becomes text", zm.text_of(email.message_from_string("Content-Type: text/html\n\n<p>Hello<br>there</p><style>x{}</style>")) == "Hello\nthere")
t("one address only for a new mail", zm.VALID_ADDR.match("a@b.nl") and not zm.VALID_ADDR.match("a@b.nl, c@d.nl"))
os.environ.pop("ZOHO_EMAIL", None)
try:
    zm.cmd_reply({"uid": "", "to": "x", "body": ""}); ok = False
except ValueError:
    ok = True
t("reply needs uid and body", ok)
H = lambda txt: email.message_from_string(txt + "\n\nbody")
t("a person's mail is not bulk", not zm.is_bulk(H("From: Jean-marc Langerak <jmlangerak@revalisgroup.com>\nReturn-Path: <jmlangerak@revalisgroup.com>\nX-Mailer: Zoho Mail")))
t("SES/Stripe/SendGrid mail is bulk", zm.is_bulk(H("From: Link <notifications@email.link.com>\nFeedback-ID: 1\nX-SES-Outgoing: x")))
t("a bounce address means a robot", zm.is_bulk(H("From: Peter Balaji <peterbalaji@eu.zohocorp.com>\nReturn-Path: <bounces+fc74@x.com>")))
t("robot senders: wordpress@, billing@, noreply@", all(zm.is_bulk(H(f"From: X <{a}>")) for a in ("wordpress@autoupdate.siteground.com", "billing@revalisgroup.com", "noreply@zoho.eu")))
print(f"{n} passed")
