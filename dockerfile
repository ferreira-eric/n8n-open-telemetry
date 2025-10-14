FROM n8nio/n8n:latest

USER root

RUN apk add --no-cache curl gettext coreutils openssl ca-certificates musl-dev

# Atualiza npm (suporte a pacotes modernos)
RUN npm install -g npm@11.6.1

# Isola o ambiente do OpenTelemetry
WORKDIR /otel

# Instala dependências OpenTelemetry compatíveis
RUN npm install -g --legacy-peer-deps \
    @opentelemetry/api@1.6.0 \
    @opentelemetry/sdk-node@0.43.0 \
    @opentelemetry/auto-instrumentations-node@0.38.0 \
    @opentelemetry/exporter-trace-otlp-http@0.43.0 \
    @opentelemetry/exporter-logs-otlp-http@0.43.0 \
    @opentelemetry/resources@1.6.0 \
    @opentelemetry/semantic-conventions@1.6.0 \
    @opentelemetry/instrumentation@0.43.0 \
    @opentelemetry/instrumentation-winston@0.43.0 \
    @opentelemetry/winston-transport@0.10.0 \
    winston@3.9.0 \
    flat

COPY tracing.js n8n-otel-instrumentation.js /otel/
COPY docker-entrypoint.sh /docker-entrypoint.sh

RUN chmod +x /docker-entrypoint.sh && chown node:node /docker-entrypoint.sh

USER node

ENTRYPOINT ["tini", "--", "/docker-entrypoint.sh"]
