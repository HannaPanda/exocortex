# Addresses of the harness stack (issue #166). Sourced by the shell scripts and
# mirrored in lib/config.mjs; change both together.
#
# Every port is outside what the deployment (3210-3212, 5433, 6380, 9110) and
# the integration stack (5435, 6382) use, so a URL pointing at the wrong one is
# visible at a glance and no harness process can ever answer for production.
#
# The control origin lives on a different loopback address on purpose: Firefox
# counts several of its limits per host, and the question the harness asks is
# whether an *unrelated* host stops getting WebSockets.
HARNESS_HOST=127.0.0.1
HARNESS_PROXY_PORT=4310
HARNESS_API_PORT=4311
HARNESS_COLLAB_PORT=4312
HARNESS_WEB_PORT=4313
HARNESS_CONTROL_HOST=127.0.0.2
HARNESS_CONTROL_PORT=4320
HARNESS_PG_PORT=5437
HARNESS_REDIS_PORT=6384
HARNESS_ORIGIN="http://$HARNESS_HOST:$HARNESS_PROXY_PORT"
HARNESS_TMP_NEXT_ENV="${TMPDIR:-/tmp}/exocortex-harness-next-env.d.ts"
export HARNESS_HOST HARNESS_PROXY_PORT HARNESS_API_PORT HARNESS_COLLAB_PORT HARNESS_WEB_PORT \
  HARNESS_CONTROL_HOST HARNESS_CONTROL_PORT HARNESS_PG_PORT HARNESS_REDIS_PORT HARNESS_ORIGIN
