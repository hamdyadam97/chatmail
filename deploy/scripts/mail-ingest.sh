#!/bin/sh
# Postfix pipe target (runs as the service account): one message on stdin.
# The exit code is the sysexits(3) code from Django: 0 delivered, 65 bad data
# and 67 unknown user (bounce), 75 retry later. Nothing about the content is
# printed.
#
# Any OTHER outcome — a broken env file, Python failing to start, a
# half-finished deploy (code pulled before the libraries are installed), the
# database restarting — is mapped to 75 so Postfix keeps the message and
# retries for days. A permanent failure there makes the sender's provider
# (e.g. Brevo) block the address after a single hard bounce, silently
# dropping every later message (seen 2026-11-11).
(
  set -a
  . /etc/correspondence/correspondence.env
  set +a
  cd /opt/correspondence/backend || exit 75
  exec /opt/correspondence/.venv/bin/python manage.py ingest_external_mail --recipient "$1" --sender "$2"
)
rc=$?
case "$rc" in
  0|65|67|75) exit "$rc" ;;
  *) echo "ingest: unexpected exit status $rc, will retry" >&2; exit 75 ;;
esac
