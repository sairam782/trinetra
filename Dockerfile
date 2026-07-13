FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY backend ./backend
COPY frontend ./frontend
COPY scripts ./scripts
COPY README.md ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173

EXPOSE 4173
CMD ["node", "server.mjs"]
