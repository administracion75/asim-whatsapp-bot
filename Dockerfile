FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY novedades.txt ./novedades.txt

RUN mkdir -p /app/auth_info /app/data

CMD ["node", "src/index.js"]
