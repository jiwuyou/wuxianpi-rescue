FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY plugins ./plugins
COPY public/site ./public/site
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=20877 \
    DATABASE_PATH=/data/comments.db
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 20877
VOLUME ["/data"]
CMD ["node", "dist/server.js"]
