FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --ingroup nodejs appuser \
  && chown -R appuser:nodejs /app

USER appuser

EXPOSE 4000

CMD ["node", "server.js"]
