# Mirage Cloud Panel sandbox template for OpenAI Codex.
# Build from the repository root (the panel is built from this checkout):
#   docker build -f docker/codex/Dockerfile -t mirage-cloud-panel/sandbox:codex .
FROM docker/sandbox-templates:codex

USER root
COPY docker/shared/install-build-tools.sh /tmp/install-build-tools.sh
RUN chmod +x /tmp/install-build-tools.sh && /tmp/install-build-tools.sh

COPY --chown=agent:agent . /opt/mirage-cloud-panel

USER agent
WORKDIR /opt/mirage-cloud-panel
# HUSKY=0: no git hooks inside the image.
RUN --mount=type=cache,target=/tmp/npm-cache,sharing=locked,mode=0777 \
    HUSKY=0 npm ci --include=dev --cache=/tmp/npm-cache --no-audit --no-fund && \
    npm run build && \
    npm prune --omit=dev --no-audit --no-fund

USER root
RUN ln -sf /opt/mirage-cloud-panel/dist-server/server/modules/cli/cli.js /usr/local/bin/mirage && \
    chmod +x /opt/mirage-cloud-panel/dist-server/server/modules/cli/cli.js

USER agent
WORKDIR /home/agent
RUN mirage --version

COPY --chown=agent:agent docker/shared/start-mirage.sh /home/agent/.mirage-start.sh
RUN echo '. ~/.mirage-start.sh' >> /home/agent/.bashrc
