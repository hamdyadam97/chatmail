"""Postfix pipe target: read ONE message on stdin and deliver it.

    master.cf:  corrmail unix - n n - - pipe flags=Rq user=correspondence
                  argv=/opt/correspondence/deploy/scripts/mail-ingest.sh ${recipient} ${sender}

Exit codes follow sysexits(3) so Postfix does the right thing: 0 delivered,
67 unknown user (bounce), 75 temporary failure (queue and retry), 65 bad data.
Nothing about the content is printed or logged.
"""
import sys

from django.core.management.base import BaseCommand
from rest_framework.exceptions import ValidationError

from apps.external_mail import services

EX_OK, EX_DATAERR, EX_NOUSER, EX_TEMPFAIL = 0, 65, 67, 75


class Command(BaseCommand):
    help = "Deliver one inbound e-mail from stdin (called by Postfix)."

    def add_arguments(self, parser):
        parser.add_argument("--recipient", required=True)
        parser.add_argument("--sender", default="")

    def handle(self, *args, recipient, sender, **options):
        raw = sys.stdin.buffer.read()
        try:
            services.ingest(raw, recipient=recipient, sender=sender)
        except services.UnknownRecipient:
            sys.exit(EX_NOUSER)
        except services.TemporaryFailure:
            sys.exit(EX_TEMPFAIL)
        except ValidationError:
            sys.exit(EX_DATAERR)
        except Exception:  # database down etc.: let Postfix retry
            sys.exit(EX_TEMPFAIL)
        sys.exit(EX_OK)
