FROM node:25-alpine
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node backend ./backend
COPY --chown=node:node frontend ./frontend
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 DATA_DIR=/app/data
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/readiness').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "backend/server.mjs"]
