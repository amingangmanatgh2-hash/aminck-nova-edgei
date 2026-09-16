# Minecraft God Server — Paper runtime image.
#
# HONEST SCOPE: this image runs a real Paper server and reports its state to the
# Cloudflare platform over HTTP. Cloudflare Containers cannot expose TCP 25565 to
# the public internet (see docs/FEASIBILITY.md), so this image is meant to run
# wherever a TCP origin is allowed — a Cloudflare Container reached through the
# private-beta connect(socket) path, or any other host. It does not pretend to
# make players connect through Cloudflare.
FROM eclipse-temurin:21-jre-jammy

ARG PAPER_BUILD=1.21.1
ARG PAPER_JAR=paper-1.21.1.jar

# The low-resource preset is baked in; it is a SAFE STARTING POINT, not a
# benchmarked optimum. Profile before trusting any number.
COPY config/server.properties /server/server.properties
COPY config/paper-global.yml  /server/config/paper-global.yml
COPY config/spigot.yml        /server/config/spigot.yml
COPY plugin/                  /server/plugins-src/

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 mc \
    && mkdir -p /server/world /server/plugins /server/backups \
    && chown -R mc:mc /server

WORKDIR /server
USER mc

# Heap sized for a constrained runtime. 1.5G assumes ~2G available; on a smaller
# host this MUST be lowered or the container will be OOM-killed.
ENV JAVA_OPTS="-Xms1024M -Xmx1536M -XX:+UseG1GC -XX:MaxGCPauseMillis=120 \
  -XX:+ParallelRefProcEnabled -XX:+UnlockExperimentalVMOptions -XX:G1NewSizePercent=30 \
  -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 \
  -XX:G1HeapWastePercent=5 -XX:+AlwaysPreTouch -XX:+DisableExplicitGC"

# Platform bridge configuration, supplied at runtime as secrets/env.
ENV PLATFORM_URL="" \
    PLATFORM_SECRET="" \
    SERVER_ID="" \
    HEARTBEAT_SECONDS="15"

EXPOSE 25565

HEALTHCHECK --interval=20s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:25565 >/dev/null 2>&1 || \
      (pgrep -f paper.jar >/dev/null || exit 1)

ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar paper.jar --nogui"]
