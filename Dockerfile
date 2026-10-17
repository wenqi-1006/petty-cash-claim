# Serves the claim form as a static site on Railway.
FROM caddy:2.8.4-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY petty-cash-claim.html /srv/index.html
