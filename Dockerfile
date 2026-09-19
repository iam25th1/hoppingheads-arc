FROM node:20-slim

WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --ignore-scripts

COPY client ./client
COPY shared ./shared
COPY server ./server

EXPOSE 3000

USER node

CMD ["node", "server/src/index.js"]
