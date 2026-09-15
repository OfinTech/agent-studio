FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
# Snapshot pins Poppler and its dependencies, from 2025-09-01.
RUN rm /etc/apt/sources.list.d/debian.sources && \
    echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20250901T000000Z bookworm main' > /etc/apt/sources.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl python3 python3-pil poppler-utils && \
    rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
RUN case "$TARGETARCH" in arm64) arch=aarch64; checksum=1f59f9fb8eb65e8ba18658fc9016767e7d3e12488ded8b8fffa34254e51ce42c ;; amd64) arch=x86_64; checksum=dfb82876f2986862996e564fa507a9e576e0c1e3bee63c2c1bd677c2543e6407 ;; *) exit 1 ;; esac && \
    curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-${arch}-unknown-linux-musl.tar.gz" -o /tmp/tectonic.tar.gz && \
    echo "$checksum  /tmp/tectonic.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/tectonic.tar.gz -C /usr/local/bin && rm /tmp/tectonic.tar.gz
ENV XDG_CACHE_HOME=/opt/tex-cache TECTONIC_UNTRUSTED_MODE=1 SOURCE_DATE_EPOCH=1788825600
COPY warmup.tex warmup.py /opt/
RUN mkdir -p /opt/tex-cache && python3 /opt/warmup.py && \
    chmod -R a+rX /opt/tex-cache && \
    test -f /opt/tex-cache/Tectonic/formats/6ffe055852f8faf66c0acbe1a7fb27f87b869a90bad1204f3bf4d9683f597c7c-latex-33.fmt && \
    rm /opt/warmup.* && useradd --uid 10001 --no-create-home compiler
COPY warmup-images.py /opt/
RUN cp -a /opt/tex-cache /opt/tex-cache-template && \
    XDG_CACHE_HOME=/opt/tex-cache-template python3 /opt/warmup-images.py && \
    chmod -R a+rX /opt/tex-cache-template && rm /opt/warmup-images.py
COPY server.py runner.py local-bridge.py /opt/
USER 10001:10001
EXPOSE 8080
CMD ["python3", "-B", "/opt/server.py"]
