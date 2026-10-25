#!/bin/sh
set -eu
# Run from the dedicated service directory only, after verifying the graph manifest.
ROOT=/srv/planificator-routing
[ -s "$ROOT/france-graph/properties" ] || { echo 'Verified France graph required' >&2; exit 1; }
[ -s "$ROOT/graphhopper-web-11.1.jar" ] || exit 1
[ -s "$ROOT/runtime.yml" ] || exit 1
# No PBF mount: a missing graph cannot silently start a national import.
exec docker run -d --name planificator-routing-engine --restart unless-stopped \
 --memory 3584m --memory-swap 3584m --cpus 1.5 --pids-limit 128 \
 --cap-drop ALL --security-opt no-new-privileges --read-only --user 65534:65534 \
 --tmpfs /tmp:rw,noexec,nosuid,size=64m \
 --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
 -p 127.0.0.1:8989:8989 \
 -v "$ROOT/france-graph:/data/france-graph:rw" \
 -v "$ROOT/graphhopper-web-11.1.jar:/data/graphhopper.jar:ro" \
 -v "$ROOT/runtime.yml:/data/runtime.yml:ro" \
 -w /data \
 eclipse-temurin:21-jre@sha256:227118764cccd3c3294617061aaa93a08309c63a395eefa83e6b35032992ea99 \
 java -Xms256m -Xmx2g -XX:+UseParallelGC -jar graphhopper.jar server runtime.yml
