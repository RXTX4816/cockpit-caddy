#!/usr/bin/env bash
# Runs as root on the test VM (see apply.sh): content, demo backends, then the generated config.
set -euo pipefail
ts=$(date +%Y%m%d-%H%M%S)
tar czf /root/caddy-before-seed-$ts.tgz -C / etc/caddy
echo "backup: /root/caddy-before-seed-$ts.tgz"

# Content
mkdir -p /srv/seed/{b9001,b9002,auth,spa,files/docs,php}
echo '<h1>Backend 9001</h1>' > /srv/seed/b9001/index.html
echo '<h1>Backend 9002</h1>' > /srv/seed/b9002/index.html
echo 'ok' > /srv/seed/auth/index.html
cat > /srv/seed/spa/index.html <<'H'
<!doctype html><title>Seed SPA</title><h1>Seed SPA</h1><p>Path: <span id=p></span></p><script>p.textContent=location.pathname</script>
H
gzip -kf /srv/seed/spa/index.html
mkdir -p /srv/seed/b9002/api/private; echo "api ok (backend 9002)" > /srv/seed/b9002/api/x; echo "private (should never be served)" > /srv/seed/b9002/api/private/x
mkdir -p /srv/seed/spa/.git && echo secret > /srv/seed/spa/.git/config
echo 'readme' > /srv/seed/files/README.txt
echo 'notes'  > /srv/seed/files/docs/notes.md
echo '<?php phpinfo();' > /srv/seed/php/index.php
chmod -R a+rX /srv/seed

# Backends: 9001/9002 web, 9003 forward-auth (200 on /); 9009 stays dead on purpose
for p in 9001 9002 9003; do
  dir=/srv/seed/b$p; [ $p = 9003 ] && dir=/srv/seed/auth
  systemctl stop seed-backend-$p 2>/dev/null || true
  systemctl reset-failed seed-backend-$p 2>/dev/null || true
  systemd-run --quiet --unit seed-backend-$p python3 -m http.server $p --bind 127.0.0.1 --directory $dir
done

# Access log file Caddy can write
install -d -o caddy -g caddy /var/log/caddy
touch /var/log/caddy/seed-access.log && chown caddy:caddy /var/log/caddy/seed-access.log

# Config
install -m 644 /tmp/seed/Caddyfile /etc/caddy/Caddyfile
install -m 644 /tmp/seed/cockpit-caddy.conf /etc/caddy/conf.d/cockpit-caddy.conf
install -m 644 /tmp/seed/cockpit-caddy-snippets.conf /etc/caddy/conf.d/cockpit-caddy-snippets.conf
ls /etc/caddy/conf.d
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -2
chown -R caddy:caddy /var/lib/caddy /var/log/caddy 2>/dev/null || true
systemctl reload caddy && echo reloaded
