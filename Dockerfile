FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY backend ./backend
COPY frontend ./frontend
COPY scripts ./scripts
COPY README.md ./

RUN npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173

EXPOSE 4173
CMD ["node", "backend/server.mjs"]
