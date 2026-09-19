FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .

EXPOSE 3000

USER node

CMD ["node", "src/index.js"]
