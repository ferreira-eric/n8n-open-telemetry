# Estágio 1: Instalação de dependências do OpenTelemetry
FROM node:18-alpine AS builder

WORKDIR /otel

# Instala as dependências necessárias
RUN npm install -g --legacy-peer-deps \
    @opentelemetry/api@1.6.0 \
    @opentelemetry/sdk-node@0.43.0 \
    @opentelemetry/auto-instrumentations-node@0.38.0 \
    @opentelemetry/exporter-trace-otlp-http@0.43.0 \
    @opentelemetry/exporter-logs-otlp-http@0.43.0 \
    @opentelemetry/sdk-metrics@1.17.0 \
    @opentelemetry/exporter-metrics-otlp-http@0.43.0 \
    @opentelemetry/resources@1.6.0 \
    @opentelemetry/semantic-conventions@1.6.0 \
    @opentelemetry/instrumentation@0.43.0 \
    @opentelemetry/instrumentation-winston@0.43.0 \
    @opentelemetry/winston-transport@0.10.0 \
    winston@3.9.0 \
    flat

# Estágio 2: Imagem final do n8n
# ... (mantenha o estágio builder igual)

FROM n8nio/n8n:latest

USER root

# Copia os módulos para dentro da pasta /otel para isolamento
COPY --from=builder /usr/local/lib/node_modules /otel/node_modules

WORKDIR /otel
COPY tracing.js n8n-otel-instrumentation.js ./
COPY docker-entrypoint.sh /docker-entrypoint.sh

RUN sed -i 's/\r$//' /docker-entrypoint.sh && \
    chmod +x /docker-entrypoint.sh && \
    chown node:node /docker-entrypoint.sh

# Definir o NODE_PATH via variável de ambiente do sistema
ENV NODE_PATH=/otel/node_modules:/usr/local/lib/node_modules

USER node
ENTRYPOINT ["tini", "--", "/docker-entrypoint.sh"]