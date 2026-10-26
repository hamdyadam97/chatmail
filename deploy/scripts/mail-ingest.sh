#!/bin/sh
# Postfix pipe target (runs as the service account): one message on stdin.
# The exit code is the sysexits(3) code from Django: 0 delivered, 67 unknown
# user (bounce), 75 retry later. Nothing about the content is printed.
set -a
. /etc/correspondence/correspondence.env
set +a
cd /opt/correspondence/backend || exit 75
exec /opt/correspondence/.venv/bin/python manage.py ingest_external_mail --recipient "$1" --sender "$2"
