#!/usr/bin/env bash
# Receive-only external mail (Postfix) for the correspondence system.
#
#   sudo bash /opt/correspondence/deploy/scripts/install-mail.sh
#
# Needs EXTERNAL_MAIL_DOMAIN (and the web DOMAIN) in
# /etc/correspondence/correspondence.env, the MX record of that domain
# pointing to this server, and the TLS certificate of the web host.
#
# SHARED SERVER: refuses to run if another mail server owns port 25 or if an
# existing Postfix configuration is not ours; touches no firewall rule
# (prints the command instead); sends no mail (outbound uses Brevo's API).
set -euo pipefail
APP=/opt/correspondence
ENV_FILE=/etc/correspondence/correspondence.env
MAP_DIR=/var/lib/correspondence-mail
MARKER="CORRESPONDENCE-RECEIVE-ONLY"
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
set -a; . "$ENV_FILE"; set +a
: "${EXTERNAL_MAIL_DOMAIN:?set EXTERNAL_MAIL_DOMAIN in $ENV_FILE}"
MAIL_HOST="${MAIL_HOST:-${ALLOWED_HOSTS%%,*}}"
CERT="/etc/letsencrypt/live/${MAIL_HOST}/fullchain.pem"
installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "install ok installed"; }

echo "== 0. refuse to clash with an existing mail setup"
if ss -ltnpH 2>/dev/null | grep -E ':25\b' | grep -vq master; then
    echo "   Port 25 is used by another program (not Postfix) - stop."; ss -ltnp | grep ':25 '; exit 1
fi
if [ -f /etc/postfix/main.cf ] && ! grep -q "$MARKER" /etc/postfix/main.cf; then
    echo "   /etc/postfix/main.cf exists and was not written by this script - refusing to overwrite another mail setup."
    exit 1
fi
[ -f "$CERT" ] || { echo "   missing TLS certificate $CERT (set MAIL_HOST to the host the MX points to)"; exit 1; }

echo "== 1. packages (only what is missing)"
need=()
installed postfix || need+=(postfix)
installed postfix-policyd-spf-python || need+=(postfix-policyd-spf-python)
if [ ${#need[@]} -gt 0 ]; then
    # "No configuration": we write main.cf ourselves.
    echo "postfix postfix/main_mailer_type select No configuration" | debconf-set-selections
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-upgrade "${need[@]}"
fi

echo "== 2. configuration (receive-only for ${EXTERNAL_MAIL_DOMAIN})"
sed -e "s/__MAIL_DOMAIN__/${EXTERNAL_MAIL_DOMAIN}/g" -e "s/__MAIL_HOST__/${MAIL_HOST}/g" \
    "$APP/deploy/postfix/main.cf.template" > /etc/postfix/main.cf
grep -q "^corrmail " /etc/postfix/master.cf || cat "$APP/deploy/postfix/master.cf.append" >> /etc/postfix/master.cf
echo "${EXTERNAL_MAIL_DOMAIN} corrmail:" > /etc/postfix/corr_transport
postmap /etc/postfix/corr_transport
chmod 0755 "$APP/deploy/scripts/mail-ingest.sh"

echo "== 3. recipient map (refreshed every 2 minutes)"
install -d -o correspondence -g correspondence -m 0755 "$MAP_DIR"
install -m 0644 "$APP"/deploy/systemd/correspondence-mailmap.* /etc/systemd/system/
systemctl daemon-reload
systemctl start correspondence-mailmap.service
systemctl enable --now correspondence-mailmap.timer

echo "== 4. certificate renewals reload Postfix too"
install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload postfix 2>/dev/null || true\n' > /etc/letsencrypt/renewal-hooks/deploy/corr-postfix.sh
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/corr-postfix.sh

echo "== 5. start"
postfix check
systemctl enable postfix
systemctl restart postfix
ss -ltn | grep -q ':25 ' && echo "Postfix is listening on port 25."

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active" && ! ufw status | grep -qE '^25(/tcp)?\s+ALLOW'; then
    echo
    echo "ufw is active and port 25 is not open. To receive mail run:  ufw allow 25/tcp"
fi
echo "Also make sure the provider firewall (Hostinger panel) allows inbound TCP 25."
echo "Test: send an e-mail from Gmail to <username>@${EXTERNAL_MAIL_DOMAIN}; see: journalctl -u postfix -f"
