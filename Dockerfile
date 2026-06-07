ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base-debian:bookworm
FROM ${BUILD_FROM}

# Node.js 22 (LTS) + jq for options.json parsing in the run script
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg jq \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --production

COPY src/ ./src/
COPY prompts/ ./prompts/
COPY standing-orders/ ./standing-orders/
COPY memory/ ./memory/

COPY rootfs /

LABEL \
    io.hass.name="BZ-V2 Home Guardian" \
    io.hass.description="Always-on home guardian (Claude + ACP) over Telegram" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}" \
    org.opencontainers.image.title="BZ-V2 Home Guardian" \
    org.opencontainers.image.description="Standalone Claude+ACP guardian, replaces Mac-hosted BeZa" \
    org.opencontainers.image.source="https://github.com/bernardlim/beza-home-bot" \
    org.opencontainers.image.licenses="MIT"
